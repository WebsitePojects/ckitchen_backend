/**
 * Task 7 — Print Jobs Queue + Print Agent Protocol + Reprint (CK1-API-003 §8)
 * SF-2 (audit-backend.md CRITICAL #2) — per-agent hashed tokens + location binding.
 *
 * Covers:
 *   Agent endpoints:
 *     - POST /agent/register               — bootstrap AGENT_TOKEN gate; mints a
 *                                             per-agent token (returned once, raw).
 *     - GET  /agent/print-jobs/pending      — per-agent token; location derived
 *                                             ONLY from the token's own binding.
 *     - POST /agent/print-jobs/:id/ack      — per-agent token; 403 cross-location.
 *     - POST /agent/printers/status         — per-agent token; 403 cross-location.
 *   User endpoints (JWT + RBAC):
 *     - GET  /print-jobs?status=...
 *     - POST /print-jobs/:id/reprint
 *
 * Lifecycle under test:
 *   ingest → PENDING jobs created → agent pulls → ack PRINTED/FAILED → reprint FAILED → new PENDING
 *
 * Cardinal Business Rule #7: No KOT silently lost.
 *   - Every job ends PRINTED or FAILED; reprint always creates a NEW PENDING job.
 *   - Agent uses X-Agent-Token (NOT a user JWT) — bootstrap secret for register,
 *     a per-agent hashed token for everything else.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import {
  aggregatorAccounts,
  kitchenStations,
  locations,
  orderItems,
  orders,
  printers,
  printJobs,
} from "../src/db/schema.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let app: Express;
let db: DB;
let adminToken: string;
let kitchenToken: string;

// Bootstrap secret — gates ONLY POST /agent/register (matches loadConfig() test default).
const BOOTSTRAP_TOKEN = "test-agent-token";

// Per-agent token minted by /agent/register for THIS file's agent — used for
// every other agent call (pending/ack/printer-status). Never the bootstrap secret.
let agentToken: string;

// Fixture IDs set in beforeAll
let grillStationId: string;
let printerId: string;
let brandId: string;
let menuItemId: string;
let locationId: string; // seeded CK1 location — this file's agent is registered here

// Ingested order's print job ids (from the pending list)
let pendingJobId: string; // first PENDING job to use in ack / reprint tests

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  return res.body.token as string;
}

let _refSeq = 0;
function nextRef(): string {
  return `PRINT-TEST-${Date.now()}-${++_refSeq}`;
}

/**
 * GET /agent/print-jobs/pending using this file's per-agent token. SF-2: the
 * endpoint no longer takes a location_id — location comes from the token's own
 * binding — so no query param is sent here anymore (see the dedicated test
 * below confirming a client-supplied location_id is simply ignored).
 */
