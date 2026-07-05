/**
 * Task 8 — Realtime Layer Tests (CK1-ARC-002 §6, CK1-API-003 §10)
 *
 * Full integration test: real http.Server + Socket.IO server + socket.io-client +
 * supertest against the same http server. Uses an ephemeral port (port 0) so no
 * port conflicts with other test files.
 *
 * Covers (minimum acceptance from Task 8):
 *   - Client connects and joins the location room via handshake auth.locationId
 *   - order.created is emitted to the room after POST /ingest/order succeeds
 *   - order.updated is emitted to the room after POST /orders/:id/advance succeeds
 *   - stock.updated is emitted to the room after NEW→PREPARING deduction
 *
 * Clean-up: socket, ioServer, httpServer all closed in afterAll.
 * Pool is "forks" (vitest.config.ts); no shared state with other files.
 */
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server as IOServer } from "socket.io";
import { io as ioc, type Socket } from "socket.io-client";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { randomUUID } from "node:crypto";
import { createSocketHub, type RealtimeHub } from "../src/realtime/hub.js";
import { loadConfig } from "../src/config.js";
import { locations } from "../src/db/schema.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let db: DB;
let httpServer: HttpServer;
let ioServer: IOServer;
let hub: RealtimeHub;
let clientSocket: Socket;
let locationId: string;
let adminToken: string;
let kitchenToken: string;
let warehouseToken: string;
let brandId: string;
let menuItemId: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a promise that resolves with the event payload when the given
 * Socket.IO event arrives, or rejects after timeoutMs.
 */
function waitForEvent<T>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(
        new Error(`Timed out waiting for Socket.IO event "${event}" after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    function handler(data: T) {
      clearTimeout(timer);
      resolve(data);
    }

    socket.once(event, handler);
  });
}

// ---------------------------------------------------------------------------
// beforeAll: spin up server, seed DB, wire fixtures, connect socket client
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. In-memory DB + seed (provides location, stations, warehouses, users)
  const created = createDb();
  db = created.db;
  await seed(db);

  // 2. Resolve the seeded location id (single location in prototype)
  const [loc] = await db.select({ id: locations.id }).from(locations);
  locationId = loc.id;

  // 3. Build http server + Socket.IO + hub + Express app all sharing the same server
  httpServer = createServer();
  ioServer = new IOServer(httpServer, { cors: { origin: "*" } });
  // Hub verifies handshake JWTs against the same secret the app signs with,
  // plus session revocation (H1) — so it needs the db handle.
  hub = createSocketHub(ioServer, loadConfig().jwtSecret, db);
  const app = createApp(db, hub);
  // Attach Express as the HTTP request handler on the same server as Socket.IO
  httpServer.on("request", app);

  // 4. Listen on OS-chosen ephemeral port
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));

  // 5. Authenticate
  const loginAdmin = await request(httpServer)
    .post("/api/v1/auth/login")
    .send({ email: "admin@cloudkitchen.local", password: "admin123" });
  adminToken = loginAdmin.body.token as string;

  const loginKitchen = await request(httpServer)
    .post("/api/v1/auth/login")
    .send({ email: "kitchen_staff@cloudkitchen.local", password: "password123" });
  kitchenToken = loginKitchen.body.token as string;

  const loginWarehouse = await request(httpServer)
    .post("/api/v1/auth/login")
    .send({ email: "warehouse@cloudkitchen.local", password: "password123" });
  warehouseToken = loginWarehouse.body.token as string;

  // 6. Create brand + aggregator account
  const brandRes = await request(httpServer)
    .post("/api/v1/brands")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "RT Test Brand", color: "#ff0000" });
  brandId = brandRes.body.id as string;

  await request(httpServer)
    .post(`/api/v1/brands/${brandId}/accounts`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ aggregator: "FOODPANDA", external_merchant_id: "RT-FP-001", credential_ref: "rt-ref" });

  // 7. Create ingredient + stock in KITCHEN
  const ingRes = await request(httpServer)
    .post("/api/v1/ingredients")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "RT Chicken", unit: "g", unit_cost: "0.05", low_stock_threshold: "10" });
  const ingId = ingRes.body.id as string;

  await request(httpServer)
    .post("/api/v1/inventory/receive")
    .set("Authorization", `Bearer ${warehouseToken}`)
    .send({ items: [{ ingredient_id: ingId, quantity: 5000 }] });

  const itoRes = await request(httpServer)
    .post("/api/v1/itos")
    .set("Authorization", `Bearer ${kitchenToken}`)
    .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: ingId, quantity: 5000 }] });

  await request(httpServer)
    .post(`/api/v1/itos/${itoRes.body.id}/confirm`)
    .set("Authorization", `Bearer ${warehouseToken}`);

  // 8. Get the Grill station id (created by seed)
  const stationsRes = await request(httpServer)
    .get("/api/v1/stations")
    .set("Authorization", `Bearer ${adminToken}`);
  const grillStation = (stationsRes.body as Array<{ id: string; name: string }>).find(
    (s) => s.name === "Grill",
  );
  if (!grillStation) throw new Error("Grill station not found in seed data");

  // 9. Create menu item with recipe
  const menuRes = await request(httpServer)
    .post(`/api/v1/brands/${brandId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "RT Teriyaki", price: "200", station_id: grillStation.id });
  menuItemId = menuRes.body.id as string;

  await request(httpServer)
    .put(`/api/v1/menu/${menuItemId}/recipe`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ lines: [{ ingredient_id: ingId, portion_qty: 100, unit: "g" }] });

  // 10. Connect a socket.io-client to the same httpServer
  const addr = httpServer.address() as { port: number };
  clientSocket = ioc(`http://localhost:${addr.port}`, {
    // Pass a valid user JWT (required by the handshake auth middleware) plus the
    // locationId so the server auto-joins the client to the location room.
    auth: { token: adminToken, locationId },
    transports: ["websocket"],
  });

  await new Promise<void>((resolve, reject) => {
    clientSocket.once("connect", resolve);
    clientSocket.once("connect_error", (err) => reject(err));
    setTimeout(() => reject(new Error("Socket connect timed out after 5s")), 5000);
  });
}, 60_000);

