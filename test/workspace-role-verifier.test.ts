/**
 * Workspace login roles (D55) are re-ensured on every process start. The stored SCRAM verifier
 * must therefore be identical each time: Supabase's pooler caches it, and a verifier that changed
 * on restart (random salt) made workspace logins fail after the 2026-10-28 deploy.
 */
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { workspaceRolePassword, workspaceRoleVerifier } from "../src/modules/tenancy/roles.js";

const A = "a6d42085-684c-4d28-aa34-d09e42cc56b3";
const B = "00000000-0000-4000-8000-000000000001";

/** Parses `SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey>`. */
function parse(verifier: string) {
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier);
  if (!m) throw new Error(`not a SCRAM verifier: ${verifier}`);
  return { iterations: Number(m[1]), salt: Buffer.from(m[2]!, "base64"), storedKey: m[3]!, serverKey: m[4]! };
}

describe("workspaceRoleVerifier", () => {
  it("is identical every time for the same workspace (restarts do not change it)", () => {
    expect(workspaceRoleVerifier(A)).toBe(workspaceRoleVerifier(A));
  });

  it("differs between workspaces (each role has its own salt)", () => {
    expect(parse(workspaceRoleVerifier(A)).salt.equals(parse(workspaceRoleVerifier(B)).salt)).toBe(false);
  });

  it("is a valid SCRAM-SHA-256 verifier for the workspace's derived password", () => {
    const { iterations, salt, storedKey, serverKey } = parse(workspaceRoleVerifier(A));
    expect(iterations).toBe(4096);
    expect(salt).toHaveLength(16);
    const salted = pbkdf2Sync(workspaceRolePassword(A), salt, iterations, 32, "sha256");
    const clientKey = createHmac("sha256", salted).update("Client Key").digest();
    expect(createHash("sha256").update(clientKey).digest("base64")).toBe(storedKey);
    expect(createHmac("sha256", salted).update("Server Key").digest("base64")).toBe(serverKey);
  });
});
