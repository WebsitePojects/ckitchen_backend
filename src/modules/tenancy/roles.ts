/**
 * One Postgres login role per workspace (D55): ws_<tenant id as 32 hex>. The database's
 * row-level security (migration 0049) reads the connected role, so a connection opened as a
 * workspace role can only ever see and write that workspace's rows.
 *
 * The role's password is derived, never stored: HMAC(JWT_SECRET, context + tenant id). The
 * database receives only a SCRAM-SHA-256 verifier, so the password itself never appears in
 * SQL text or database logs. Rotating JWT_SECRET is handled by ensureWorkspaceRole, which
 * re-applies the verifier every time a workspace's connections are opened.
 *
 * The verifier's salt is derived from the same secret, so re-applying it on every process start
 * writes the identical verifier. A random salt changed it on every restart, and Supabase's pooler
 * (Supavisor), which caches each role's verifier, then rejected workspace logins with "password
 * authentication failed" until its cache refreshed (seen after the 2026-10-28 deploy).
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { loadConfig } from "../../config.js";

const SALT_CONTEXT = "orion-workspace-role-salt:v1:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PASSWORD_CONTEXT = "orion-workspace-role:v1:";

/** ws_<32 hex>. Throws on anything that is not a lowercase canonical uuid (fail closed). */
export function workspaceRoleName(tenantId: string): string {
  if (!UUID_RE.test(tenantId)) throw new Error("workspace role: tenant id is not a canonical uuid");
  return `ws_${tenantId.replace(/-/g, "")}`;
}

export function workspaceRolePassword(tenantId: string): string {
  return createHmac("sha256", loadConfig().jwtSecret).update(PASSWORD_CONTEXT + tenantId).digest("base64url");
}

/** The role's SCRAM verifier: same secret and tenant -> byte-identical verifier (stable salt). */
export function workspaceRoleVerifier(tenantId: string): string {
  const salt = createHmac("sha256", loadConfig().jwtSecret).update(SALT_CONTEXT + tenantId).digest().subarray(0, 16);
  return scramSha256Verifier(workspaceRolePassword(tenantId), salt);
}

/**
 * The SCRAM-SHA-256 verifier Postgres stores for a password (RFC 5802 / 7677), in the
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>` form ALTER ROLE accepts.
 * The password is ASCII (base64url), so SASLprep leaves it unchanged.
 */
export function scramSha256Verifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

const VERIFIER_RE = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

/**
 * Creates the workspace's role if missing (member of orion_tenant) and lets the connected
 * owner SET ROLE to it (never inherit its rights), so the owner can SET LOCAL ROLE into the workspace inside a
 * transaction (sign-up, join links). With `login`, also enables login with the derived
 * password (per-workspace pools). Idempotent. Identifiers and the verifier are validated
 * above; DDL cannot take bind parameters.
 */
export async function ensureWorkspaceRole(platformDb: Pick<DB, "execute">, tenantId: string, options: { login?: boolean } = {}): Promise<void> {
  const role = workspaceRoleName(tenantId);
  let loginStatement = "";
  if (options.login) {
    const verifier = workspaceRoleVerifier(tenantId);
    if (!VERIFIER_RE.test(verifier)) throw new Error("workspace role: unexpected verifier format");
    loginStatement = `ALTER ROLE ${role} WITH LOGIN PASSWORD '${verifier}';`;
  }
  await platformDb.execute(
    sql.raw(`DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE ${role} NOLOGIN IN ROLE orion_tenant;
  END IF;
  ${loginStatement}
  -- Postgres 16+: creating a role makes the creator a member with ADMIN but WITHOUT the SET
  -- option, so 'MEMBER' is already true while SET ROLE is still refused. Check SET itself.
  IF NOT pg_has_role(current_user, '${role}', 'SET') THEN
    EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', '${role}', current_user);
  END IF;
END $$`),
  );
}

/** Inside a transaction on the owner connection: act as the workspace until it ends. */
export async function actAsWorkspace(tx: Pick<DB, "execute">, tenantId: string): Promise<void> {
  await ensureWorkspaceRole(tx, tenantId);
  await tx.execute(sql.raw(`SET LOCAL ROLE ${workspaceRoleName(tenantId)}`));
}
