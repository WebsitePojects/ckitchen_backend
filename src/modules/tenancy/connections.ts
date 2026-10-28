/**
 * Database connections per workspace (D55).
 *
 * Isolated mode (TENANT_DB_ROLES=on with a Postgres DATABASE_URL): each workspace gets a small
 * pool that logs in as its own role (ws_<id>), so row-level security confines every query to
 * that workspace with no per-request setup. Pools are opened on first use and kept.
 *
 * Single-business mode (anything else, including tests on PGlite): every request uses the
 * owner connection, exactly as before workspaces existed. Only workspace #1 may be entered
 * in this mode; any other workspace is refused, because the owner connection would show it
 * CloudKitchen's rows.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { eq } from "drizzle-orm";
import { createDb, type DB } from "../../db/client.js";
import { tenants, WORKSPACE_ONE_ID } from "../../db/schema.js";
import { runInWorkspace } from "./context.js";
import { ensureWorkspaceRole, workspaceRoleName, workspaceRolePassword } from "./roles.js";

export interface WorkspaceConnections {
  /** True when each workspace connects as its own database role. */
  readonly isolated: boolean;
  dbFor(tenantId: string): Promise<DB>;
  closeAll(): Promise<void>;
}

export class WorkspaceNotAvailableError extends Error {
  constructor(tenantId: string) {
    super(`workspace ${tenantId} cannot be entered: workspace isolation is not enabled on this server`);
    this.name = "WorkspaceNotAvailableError";
  }
}

/** DATABASE_URL rewritten to log in as the workspace role (Supabase pooler: <role>.<project ref>). */
export function workspaceDatabaseUrl(platformUrl: string, tenantId: string): string {
  const url = new URL(platformUrl);
  const role = workspaceRoleName(tenantId);
  const user = decodeURIComponent(url.username);
  const dot = user.indexOf(".");
  url.username = dot >= 0 ? `${role}${user.slice(dot)}` : role;
  url.password = workspaceRolePassword(tenantId); // base64url: URL-safe as is
  return url.toString();
}

export function createWorkspaceConnections(options: { platformDb: DB; databaseUrl?: string; isolated: boolean }): WorkspaceConnections {
  const { platformDb, databaseUrl } = options;
  const isolated = options.isolated && Boolean(databaseUrl);
  const pools = new Map<string, Promise<{ db: DB; close: () => Promise<void> }>>();

  async function open(tenantId: string) {
    await ensureWorkspaceRole(platformDb, tenantId, { login: true });
    const { db, client } = createDb({ databaseUrl: workspaceDatabaseUrl(databaseUrl!, tenantId), pool: { max: 3, idleTimeoutSeconds: 120 } });
    return { db, close: () => (client as { end: () => Promise<void> }).end() };
  }

  return {
    isolated,
    async dbFor(tenantId) {
      if (!isolated) {
        if (tenantId !== WORKSPACE_ONE_ID) throw new WorkspaceNotAvailableError(tenantId);
        return platformDb;
      }
      let pool = pools.get(tenantId);
      if (!pool) {
        pool = open(tenantId);
        pools.set(tenantId, pool);
        // A failed open (database unreachable) must not stay cached forever.
        pool.catch(() => pools.delete(tenantId));
      }
      return (await pool).db;
    },
    async closeAll() {
      const opened = [...pools.values()];
      pools.clear();
      await Promise.allSettled(opened.map(async (p) => (await p).close()));
    },
  };
}

/**
 * Workspaces background work should visit: every active one when isolated, else only
 * workspace #1 (the only workspace single-business mode may enter).
 */
export async function activeWorkspaceIds(platformDb: DB, connections: WorkspaceConnections): Promise<string[]> {
  if (!connections.isolated) return [WORKSPACE_ONE_ID];
  const rows = await platformDb.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, "ACTIVE")).orderBy(tenants.createdAt);
  return rows.map((r) => r.id);
}

/** Runs the rest of the request as `tenantId`; 503 if its connection cannot be opened. */
export async function enterWorkspace(req: Request, res: Response, next: NextFunction, tenantId: string): Promise<void> {
  const connections = req.app.get("workspaces") as WorkspaceConnections | undefined;
  let db: DB;
  try {
    if (!connections) throw new Error("no workspace connections registered on the app (app.set(\"workspaces\", ...))");
    db = await connections.dbFor(tenantId);
  } catch (err) {
    console.error(`[tenancy] could not enter workspace ${tenantId}: ${err instanceof Error ? err.message : String(err)}`);
    res.status(503).json({ error: { code: "WORKSPACE_UNAVAILABLE", message: "This workspace is temporarily unavailable. Try again." } });
    return;
  }
  runInWorkspace({ tenantId, db }, next);
}

/**
 * For routes with no signed-in user that today serve CloudKitchen only: the attendance kiosk
 * and partner webhooks (every Grab/foodpanda listing belongs to workspace #1 until partner
 * routing per workspace is built). Explicit, so no route reaches data without a workspace.
 */
export const workspaceOne: RequestHandler = (req, res, next) => {
  void enterWorkspace(req, res, next, WORKSPACE_ONE_ID);
};