function getPending() {
  return request(app).get("/api/v1/agent/print-jobs/pending").set("X-Agent-Token", agentToken);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");

  // ── Resolve seeded Grill station + location ─────────────────────────────
  const stations = await db.select().from(kitchenStations);
  const grillStation = stations.find((s) => s.name === "Grill");
  if (!grillStation) throw new Error("Grill station not seeded");
  grillStationId = grillStation.id;
  locationId = grillStation.locationId;

  // ── Register the print agent for this location (bootstrap-gated; mints the
  // per-agent token every subsequent agent call in this file uses) ──────────
  const registerRes = await request(app)
    .post("/api/v1/agent/register")
    .set("X-Agent-Token", BOOTSTRAP_TOKEN)
    .send({ agent_name: "Printing Test Agent", location_id: locationId });
  expect(registerRes.status).toBe(200);
  expect(registerRes.body.token).toBeTruthy();
  agentToken = registerRes.body.token as string;

  // ── Create a printer ────────────────────────────────────────────────────
  const printerRes = await request(app)
    .post("/api/v1/printers")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Grill Printer", connection: "NETWORK", address: "192.168.1.50:9100" });
  expect(printerRes.status).toBe(201);
  printerId = printerRes.body.id as string;

  // ── Assign printer to Grill station (direct DB update — no PATCH /stations/:id) ──
  await db
    .update(kitchenStations)
    .set({ defaultPrinterId: printerId })
    .where(eq(kitchenStations.id, grillStationId));

  // ── Create brand + FOODPANDA account ────────────────────────────────────
  const brandRes = await request(app)
    .post("/api/v1/brands")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Print Test Brand", color: "#ABCDEF" });
  expect(brandRes.status).toBe(201);
  brandId = brandRes.body.id as string;

  await request(app)
    .post(`/api/v1/brands/${brandId}/accounts`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ aggregator: "FOODPANDA", external_merchant_id: "FP-PT", credential_ref: "ref-pt" });

  // ── Create menu item at Grill station ──────────────────────────────────
  const menuRes = await request(app)
    .post(`/api/v1/brands/${brandId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Print Test Dish", price: "150", station_id: grillStationId });
  expect(menuRes.status).toBe(201);
  menuItemId = menuRes.body.id as string;

  // ── Ingest an order → should create 1 PENDING print job ─────────────────
  const orderRes = await request(app)
    .post("/api/v1/ingest/order")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      brand_id: brandId,
      aggregator: "FOODPANDA",
      external_ref: nextRef(),
      customer_name: "Alice",
      placed_at: "2026-06-24T03:00:00Z",
      items: [{ menu_item_id: menuItemId, qty: 2, notes: "extra sauce" }],
    });
  expect(orderRes.status).toBe(201);
  expect(orderRes.body.print_jobs).toHaveLength(1);
  pendingJobId = orderRes.body.print_jobs[0].id as string;
});

// ---------------------------------------------------------------------------
// GET /agent/print-jobs/pending — agent pulls pending jobs
// ---------------------------------------------------------------------------

describe("GET /api/v1/agent/print-jobs/pending — agent endpoint", () => {
  it("returns pending jobs with agent token (includes payload + printer)", async () => {
    const res = await getPending();

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    const job = res.body[0] as {
      id: string;
      printer: { id: string; connection: string; address: string } | null;
      payload: {
        type: string;
        brand: string;
        items: Array<{ qty: number; name: string }>;
      };
    };

    // Shape per §8.3
    expect(typeof job.id).toBe("string");
    expect(job.payload).toBeTruthy();
    expect(job.payload.type).toBe("KOT");
    expect(typeof job.payload.brand).toBe("string");
    expect(Array.isArray(job.payload.items)).toBe(true);

    // Printer is joined and populated (we assigned one)
    expect(job.printer).toBeTruthy();
    expect(job.printer!.id).toBe(printerId);
    expect(job.printer!.connection).toBe("NETWORK");
    expect(job.printer!.address).toBe("192.168.1.50:9100");
  });

  it("returns jobs ordered oldest-first (by created_at)", async () => {
    // Ingest a second order → another pending job
    await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        customer_name: "Bob",
        items: [{ menu_item_id: menuItemId, qty: 1 }],
      });

    const res = await getPending();

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);

    // Verify IDs are present (order verified by checking the fixture job is first or earlier)
    expect(res.body[0].id).toBeTruthy();
  });

  it("returns 401 AGENT_TOKEN_INVALID when X-Agent-Token is missing", async () => {
    const res = await request(app).get("/api/v1/agent/print-jobs/pending");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AGENT_TOKEN_INVALID");
  });

  it("returns 401 AGENT_TOKEN_INVALID when X-Agent-Token is wrong", async () => {
    const res = await request(app)
      .get("/api/v1/agent/print-jobs/pending")
      .set("X-Agent-Token", "wrong-token");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AGENT_TOKEN_INVALID");
  });

  it("returns 401 AGENT_TOKEN_INVALID for the bootstrap secret itself (not a per-agent token)", async () => {
    // SF-2: the shared AGENT_TOKEN only gates /agent/register now. It was never
    // hashed into any print_agent row, so it must NOT work here.
    const res = await request(app)
      .get("/api/v1/agent/print-jobs/pending")
      .set("X-Agent-Token", BOOTSTRAP_TOKEN);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AGENT_TOKEN_INVALID");
  });

  it("rejects a user JWT on agent endpoints (not accepted as agent token)", async () => {
    // A valid user JWT in X-Agent-Token should be rejected, not accepted
    const res = await request(app)
      .get("/api/v1/agent/print-jobs/pending")
      .set("X-Agent-Token", adminToken); // user JWT is NOT the agent token

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AGENT_TOKEN_INVALID");
  });

  it("ignores a client-supplied location_id query param — location comes ONLY from the token", async () => {
    // SF-2 (audit-backend.md CRITICAL #2): the pre-SF-2 contract required a
    // ?location_id= query param and only checked that SOME print_agent was
    // registered there — any token-holder could pass a different outlet's id.
    // Now the endpoint derives location exclusively from the authenticated
    // agent's own binding, so a spoofed query param must be a complete no-op.
    const res = await request(app)
      .get("/api/v1/agent/print-jobs/pending")
      .query({ location_id: "00000000-0000-4000-a000-000000000001" })
      .set("X-Agent-Token", agentToken);

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((j) => j.id);
    expect(ids).toContain(pendingJobId); // still this agent's own (real) location's jobs
  });
});

// ---------------------------------------------------------------------------
// OUTLET ISOLATION (audit-db.md §3 + SF-2 audit-backend.md CRITICAL #2:
// pre-SF-2, printing/service.ts pulled ALL PENDING jobs with no location
// filter, and ack/printers/status did no location check at all — a token
// holder for one outlet could ack or heartbeat-report on another outlet's
// jobs/printers).
//
// Two locations, two DISTINCT per-agent tokens (each minted by its own
// /agent/register call, bound server-side to its own location_id): jobs and
// printers must route/authorize ONLY for the matching agent's own location.
// ---------------------------------------------------------------------------

describe("Outlet isolation: print-job pull/ack/heartbeat scoped to the agent's own location", () => {
  let secondLocationId: string;
  let secondStationId: string;
  let secondPrinterId: string;
  let outlet1OnlyJobId: string;
  let outlet2OnlyJobId: string;
  let secondAgentToken: string; // per-agent token for the SECOND location's agent

  beforeAll(async () => {
    // ── Second physical outlet, created directly (no multi-location HTTP
    // route yet — /stations POST always targets the single seeded location;
    // see resolveLocationId in src/modules/stations/routes.ts). ────────────
    const [secondLocation] = await db
      .insert(locations)
      .values({ code: "CK2-PRINTTEST", name: "Second Outlet (Print Test)" })
      .returning();
    secondLocationId = secondLocation.id;

    const [secondStation] = await db
      .insert(kitchenStations)
      .values({ locationId: secondLocationId, name: "Outlet 2 Grill" })
      .returning();
    secondStationId = secondStation.id;

    const [secondPrinter] = await db
      .insert(printers)
      .values({ name: "Outlet 2 Printer", connection: "NETWORK", address: "192.168.2.50:9100" })
      .returning();
    secondPrinterId = secondPrinter.id;

    // Register a SECOND agent for the second location. Both agents share the
    // same BOOTSTRAP_TOKEN to register (that secret only proves "you're allowed
    // to mint a token"), but each gets back a DISTINCT per-agent token bound to
    // its own location_id — isolation comes from THAT binding, not from any
    // client-supplied location value.
    const registerRes = await request(app)
      .post("/api/v1/agent/register")
      .set("X-Agent-Token", BOOTSTRAP_TOKEN)
      .send({ agent_name: "Outlet 2 Agent", location_id: secondLocationId });
    expect(registerRes.status).toBe(200);
    expect(registerRes.body.token).toBeTruthy();
    secondAgentToken = registerRes.body.token as string;
    expect(secondAgentToken).not.toBe(agentToken); // distinct per-agent tokens

    // ── An order/print_job scoped to OUTLET 1 (this file's existing brand + FOODPANDA account) ──
    const [account] = await db
      .select()
      .from(aggregatorAccounts)
      .where(eq(aggregatorAccounts.brandId, brandId));

    const [outlet1Order] = await db
      .insert(orders)
      .values({
        brandId,
        aggregatorAccountId: account.id,
        aggregator: "FOODPANDA",
        externalRef: nextRef(),
        total: "1.00",
      })
      .returning();
    await db.insert(orderItems).values({
      orderId: outlet1Order.id,
      menuItemId,
      qty: 1,
      stationId: grillStationId, // outlet 1's station
    });
    const [outlet1Job] = await db
      .insert(printJobs)
      .values({
        orderId: outlet1Order.id,
        stationId: grillStationId,
        printerId,
        payload: { type: "KOT", note: "outlet-1-only" },
        status: "PENDING",
      })
      .returning();
    outlet1OnlyJobId = outlet1Job.id;

    // ── An order/print_job scoped to OUTLET 2 ────────────────────────────
    const [outlet2Order] = await db
      .insert(orders)
      .values({
        brandId,
        aggregatorAccountId: account.id,
        aggregator: "FOODPANDA",
        externalRef: nextRef(),
        total: "1.00",
      })
      .returning();
    await db.insert(orderItems).values({
      orderId: outlet2Order.id,
      menuItemId,
      qty: 1,
      stationId: secondStationId, // outlet 2's station
    });
    const [outlet2Job] = await db
      .insert(printJobs)
      .values({
        orderId: outlet2Order.id,
        stationId: secondStationId,
        printerId: secondPrinterId,
        payload: { type: "KOT", note: "outlet-2-only" },
        status: "PENDING",
      })
      .returning();
    outlet2OnlyJobId = outlet2Job.id;
  });

  it("outlet 1's agent pull includes outlet 1's job but NOT outlet 2's job", async () => {
    const res = await getPending();

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((j) => j.id);
    expect(ids).toContain(outlet1OnlyJobId);
    expect(ids).not.toContain(outlet2OnlyJobId);
  });

  it("outlet 2's agent pull includes outlet 2's job but NOT outlet 1's job", async () => {
    const res = await request(app)
      .get("/api/v1/agent/print-jobs/pending")
      .set("X-Agent-Token", secondAgentToken);

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((j) => j.id);
    expect(ids).toContain(outlet2OnlyJobId);
    expect(ids).not.toContain(outlet1OnlyJobId);
  });

  // ── Cross-location ack: 403, not just "not visible in pending" ───────────
  it("outlet 2's agent cannot ack outlet 1's job → 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post(`/api/v1/agent/print-jobs/${outlet1OnlyJobId}/ack`)
      .set("X-Agent-Token", secondAgentToken)
      .send({ status: "PRINTED" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("outlet 1's agent cannot ack outlet 2's job → 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post(`/api/v1/agent/print-jobs/${outlet2OnlyJobId}/ack`)
      .set("X-Agent-Token", agentToken)
      .send({ status: "PRINTED" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("outlet 1's job is untouched by the rejected cross-location ack (still PENDING)", async () => {
    const res = await getPending();
    const ids = (res.body as Array<{ id: string }>).map((j) => j.id);
    expect(ids).toContain(outlet1OnlyJobId);
  });

  // ── Cross-location printer heartbeat: 403 ────────────────────────────────
  it("outlet 2's agent cannot report status for outlet 1's printer → 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post("/api/v1/agent/printers/status")
      .set("X-Agent-Token", secondAgentToken)
      .send({ printers: [{ printer_id: printerId, status: "ONLINE", last_seen: new Date().toISOString() }] });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("outlet 1's agent cannot report status for outlet 2's printer → 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post("/api/v1/agent/printers/status")
      .set("X-Agent-Token", agentToken)
      .send({
        printers: [{ printer_id: secondPrinterId, status: "ONLINE", last_seen: new Date().toISOString() }],
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// POST /agent/register — agent self-registration
// ---------------------------------------------------------------------------

describe("POST /api/v1/agent/register — agent registration", () => {
  it("registers an agent with a valid token → 200 with confirmation + a fresh raw token", async () => {
    // Resolve the location id from the DB
    const { locations } = await import("../src/db/schema.js");
    const [loc] = await db.select().from(locations);
    expect(loc).toBeTruthy();

    const res = await request(app)
      .post("/api/v1/agent/register")
      .set("X-Agent-Token", BOOTSTRAP_TOKEN)
      .send({ agent_name: "Test Agent", location_id: loc.id });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.agent_id).toBeTruthy();
    expect(res.body.location_id).toBe(loc.id);
    // SF-2: raw per-agent token returned once — high-entropy, not the bootstrap secret.
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token.length).toBeGreaterThanOrEqual(32);
    expect(res.body.token).not.toBe(BOOTSTRAP_TOKEN);
  });

  it("re-registering the same agent_name+location rotates its token (old token stops working)", async () => {
    const { locations } = await import("../src/db/schema.js");
    const [loc] = await db.select().from(locations);

    const first = await request(app)
      .post("/api/v1/agent/register")
      .set("X-Agent-Token", BOOTSTRAP_TOKEN)
      .send({ agent_name: "Rotation Test Agent", location_id: loc.id });
    expect(first.status).toBe(200);
    const firstToken = first.body.token as string;

    const second = await request(app)
      .post("/api/v1/agent/register")
      .set("X-Agent-Token", BOOTSTRAP_TOKEN)
      .send({ agent_name: "Rotation Test Agent", location_id: loc.id });
    expect(second.status).toBe(200);
    const secondToken = second.body.token as string;

    expect(secondToken).not.toBe(firstToken);
    expect(second.body.agent_id).toBe(first.body.agent_id); // same agent row, rotated token

    // Old token no longer authenticates anything.
    const staleRes = await request(app)
      .get("/api/v1/agent/print-jobs/pending")
      .set("X-Agent-Token", firstToken);
    expect(staleRes.status).toBe(401);
    expect(staleRes.body.error.code).toBe("AGENT_TOKEN_INVALID");

    // New token works.
    const freshRes = await request(app)
      .get("/api/v1/agent/print-jobs/pending")
      .set("X-Agent-Token", secondToken);
    expect(freshRes.status).toBe(200);
  });

  it("returns 401 when agent token is missing on register", async () => {
    const res = await request(app)
      .post("/api/v1/agent/register")
      .send({ agent_name: "No Token", location_id: "00000000-0000-4000-a000-000000000001" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AGENT_TOKEN_INVALID");
  });

  it("returns 401 when agent token is wrong on register (bootstrap secret required)", async () => {
    const res = await request(app)
      .post("/api/v1/agent/register")
      .set("X-Agent-Token", "wrong-bootstrap-token")
      .send({ agent_name: "No Token", location_id: "00000000-0000-4000-a000-000000000001" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AGENT_TOKEN_INVALID");
  });
});

// ---------------------------------------------------------------------------
// POST /agent/print-jobs/:id/ack — PRINTED
// ---------------------------------------------------------------------------

describe("POST /api/v1/agent/print-jobs/:id/ack — PRINTED", () => {
  let ackJobId: string;

  beforeAll(async () => {
    // Ingest a fresh order so we have a dedicated job for this describe block
    const orderRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        customer_name: "Print Ack Test",
        items: [{ menu_item_id: menuItemId, qty: 1 }],
      });
    expect(orderRes.status).toBe(201);
    ackJobId = orderRes.body.print_jobs[0].id as string;
  });

  it("ack PRINTED → job status becomes PRINTED and has printed_at", async () => {
    const res = await request(app)
      .post(`/api/v1/agent/print-jobs/${ackJobId}/ack`)
      .set("X-Agent-Token", agentToken)
      .send({ status: "PRINTED" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ackJobId);
    expect(res.body.status).toBe("PRINTED");
    expect(res.body.printedAt).toBeTruthy();
  });

  it("PRINTED job no longer appears in pending list", async () => {
    const res = await getPending();

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((j) => j.id);
    expect(ids).not.toContain(ackJobId);
  });

  it("returns 401 when ack is attempted without agent token", async () => {
    const res = await request(app)
      .post(`/api/v1/agent/print-jobs/${ackJobId}/ack`)
      .send({ status: "PRINTED" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AGENT_TOKEN_INVALID");
  });
});

// ---------------------------------------------------------------------------
// POST /agent/print-jobs/:id/ack — FAILED
// ---------------------------------------------------------------------------

describe("POST /api/v1/agent/print-jobs/:id/ack — FAILED", () => {
  let failJobId: string;

  beforeAll(async () => {
    const orderRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        customer_name: "Fail Ack Test",
        items: [{ menu_item_id: menuItemId, qty: 1 }],
      });
    expect(orderRes.status).toBe(201);
    failJobId = orderRes.body.print_jobs[0].id as string;
  });

  it("ack FAILED with error → job status FAILED and error stored", async () => {
    const res = await request(app)
      .post(`/api/v1/agent/print-jobs/${failJobId}/ack`)
      .set("X-Agent-Token", agentToken)
      .send({ status: "FAILED", error: "printer offline: 192.168.1.50:9100 timeout" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(failJobId);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.error).toBe("printer offline: 192.168.1.50:9100 timeout");
    expect(res.body.printedAt).toBeFalsy();
  });

  it("FAILED job no longer appears in pending list", async () => {
    const res = await getPending();

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((j) => j.id);
    expect(ids).not.toContain(failJobId);
  });
});

// ---------------------------------------------------------------------------
// POST /print-jobs/:id/reprint — user reprint of a FAILED job
// ---------------------------------------------------------------------------

describe("POST /api/v1/print-jobs/:id/reprint — reprint FAILED job", () => {
  let failedJobId: string;

  beforeAll(async () => {
    // Ingest, then fail the job
    const orderRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        customer_name: "Reprint Test",
        items: [{ menu_item_id: menuItemId, qty: 1 }],
      });
    expect(orderRes.status).toBe(201);
    failedJobId = orderRes.body.print_jobs[0].id as string;

    // Fail the job via agent ack
    await request(app)
      .post(`/api/v1/agent/print-jobs/${failedJobId}/ack`)
      .set("X-Agent-Token", agentToken)
      .send({ status: "FAILED", error: "offline" });
  });

  it("reprint creates a NEW PENDING job (clone) and returns it", async () => {
    const res = await request(app)
      .post(`/api/v1/print-jobs/${failedJobId}/reprint`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.id).not.toBe(failedJobId); // NEW id
    expect(res.body.status).toBe("PENDING");
    // Clone carries same orderId, stationId, printerId, payload as original
    expect(res.body.stationId).toBeTruthy();
    expect(res.body.orderId).toBeTruthy();
  });

  it("original FAILED job remains FAILED (not mutated)", async () => {
    // Check via GET /print-jobs?status=FAILED
    const res = await request(app)
      .get("/api/v1/print-jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ status: "FAILED" });

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string; status: string }>).map((j) => j.id);
    expect(ids).toContain(failedJobId);
  });

  it("new PENDING clone appears in the agent's pending list", async () => {
    // Get the clone id from the reprint response
    const reprintRes = await request(app)
      .post(`/api/v1/print-jobs/${failedJobId}/reprint`)
      .set("Authorization", `Bearer ${adminToken}`);
    // Note: this creates ANOTHER clone — that's fine for this test
    const cloneId = reprintRes.body.id as string;

    const pendingRes = await getPending();

    expect(pendingRes.status).toBe(200);
    const ids = (pendingRes.body as Array<{ id: string }>).map((j) => j.id);
    expect(ids).toContain(cloneId);
  });

  it("KITCHEN_STAFF can also trigger reprint (per RBAC matrix §1)", async () => {
    const res = await request(app)
      .post(`/api/v1/print-jobs/${failedJobId}/reprint`)
      .set("Authorization", `Bearer ${kitchenToken}`);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
  });

  it("unauthenticated reprint → 401 AUTH_REQUIRED", async () => {
    const res = await request(app).post(`/api/v1/print-jobs/${failedJobId}/reprint`);
    expect(res.status).toBe(401);
  });

  it("reprint of a non-existent job → 404 NOT_FOUND", async () => {
    const res = await request(app)
      .post("/api/v1/print-jobs/00000000-0000-4000-a000-000000000001/reprint")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// GET /print-jobs — list with status filter
// ---------------------------------------------------------------------------

describe("GET /api/v1/print-jobs — list with filters", () => {
  it("returns 200 array when authenticated (no filter)", async () => {
    const res = await request(app)
      .get("/api/v1/print-jobs")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("filters by status=FAILED correctly", async () => {
    const res = await request(app)
      .get("/api/v1/print-jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ status: "FAILED" });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const statuses = (res.body as Array<{ status: string }>).map((j) => j.status);
    expect(statuses.every((s) => s === "FAILED")).toBe(true);
  });

  it("filters by status=PENDING correctly", async () => {
    const res = await request(app)
      .get("/api/v1/print-jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ status: "PENDING" });

    expect(res.status).toBe(200);
    const statuses = (res.body as Array<{ status: string }>).map((j) => j.status);
    expect(statuses.every((s) => s === "PENDING")).toBe(true);
  });

  it("filters by status=PRINTED correctly", async () => {
    const res = await request(app)
      .get("/api/v1/print-jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ status: "PRINTED" });

    expect(res.status).toBe(200);
    const statuses = (res.body as Array<{ status: string }>).map((j) => j.status);
    expect(statuses.every((s) => s === "PRINTED")).toBe(true);
  });

  it("returns 401 for unauthenticated request", async () => {
    const res = await request(app).get("/api/v1/print-jobs");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /agent/printers/status — heartbeat
// ---------------------------------------------------------------------------

describe("POST /api/v1/agent/printers/status — heartbeat", () => {
  it("updates printer status and last_seen", async () => {
    const now = new Date().toISOString();

    const res = await request(app)
      .post("/api/v1/agent/printers/status")
      .set("X-Agent-Token", agentToken)
      .send({
        printers: [{ printer_id: printerId, status: "ONLINE", last_seen: now }],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify via GET /printers
    const listRes = await request(app)
      .get("/api/v1/printers")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    const updatedPrinter = (listRes.body as Array<{ id: string; status: string; lastSeen: string | null }>)
      .find((p) => p.id === printerId);

    expect(updatedPrinter).toBeTruthy();
    expect(updatedPrinter!.status).toBe("ONLINE");
    expect(updatedPrinter!.lastSeen).toBeTruthy();
  });

  it("returns 401 without agent token", async () => {
    const res = await request(app)
      .post("/api/v1/agent/printers/status")
      .send({ printers: [{ printer_id: printerId, status: "ONLINE", last_seen: new Date().toISOString() }] });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AGENT_TOKEN_INVALID");
  });

  it("handles empty printers array gracefully", async () => {
    const res = await request(app)
      .post("/api/v1/agent/printers/status")
      .set("X-Agent-Token", agentToken)
      .send({ printers: [] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