afterAll(async () => {
  // 1. Disconnect the client socket first so Socket.IO drains it cleanly
  if (clientSocket?.connected) {
    clientSocket.disconnect();
    await new Promise((r) => setTimeout(r, 100));
  }

  // 2. Close the Socket.IO server.
  //    In Socket.IO v4, io.close() internally calls httpServer.close() on the
  //    attached http.Server, so we must NOT close httpServer again afterwards.
  await new Promise<void>((resolve) => {
    ioServer.close(() => resolve());
  });
}, 15_000);

// ---------------------------------------------------------------------------
// External ref generator (avoids idempotency conflicts across test runs)
// ---------------------------------------------------------------------------

let _refSeq = 0;
function nextRef(): string {
  return `RT-${Date.now()}-${++_refSeq}`;
}

// ---------------------------------------------------------------------------
// Test: order.created
// ---------------------------------------------------------------------------

describe("order.created — socket event on ingest", () => {
  it("emits order.created with order_id + status=NEW within 3s", async () => {
    // Register the listener BEFORE triggering the HTTP request so we never miss the event
    const eventPromise = waitForEvent<{ order_id: string; status: string }>(
      clientSocket,
      "order.created",
    );

    const ingestRes = await request(httpServer)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        customer_name: "RT Customer",
        items: [{ menu_item_id: menuItemId, qty: 1 }],
      });

    expect(ingestRes.status).toBe(201);
    const orderId = ingestRes.body.order_id as string;

    const event = await eventPromise;
    expect(event.order_id).toBe(orderId);
    expect(event.status).toBe("NEW");
  });
});

// ---------------------------------------------------------------------------
// Test: order.updated + stock.updated
// ---------------------------------------------------------------------------

