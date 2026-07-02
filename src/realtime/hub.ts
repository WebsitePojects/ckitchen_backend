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
 * live order/stock/print events. NOTE: per-room OUTLET authorization is not yet
 * enforced here because the JWT does not carry outlet claims yet (pending ADR
 * D22 `user_outlet_access` + outlet claims). Once it does, the `join` handler
 * must validate the requested locationId against the authenticated user's
 * allowed outlets. Tracked in docs/audits/audit-backend.md (CRITICAL #1/#3).
 *
 * Design principle (CK1-ARC-002 §6): services remain PURE and return domain
 * events; route handlers call the hub after the service call succeeds.  The hub
 * is injected so tests that call `createApp(db)` get a noop hub automatically.
 */
import type { Server as IOServer } from "socket.io";
import { verifyToken } from "../modules/auth/service.js";

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
 * Builds a hub backed by a live Socket.IO `Server`.
 *
 * Side-effect: registers a handshake auth middleware and a `connection` handler
 * on the `io` instance that:
 *   0. Rejects any socket without a valid user JWT in `handshake.auth.token`.
 *   1. Auto-joins clients to their location room if they supplied
 *      `auth.locationId` in the Socket.IO handshake.
 *   2. Handles an explicit `join` event so clients can switch rooms dynamically.
 *
 * @param jwtSecret  Secret used to verify the handshake token (same as REST).
 * CORS / transport config is the caller's responsibility (see server.ts).
 */
export function createSocketHub(io: IOServer, jwtSecret: string): RealtimeHub {
  // Handshake authentication — runs before `connection`. A socket that does not
  // present a verifiable user JWT never reaches the connection handler, so it
  // cannot join any room or receive any event.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      next(new Error("UNAUTHORIZED: missing auth token"));
      return;
    }
    try {
      socket.data.user = verifyToken(token, jwtSecret);
      next();
    } catch {
      next(new Error("UNAUTHORIZED: invalid auth token"));
    }
  });

  io.on("connection", (socket) => {
    // Auto-join via handshake auth (preferred — set before connect())
    const authLocationId = socket.handshake.auth?.locationId as string | undefined;
    if (authLocationId) {
      void socket.join(authLocationId);
    }

    // Dynamic join event (useful for clients that know the locationId at runtime)
    // TODO(D22): validate `locationId` against socket.data.user's allowed outlets
    // once the JWT carries outlet claims.
    socket.on("join", (locationId: unknown) => {
      if (typeof locationId === "string" && locationId.length > 0) {
        void socket.join(locationId);
      }
    });
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
