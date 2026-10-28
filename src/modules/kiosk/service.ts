/**
 * Paired kiosk screens (D56). A signed-in owner/HR pairs a screen to THEIR workspace; the
 * screen keeps `<device id>.<HMAC>` and sends it on every kiosk call, which then runs as that
 * workspace. Nothing secret is stored; revoking the row cuts the screen off.
 *
 * Owner-side functions run inside the owner's workspace (workspace-scoped db: RLS confines
 * them). resolveKioskWorkspace runs on the owner connection: the token decides the workspace.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { kioskDevices, type KioskDevice } from "../../db/schema.js";
import { signId, verifySignedId } from "../auth/signed-id.js";

const TOKEN_PURPOSE = "orion-kiosk:v1";

export function kioskToken(id: string): string {
  return signId(TOKEN_PURPOSE, id);
}

export interface PairKioskInput {
  name: string;
  /** Generated once per "open the kiosk" intent by the client; a retry replays the same pairing. */
  clientRequestId: string;
  createdByUserId: string;
  /** The token this screen already holds, if any: kept when it is still active in this workspace. */
  existingToken?: string;
}

export type PairKioskResult = { ok: true; device: KioskDevice; reused: boolean } | { ok: false; code: "REQUEST_REUSED" };

/**
 * Pairs this screen with the caller's workspace. A screen already paired to the same
 * workspace keeps its token (no duplicate rows each time someone opens the kiosk); a token
 * from another workspace, a revoked one or a forged one is ignored and a new pairing made.
 */
export async function pairKioskDevice(db: DB, input: PairKioskInput): Promise<PairKioskResult> {
  const existingId = input.existingToken ? verifySignedId(TOKEN_PURPOSE, input.existingToken) : null;
  if (existingId) {
    // RLS: a device of another workspace is invisible here, so it cannot be reused.
    const [current] = await db
      .select()
      .from(kioskDevices)
      .where(and(eq(kioskDevices.id, existingId), isNull(kioskDevices.revokedAt)));
    if (current) return { ok: true, device: current, reused: true };
  }

  const [created] = await db
    .insert(kioskDevices)
    .values({ name: input.name, clientRequestId: input.clientRequestId, createdByUserId: input.createdByUserId })
    .onConflictDoNothing({ target: [kioskDevices.tenantId, kioskDevices.clientRequestId] })
    .returning();
  if (created) return { ok: true, device: created, reused: false };

  const [replay] = await db.select().from(kioskDevices).where(eq(kioskDevices.clientRequestId, input.clientRequestId));
  if (replay && replay.createdByUserId === input.createdByUserId && replay.name === input.name) {
    return { ok: true, device: replay, reused: true };
  }
  return { ok: false, code: "REQUEST_REUSED" };
}

/** Newest first, bounded. */
export async function listKioskDevices(db: DB, limit = 50): Promise<KioskDevice[]> {
  return db.select().from(kioskDevices).orderBy(desc(kioskDevices.createdAt), desc(kioskDevices.id)).limit(limit);
}

/** Revoke is a no-op when repeated; NOT_FOUND for ids outside this workspace (RLS). */
export async function revokeKioskDevice(db: DB, id: string): Promise<KioskDevice | null> {
  const [revoked] = await db
    .update(kioskDevices)
    .set({ revokedAt: new Date() })
    .where(and(eq(kioskDevices.id, id), isNull(kioskDevices.revokedAt)))
    .returning();
  if (revoked) return revoked;
  const [existing] = await db.select().from(kioskDevices).where(eq(kioskDevices.id, id));
  return existing ?? null;
}

/** The workspace an active kiosk token belongs to, or null (owner connection: looks across all). */
export async function resolveKioskWorkspace(platformDb: DB, token: string): Promise<string | null> {
  const id = verifySignedId(TOKEN_PURPOSE, token);
  if (!id) return null;
  const [device] = await platformDb
    .select({ tenantId: kioskDevices.tenantId })
    .from(kioskDevices)
    .where(and(eq(kioskDevices.id, id), isNull(kioskDevices.revokedAt)));
  return device?.tenantId ?? null;
}
