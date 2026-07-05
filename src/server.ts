/**
 * Server entry point — wires Express + Socket.IO together.
 *
 * Architecture (Task 8):
 *   1. Create a bare http.Server (no request handler yet).
 *   2. Attach Socket.IO to it (handles WebSocket upgrades).
 *   3. Build the RealtimeHub from the IO server.
 *   4. Create the Express app with the hub injected.
 *   5. Register the Express app as the HTTP request handler.
 *   6. Listen once on the configured port.
 *
 * CORS (SF-3, audit-backend.md HIGH "wildcard CORS"): Socket.IO shares the
 * SAME allowlist predicate as the REST API (src/cors.ts) — previously this
 * was a bare "*", meaning any origin's browser JS could open a socket and
 * join a location room to receive live order/stock/print events.
 */
import { createServer } from "node:http";
import { Server as IOServer } from "socket.io";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { corsOriginCallback, createOriginAllowlist } from "./cors.js";
import { createDb } from "./db/client.js";
import { createSocketHub } from "./realtime/hub.js";

const config = loadConfig();
const { db } = createDb({ dataDir: config.dbPath, databaseUrl: config.databaseUrl });

// 1. Bare HTTP server (no request handler — Express is added below)
const httpServer = createServer();

// 2. Socket.IO server attached to the same port as Express
const isOriginAllowed = createOriginAllowlist(config.corsOrigins);
const io = new IOServer(httpServer, {
  cors: {
    origin: corsOriginCallback(isOriginAllowed),
    methods: ["GET", "POST"],
  },
});

// 3. Hub backed by the live Socket.IO server (verifies handshake JWTs +
//    session revocation — H1 — so `db` is passed in)
const hub = createSocketHub(io, config.jwtSecret, db);

// 4. Express app with the hub injected
const app = createApp(db, hub);

// 5. Express handles all plain HTTP requests on the same server
httpServer.on("request", app);

// 6. Listen — one port for both REST and WebSocket
httpServer.listen(config.port, () => {
  console.log(`CloudKitchen backend listening on http://localhost:${config.port}`);
  console.log("  REST  → http://localhost:" + config.port + "/api/v1");
  console.log("  WS    → ws://localhost:" + config.port + " (Socket.IO)");
});
