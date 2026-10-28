/**
 * Which workspace the current request (or worker job) acts for, and the database handle that
 * acts as it. Routers are built once with a workspace-scoped `db` (createWorkspaceScopedDb);
 * every property access on it resolves to the current workspace's connection, so the ~300
 * existing `db.select(...)` call sites need no change.
 *
 * Fail closed: using the scoped db with no workspace entered throws instead of falling back
 * to the owner connection, which would see every business's rows.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { DB } from "../../db/client.js";

export interface WorkspaceContext {
  tenantId: string;
  db: DB;
}

const storage = new AsyncLocalStorage<WorkspaceContext>();

/** Runs `fn` (and everything it awaits) as the given workspace. */
export function runInWorkspace<T>(context: WorkspaceContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentWorkspace(): WorkspaceContext | undefined {
  return storage.getStore();
}

export class WorkspaceContextMissingError extends Error {
  constructor() {
    super("No workspace entered: this code path must run inside runInWorkspace (requireAuth or an explicit workspace)");
    this.name = "WorkspaceContextMissingError";
  }
}

/** A DB whose every use is routed to the current workspace's connection. */
export function createWorkspaceScopedDb(): DB {
  return new Proxy({} as DB, {
    get(_target, property) {
      const context = storage.getStore();
      if (!context) throw new WorkspaceContextMissingError();
      const value = (context.db as unknown as Record<PropertyKey, unknown>)[property];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(context.db) : value;
    },
  });
}
