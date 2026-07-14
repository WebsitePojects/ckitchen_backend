/**
 * Printing v2 lease protocol (D35-D46 §12) — claim / renew / conditional ack /
 * bounded retries / immutable attempt history / virtual spool sink.
 *
 * CLAIMED is derived (status=PENDING AND lease_until>now): claimed jobs vanish
 * from BOTH the v1 pending pull and further v2 claims until the lease lapses.
 * Fixture mirrors test/printing.test.ts (register agent via bootstrap token,
 * printer + brand + menu item + ingest order -> PENDING job per order).
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createDb, closeDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { createApp } from "../src/app.js";
import { kitchenStations, printJobAttempts, printJobs, printers } from "../src/db/schema.js";
import { operationalFeatureFlags } from "../src/db/enterprise-schema.js";
import {
  MAX_PRINT_ATTEMPTS,
  claimJobs,
  contentHashOf,
} from "../src/modules/printing/service-v2.js";

let app: Express;
let db: DB;
let client: unknown;
let adminToken: string;
let agentToken: string;
let grillStationId: string;
let locationId: string;
let printerId: string;
let brandId: string;
let menuItemId: string;

const BOOTSTRAP_TOKEN = "test-agent-token";
let _refSeq = 0;
const nextRef = () => `PV2-${Date.now()}-${++_refSeq}`;

async function setSpooling(enabled: boolean): Promise<void> {
  await db.update(operationalFeatureFlags).set({ enabled }).where(eq(operationalFeatureFlags.key, "printing.spooling"));
}

/** Ingests one order for the fixture menu item; returns its PENDING print-job id. */
async function ingestJob(): Promise<string> {
  const res = await request(app)
    .post("/api/v1/ingest/order")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      brand_id: brandId,
      aggregator: "FOODPANDA",
      external_ref: nextRef(),
      customer_name: "Lease Tester",
      placed_at: new Date().toISOString(),
      items: [{ menu_item_id: menuItemId, qty: 1 }],
    });
  expect(res.status).toBe(201);
  expect(res.body.print_jobs).toHaveLength(1);
  return res.body.print_jobs[0].id as string;
}

function agentPost(path: string) {
  return request(app).post(path).set("X-Agent-Token", agentToken);
}

