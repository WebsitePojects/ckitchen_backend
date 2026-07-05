/**
 * Realtime Hub — CK1-ARC-002 §6 / CK1-API-003 §10
 *
 * Thin abstraction over Socket.IO so the rest of the codebase can emit events
 * without being directly coupled to socket.io.
 *
 * Two implementations:
 *   createSocketHub(io)  — backed by a Socket.IO Server, emits to a per-location room
 *   createNoopHub()      — does nothing (default when no socket server is wired, e.g. tests)
 *
 * Room naming: the room name is simply the `locationId` UUID.  A client joins by
 * supplying `locationId` in the Socket.IO handshake `auth` object (auto-join on
 * connection) or by emitting a `join` event with the locationId payload.
 *
 * Auth: every socket MUST present a valid user JWT in `handshake.auth.token`
 * (the same token used for REST). Anonymous sockets are rejected at handshake —
 * this closes the hole where any client could join a location room and receive
 * live order/stock/print events.
 *
 * H1 (Fable review 2026-07-05) — the outlet claims that were "pending" now exist:
 *   1. Handshake also enforces SESSION REVOCATION (mirrors REST requireAuth /
 *      SF-4): a token whose `sid` points at a missing or logged-out session is
 *      rejected, so a stolen token stops streaming events the moment its session
 *      ends (not up to 12h later at token expiry).
 *   2. Room joins (auto-join via handshake `auth.locationId` AND the dynamic
 *      `join` event) are AUTHORIZED against the socket's own token: an ALL-scope
 *      user may join any location room; an ASSIGNED user only rooms in its
 *      `outlet_ids`. A disallowed join is refused (a `join_rejected` event is
 *      emitted and the socket is NOT added to the room), so it never receives
 *      another outlet's live order/stock/print events.
 *
 * Design principle (CK1-ARC-002 §6): services remain PURE and return domain
 * events; route handlers call the hub after the service call succeeds.  The hub
 * is injected so tests that call `createApp(db)` get a noop hub automatically.
 */
import type { Server as IOServer } from "socket.io";
import { eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { userSessions } from "../db/schema.js";
import { verifyToken, type AuthTokenPayload } from "../modules/auth/service.js";
import { outletScopeForRole } from "../modules/auth/roles.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Minimal contract for the realtime layer. Inject this instead of io directly. */
export interface RealtimeHub {
  /**
   * Emit a named event with an arbitrary payload to all clients subscribed to
   * a specific location room.
   */
  emitToLocation(locationId: string, event: string, payload: unknown): void;
}

// ---------------------------------------------------------------------------
// Socket.IO-backed implementation
// ---------------------------------------------------------------------------

/**
 * True if a socket's authenticated user may join `locationId`'s room: ALL-scope
 * users may join any outlet; ASSIGNED users only rooms in their `outlet_ids`.
 * Legacy tokens without an `outlet_scope` claim fall back to the role default.
 */
function canJoinLocation(user: AuthTokenPayload, locationId: string): boolean {
  const scope = user.outlet_scope ?? outletScopeForRole(user.role);
  if (scope === "ALL") return true;
  const ids = Array.isArray(user.outlet_ids) ? user.outlet_ids : [];
  return ids.includes(locationId);
}

/**
 * Builds a hub backed by a live Socket.IO `Server`.
 *
 * Side-effect: registers a handshake auth middleware and a `connection` handler
 * on the `io` instance that:
 *   0. Rejects any socket without a valid user JWT in `handshake.auth.token`, or
 *      whose session has been revoked (logout / admin close) — H1.
 *   1. Auto-joins clients to their location room if they supplied
 *      `auth.locationId` AND are authorized for it (H1).
 *   2. Handles an explicit `join` event, also membership-checked (H1).
 *
 * @param jwtSecret  Secret used to verify the handshake token (same as REST).
 * @param db         DB handle for the handshake session-revocation check.
 * CORS / transport config is the caller's responsibility (see server.ts).
 */
export function createSocketHub(io: IOServer, jwtSecret: string, db: DB): RealtimeHub {
  // Handshake authentication — runs before `connection`. A socket that does not
  // present a verifiable, non-revoked user JWT never reaches the connection
  // handler, so it cannot join any room or receive any event.
  io.use((socket, next) => {
    void (async () => {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) {
        next(new Error("UNAUTHORIZED: missing auth token"));
        return;
      }
      let payload: AuthTokenPayload;
      try {
        payload = verifyToken(token, jwtSecret);
      } catch {
        next(new Error("UNAUTHORIZED: invalid auth token"));
        return;
      }

      // H1 — session revocation, same rule as REST requireAuth (SF-4). A token
      // whose `sid` row is missing or has `logoutAt` set is rejected. Any DB
      // error fails CLOSED (reject), never crashes the handshake.
      if (payload.sid) {
        try {
          const [session] = await db
            .select({ logoutAt: userSessions.logoutAt })
            .from(userSessions)
            .where(eq(userSessions.id, payload.sid));
          if (!session || session.logoutAt !== null) {
            next(new Error("UNAUTHORIZED: session ended"));
            return;
          }
        } catch {
          next(new Error("UNAUTHORIZED: session check failed"));
          return;
        }
      }

      socket.data.user = payload;
      next();
    })();
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as AuthTokenPayload | undefined;

    // Attempt to join `locationId` if the socket's user is authorized; otherwise
    // refuse and tell the client (H1). Never silently join a foreign room.
    const tryJoin = (locationId: unknown): void => {
      if (typeof locationId !== "string" || locationId.length === 0) return;
      if (!user || !canJoinLocation(user, locationId)) {
        socket.emit("join_rejected", {
          code: "FORBIDDEN",
          locationId: typeof locationId === "string" ? locationId : null,
          message: "Outlet not in your access scope.",
        });
        return;
      }
      void socket.join(locationId);
    };

    // Auto-join via handshake auth (preferred — set before connect())
    tryJoin(socket.handshake.auth?.locationId);

    // Dynamic join event (clients that know/switch the locationId at runtime)
    socket.on("join", (locationId: unknown) => tryJoin(locationId));
  });

  return {
    emitToLocation(locationId, event, payload) {
      io.to(locationId).emit(event, payload);
    },
  };
}

// ---------------------------------------------------------------------------
// No-op implementation (default for tests / contexts without a socket server)
// ---------------------------------------------------------------------------

/** Returns a hub that silently discards every emit. Safe for unit tests. */
export function createNoopHub(): RealtimeHub {
  return {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    emitToLocation(_locationId, _event, _payload) {
      // intentional no-op
    },
  };
}