describe("order.updated + stock.updated — socket events on advance", () => {
  let advanceOrderId: string;

  it("setup: ingest a fresh order for advance tests", async () => {
    const res = await request(httpServer)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        items: [{ menu_item_id: menuItemId, qty: 2 }],
      });
    expect(res.status).toBe(201);
    advanceOrderId = res.body.order_id as string;
  });

  it("advance NEW→PREPARING emits order.updated AND stock.updated within 3s", async () => {
    // Register listeners BEFORE the HTTP call
    const orderUpdatedPromise = waitForEvent<{ order_id: string; status: string }>(
      clientSocket,
      "order.updated",
    );
    const stockUpdatedPromise = waitForEvent<{
      ingredientId: string;
      warehouseType: string;
      quantity: number;
    }>(clientSocket, "stock.updated");

    const advRes = await request(httpServer)
      .post(`/api/v1/orders/${advanceOrderId}/advance`)
      .set("Authorization", `Bearer ${kitchenToken}`);

    expect(advRes.status).toBe(200);
    expect(advRes.body.status).toBe("PREPARING");

    const [orderUpdated, stockUpdated] = await Promise.all([
      orderUpdatedPromise,
      stockUpdatedPromise,
    ]);

    expect(orderUpdated.order_id).toBe(advanceOrderId);
    expect(orderUpdated.status).toBe("PREPARING");
    expect(stockUpdated.warehouseType).toBe("KITCHEN");
    expect(typeof stockUpdated.quantity).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Test: handshake authentication (SF-1)
// ---------------------------------------------------------------------------

describe("socket handshake auth — rejects unauthenticated / bad tokens", () => {
  const addr = () => (httpServer.address() as { port: number }).port;

  function expectRejected(auth: Record<string, unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const s = ioc(`http://localhost:${addr()}`, { auth, transports: ["websocket"] });
      const timer = setTimeout(() => {
        s.disconnect();
        reject(new Error("expected connect_error but socket connected/hung"));
      }, 3000);
      s.once("connect", () => {
        clearTimeout(timer);
        s.disconnect();
        reject(new Error("socket connected but should have been rejected"));
      });
      s.once("connect_error", (err) => {
        clearTimeout(timer);
        s.disconnect();
        expect(err.message).toMatch(/UNAUTHORIZED/);
        resolve();
      });
    });
  }

  it("rejects a socket with no token", async () => {
    await expectRejected({ locationId });
  });

  it("rejects a socket with a garbage token", async () => {
    await expectRejected({ token: "not-a-real-jwt", locationId });
  });
});

// ---------------------------------------------------------------------------
// H1 — per-room join authorization + handshake session revocation
// ---------------------------------------------------------------------------

describe("socket join authorization (H1)", () => {
  const url = () => `http://localhost:${(httpServer.address() as { port: number }).port}`;

  async function connect(auth: Record<string, unknown>): Promise<Socket> {
    const s = ioc(url(), { auth, transports: ["websocket"] });
    await new Promise<void>((resolve, reject) => {
      s.once("connect", resolve);
      s.once("connect_error", reject);
      setTimeout(() => reject(new Error("connect timed out")), 5000);
    });
    return s;
  }

  it("ASSIGNED socket cannot join a room outside its outlet_ids (rejected, no events)", async () => {
    // warehouse@ = WAREHOUSE_OUTLET (ASSIGNED to the seeded outlet only).
    const foreignRoom = randomUUID();
    const s = await connect({ token: warehouseToken }); // no auto-join locationId

    // The explicit join for a non-member outlet must be refused.
    const rejected = waitForEvent<{ code: string; locationId: string }>(s, "join_rejected");
    s.emit("join", foreignRoom);
    const evt = await rejected;
    expect(evt.code).toBe("FORBIDDEN");
    expect(evt.locationId).toBe(foreignRoom);

    // And it must NOT receive events broadcast to that foreign room.
    let leaked = false;
    s.once("order.created", () => {
      leaked = true;
    });
    hub.emitToLocation(foreignRoom, "order.created", { order_id: "leak-check" });
    await new Promise((r) => setTimeout(r, 300));
    expect(leaked).toBe(false);

    s.disconnect();
  });

  it("ASSIGNED socket CAN join its own outlet room and receives its events", async () => {
    const s = await connect({ token: warehouseToken, locationId }); // auto-join own outlet
    let received = false;
    s.once("stock.updated", () => {
      received = true;
    });
    hub.emitToLocation(locationId, "stock.updated", { ingredientId: "ok" });
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toBe(true);
    s.disconnect();
  });

  it("rejects a handshake whose session has been revoked (logout)", async () => {
    // Fresh login → new session; logging out closes THAT session only.
    const loginRes = await request(httpServer)
      .post("/api/v1/auth/login")
      .send({ email: "warehouse@cloudkitchen.local", password: "password123" });
    const revokedToken = loginRes.body.token as string;

    await request(httpServer)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${revokedToken}`);

    await new Promise<void>((resolve, reject) => {
      const s = ioc(url(), { auth: { token: revokedToken, locationId }, transports: ["websocket"] });
      const timer = setTimeout(() => {
        s.disconnect();
        reject(new Error("expected connect_error but socket connected/hung"));
      }, 3000);
      s.once("connect", () => {
        clearTimeout(timer);
        s.disconnect();
        reject(new Error("revoked token connected but should have been rejected"));
      });
      s.once("connect_error", (err) => {
        clearTimeout(timer);
        s.disconnect();
        expect(err.message).toMatch(/UNAUTHORIZED/);
        resolve();
      });
    });
  });
});