async function claimOne(expectId?: string) {
  const res = await agentPost("/api/v1/agent/print-jobs/claim").send({ limit: 20 });
  expect(res.status).toBe(200);
  if (expectId) {
    const match = res.body.jobs.find((j: { id: string }) => j.id === expectId);
    expect(match).toBeTruthy();
    return match;
  }
  return res.body.jobs;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await seed(db);
  app = createApp(db);

  const login = await request(app).post("/api/v1/auth/login").send({ email: "admin@cloudkitchen.local", password: "admin123" });
  adminToken = login.body.token as string;

  const stations = await db.select().from(kitchenStations);
  const grill = stations.find((s) => s.name === "Grill");
  if (!grill) throw new Error("Grill station not seeded");
  grillStationId = grill.id;
  locationId = grill.locationId;

  const reg = await request(app)
    .post("/api/v1/agent/register")
    .set("X-Agent-Token", BOOTSTRAP_TOKEN)
    .send({ agent_name: "Printing V2 Agent", location_id: locationId });
  expect(reg.status).toBe(200);
  agentToken = reg.body.token as string;

  const printerRes = await request(app)
    .post("/api/v1/printers")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "V2 Grill Printer", connection: "NETWORK", address: "192.168.1.60:9100" });
  expect(printerRes.status).toBe(201);
  printerId = printerRes.body.id as string;
  await db.update(kitchenStations).set({ defaultPrinterId: printerId }).where(eq(kitchenStations.id, grillStationId));

  const brandRes = await request(app)
    .post("/api/v1/brands")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "PV2 Brand", color: "#22CC88" });
  brandId = brandRes.body.id as string;
  await request(app)
    .post(`/api/v1/brands/${brandId}/accounts`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ aggregator: "FOODPANDA", external_merchant_id: "FP-PV2", credential_ref: "ref-pv2" });
  const menuRes = await request(app)
    .post(`/api/v1/brands/${brandId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "PV2 Dish", price: "120", station_id: grillStationId });
  menuItemId = menuRes.body.id as string;
});

afterAll(async () => {
  await closeDb(client as { close?: () => Promise<void> });
});

describe("printing v2 lease protocol", () => {
  it("claim endpoint refuses with FEATURE_DISABLED while printing.spooling is OFF", async () => {
    await setSpooling(false);
    const res = await agentPost("/api/v1/agent/print-jobs/claim").send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("FEATURE_DISABLED");
    await setSpooling(true);
  });

  it("claims a PENDING job with a lease and hides it from the v1 pending pull + further claims", async () => {
    const jobId = await ingestJob();
    const claimedJob = await claimOne(jobId);
    expect(claimedJob.lease_token).toBeTruthy();
    expect(new Date(claimedJob.lease_until).getTime()).toBeGreaterThan(Date.now());

    const v1 = await request(app).get("/api/v1/agent/print-jobs/pending").set("X-Agent-Token", agentToken);
    expect(v1.status).toBe(200);
    // v1 pending returns a bare array (routes.ts res.json(jobs))
    expect((v1.body as Array<{ id: string }>).map((j) => j.id)).not.toContain(jobId);

    const again = await agentPost("/api/v1/agent/print-jobs/claim").send({ limit: 20 });
    expect(again.body.jobs.map((j: { id: string }) => j.id)).not.toContain(jobId);

    // Clean up: PRINTED-ack so the job doesn't pollute later claims.
    const ack = await agentPost(`/api/v1/agent/print-jobs/${jobId}/ack-v2`).send({ lease_token: claimedJob.lease_token, result: "PRINTED" });
    expect(ack.status).toBe(200);
  });

  it("renews only a live lease with the exact token", async () => {
    const jobId = await ingestJob();
    const claimedJob = await claimOne(jobId);

    const wrong = await agentPost(`/api/v1/agent/print-jobs/${jobId}/lease/renew`).send({ lease_token: "not-the-token" });
    expect(wrong.status).toBe(400);

    const right = await agentPost(`/api/v1/agent/print-jobs/${jobId}/lease/renew`).send({ lease_token: claimedJob.lease_token, lease_seconds: 120 });
    expect(right.status).toBe(200);
    expect(new Date(right.body.lease_until).getTime()).toBeGreaterThan(Date.now() + 60_000);

    await agentPost(`/api/v1/agent/print-jobs/${jobId}/ack-v2`).send({ lease_token: claimedJob.lease_token, result: "PRINTED" });
  });

  it("PRINTED ack resolves the job, appends an attempt row, and an exact replay is idempotent", async () => {
    const jobId = await ingestJob();
    const claimedJob = await claimOne(jobId);

    const first = await agentPost(`/api/v1/agent/print-jobs/${jobId}/ack-v2`).send({ lease_token: claimedJob.lease_token, result: "PRINTED" });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("PRINTED");

    const replay = await agentPost(`/api/v1/agent/print-jobs/${jobId}/ack-v2`).send({ lease_token: claimedJob.lease_token, result: "PRINTED" });
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("PRINTED");

    const conflicting = await agentPost(`/api/v1/agent/print-jobs/${jobId}/ack-v2`).send({ lease_token: claimedJob.lease_token, result: "FAILED", error: "late lie" });
    expect(conflicting.status).toBe(400);

    const attempts = await db.select().from(printJobAttempts).where(eq(printJobAttempts.printJobId, jobId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.result).toBe("PRINTED");
  });

  it("refuses an ack whose content_hash does not match the enqueued payload", async () => {
    const jobId = await ingestJob();
    const [row] = await db.select().from(printJobs).where(eq(printJobs.id, jobId));
    await db.update(printJobs).set({ contentHash: contentHashOf(row!.payload) }).where(eq(printJobs.id, jobId));
    const claimedJob = await claimOne(jobId);

    const bad = await agentPost(`/api/v1/agent/print-jobs/${jobId}/ack-v2`).send({
      lease_token: claimedJob.lease_token,
      result: "PRINTED",
      content_hash: "0".repeat(64),
    });
    expect(bad.status).toBe(400);

    const good = await agentPost(`/api/v1/agent/print-jobs/${jobId}/ack-v2`).send({
      lease_token: claimedJob.lease_token,
      result: "PRINTED",
      content_hash: contentHashOf(row!.payload),
    });
    expect(good.status).toBe(200);
  });

  it("a stale token cannot ack after the lease lapses and is re-claimed (attempt history records LEASE_EXPIRED)", async () => {
    const jobId = await ingestJob();
    const firstClaim = await claimOne(jobId);
    // Force-lapse the lease (no 60s wait) — service treats it as expired.
    await db.update(printJobs).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(printJobs.id, jobId));

    const secondClaim = await claimOne(jobId);
    expect(secondClaim.lease_token).not.toBe(firstClaim.lease_token);

    const stale = await agentPost(`/api/v1/agent/print-jobs/${jobId}/ack-v2`).send({ lease_token: firstClaim.lease_token, result: "PRINTED" });
    expect(stale.status).toBe(400);

    const expired = await db
      .select()
      .from(printJobAttempts)
      .where(and(eq(printJobAttempts.printJobId, jobId), eq(printJobAttempts.result, "LEASE_EXPIRED")));
    expect(expired).toHaveLength(1);

    await agentPost(`/api/v1/agent/print-jobs/${jobId}/ack-v2`).send({ lease_token: secondClaim.lease_token, result: "PRINTED" });
  });

  it("bounded retries: after MAX_PRINT_ATTEMPTS FAILED acks the job is terminal FAILED and unclaimable", async () => {
    const jobId = await ingestJob();
    for (let attempt = 1; attempt <= MAX_PRINT_ATTEMPTS; attempt++) {
      const claimedJob = await claimOne(jobId);
      const res = await agentPost(`/api/v1/agent/print-jobs/${jobId}/ack-v2`).send({
        lease_token: claimedJob.lease_token,
        result: "FAILED",
        error: `paper jam #${attempt}`,
      });
      expect(res.status).toBe(200);
    }
    const [job] = await db.select().from(printJobs).where(eq(printJobs.id, jobId));
    expect(job!.status).toBe("FAILED");
    expect(job!.retries).toBe(MAX_PRINT_ATTEMPTS);

    const claims = await agentPost("/api/v1/agent/print-jobs/claim").send({ limit: 20 });
    expect(claims.body.jobs.map((j: { id: string }) => j.id)).not.toContain(jobId);

    const attempts = await db.select().from(printJobAttempts).where(eq(printJobAttempts.printJobId, jobId));
    expect(attempts).toHaveLength(MAX_PRINT_ATTEMPTS);
  });

  it("FAILED ack without an error message is refused", async () => {
    const jobId = await ingestJob();
    const claimedJob = await claimOne(jobId);
    const res = await agentPost(`/api/v1/agent/print-jobs/${jobId}/ack-v2`).send({ lease_token: claimedJob.lease_token, result: "FAILED" });
    expect(res.status).toBe(400);
    await agentPost(`/api/v1/agent/print-jobs/${jobId}/ack-v2`).send({ lease_token: claimedJob.lease_token, result: "PRINTED" });
  });

  it("attempt history is append-only at the database layer", async () => {
    const [any] = await db.select().from(printJobAttempts).limit(1);
    expect(any).toBeTruthy();
    await expect(
      db.update(printJobAttempts).set({ error: "tampered" }).where(eq(printJobAttempts.id, any!.id)),
    ).rejects.toThrow();
  });

  it("capability filter only claims matching jobs", async () => {
    const jobId = await ingestJob(); // fixture jobs are ESC_POS_KOT
    const none = await agentPost("/api/v1/agent/print-jobs/claim").send({ capability: "WINDOWS_DOCUMENT", limit: 20 });
    expect(none.body.jobs.map((j: { id: string }) => j.id)).not.toContain(jobId);
    const claimedJob = await claimOne(jobId);
    await agentPost(`/api/v1/agent/print-jobs/${jobId}/ack-v2`).send({ lease_token: claimedJob.lease_token, result: "PRINTED" });
  });

  it("virtual spool sink prints every claimable job on a VIRTUAL-transport printer (§12 verification substitute)", async () => {
    await db.update(printers).set({ transport: "VIRTUAL" }).where(eq(printers.id, printerId));
    const jobId = await ingestJob();

    const run = await request(app)
      .post("/api/v1/print-jobs/virtual-spool/run")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ location_id: locationId });
    expect(run.status).toBe(200);
    expect(run.body.printed).toBeGreaterThanOrEqual(1);

    const [job] = await db.select().from(printJobs).where(eq(printJobs.id, jobId));
    expect(job!.status).toBe("PRINTED");
    await db.update(printers).set({ transport: "PHYSICAL" }).where(eq(printers.id, printerId));
  });

  it("service-level claim excludes other locations' jobs entirely", async () => {
    const jobId = await ingestJob();
    const elsewhere = await claimJobs(db, "00000000-0000-0000-0000-000000000000");
    expect(elsewhere.map((j) => j.id)).not.toContain(jobId);
    const claimedJob = await claimOne(jobId);
    await agentPost(`/api/v1/agent/print-jobs/${jobId}/ack-v2`).send({ lease_token: claimedJob.lease_token, result: "PRINTED" });
  });
});
