/**
 * Webhook intake tests (spec §11 — src/modules/middleware/routes.ts POST
 * /api/v1/middleware/webhook). Covers signature/timestamp/key-id
 * verification against the EXACT raw bytes, and the persist-before-ack
 * idempotency contract: same event id + same hash = replay (no new row);
 * same event id + different hash = quarantine; unverified requests never
 * write a row at all.
 *
 * Deliberately does NOT exercise processing (resolving a listing / calling
 * ingestOrder) — that is test/middleware-processing.test.ts's job. Intake
 * only needs syntactically valid payloads (a well-formed UUID for
 * menu_item_id), never a real menu item, brand, or aggregator account.
 */
import { randomUUID, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, closeDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { providerEvents } from "../src/db/middleware-schema.js";

const TEST_SECRET = "test-middleware-webhook-secret";
const TEST_KEY_ID = "dummy-key-v1";
const WEBHOOK_PATH = "/api/v1/middleware/webhook";

let app: Express;
let db: DB;
let client: ReturnType<typeof createDb>["client"];

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);
  app = createApp(db);
});

afterAll(async () => {
  await closeDb(client);
});

function nowTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

function sign(rawBytes: Buffer, timestamp: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(Buffer.from(`${timestamp}.`, "utf8"));
  hmac.update(rawBytes);
  return hmac.digest("hex");
}

interface EnvelopeOverrides {
  event_id?: string;
  event_type?: "ORDER_CREATED" | "ORDER_CANCELLED";
  occurred_at?: string;
  aggregator?: "FOODPANDA" | "GRABFOOD" | "OTHER";
  merchant_id?: string;
  order?: {
    external_ref: string;
    customer_name?: string;
    placed_at?: string;
    items?: Array<{ menu_item_id: string; qty: number; notes?: string }>;
  };
}

function buildEnvelope(overrides: EnvelopeOverrides = {}): Buffer {
  const envelope = {
    event_id: overrides.event_id ?? randomUUID(),
    event_type: overrides.event_type ?? "ORDER_CREATED",
    occurred_at: overrides.occurred_at ?? new Date().toISOString(),
    aggregator: overrides.aggregator ?? "FOODPANDA",
    merchant_id: overrides.merchant_id ?? "FP-INTAKE-TEST",
    order: overrides.order ?? {
      external_ref: `EXT-${randomUUID()}`,
      items: [{ menu_item_id: randomUUID(), qty: 1 }],
    },
  };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

function post(rawBody: Buffer, headers: { timestamp?: string; keyId?: string; signature?: string; provider?: string }) {
  let req = request(app).post(WEBHOOK_PATH).set("Content-Type", "application/json");
  if (headers.timestamp !== undefined) req = req.set("X-Middleware-Timestamp", headers.timestamp);
  if (headers.keyId !== undefined) req = req.set("X-Middleware-Key-Id", headers.keyId);
  if (headers.signature !== undefined) req = req.set("X-Middleware-Signature", headers.signature);
  if (headers.provider !== undefined) req = req.set("X-Middleware-Provider", headers.provider);
  return req.send(rawBody.toString("utf8"));
}

async function signedPost(rawBody: Buffer, opts: { timestamp?: string; secret?: string; keyId?: string } = {}) {
  const timestamp = opts.timestamp ?? nowTimestamp();
  const secret = opts.secret ?? TEST_SECRET;
  const keyId = opts.keyId ?? TEST_KEY_ID;
  const signature = sign(rawBody, timestamp, secret);
  return post(rawBody, { timestamp, keyId, signature });
}

async function eventCount(): Promise<number> {
  const rows = await db.select({ id: providerEvents.id }).from(providerEvents);
  return rows.length;
}

describe("middleware webhook intake", () => {
  it("persists a PENDING row and acks 202 for a validly signed new event", async () => {
    const eventId = randomUUID();
    const body = buildEnvelope({ event_id: eventId });
    const before = await eventCount();
    const res = await signedPost(body);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("CREATED");
    expect(await eventCount()).toBe(before + 1);

    const [row] = await db.select().from(providerEvents).where(eq(providerEvents.providerEventId, eventId));
    expect(row).toBeDefined();
    expect(row!.state).toBe("PENDING");
    expect(row!.provider).toBe("DUMMY");
    expect(row!.rawHash).toHaveLength(64);
  });

  it("rejects an invalid signature with 401 and persists no row", async () => {
    const eventId = randomUUID();
    const body = buildEnvelope({ event_id: eventId });
    const before = await eventCount();
    const timestamp = nowTimestamp();
    const res = await post(body, { timestamp, keyId: TEST_KEY_ID, signature: "0".repeat(64) });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_SIGNATURE");
    expect(await eventCount()).toBe(before);
  });

  it("rejects a stale timestamp with 401 and persists no row", async () => {
    const eventId = randomUUID();
    const body = buildEnvelope({ event_id: eventId });
    const before = await eventCount();
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600); // 1h old, default skew is 300s
    const res = await signedPost(body, { timestamp: staleTimestamp });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_TIMESTAMP");
    expect(await eventCount()).toBe(before);
  });

  it("rejects a future timestamp outside the skew window with 401", async () => {
    const body = buildEnvelope();
    const futureTimestamp = String(Math.floor(Date.now() / 1000) + 3600);
    const res = await signedPost(body, { timestamp: futureTimestamp });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_TIMESTAMP");
  });

  it("rejects an unrecognized key id with 401 and persists no row", async () => {
    const body = buildEnvelope();
    const before = await eventCount();
    const res = await signedPost(body, { keyId: "some-unknown-key" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNKNOWN_KEY_ID");
    expect(await eventCount()).toBe(before);
  });

  it("accepts a signature computed against the PREVIOUS secret during rotation overlap", async () => {
    const previousSecret = "previous-rotation-secret";
    process.env.MIDDLEWARE_WEBHOOK_SECRET_PREVIOUS = previousSecret;
    try {
      const body = buildEnvelope();
      const res = await signedPost(body, { secret: previousSecret });
      expect(res.status).toBe(202);
      expect(res.body.status).toBe("CREATED");
    } finally {
      delete process.env.MIDDLEWARE_WEBHOOK_SECRET_PREVIOUS;
    }
  });

  it("rejects a signature from neither current nor previous secret", async () => {
    process.env.MIDDLEWARE_WEBHOOK_SECRET_PREVIOUS = "previous-rotation-secret";
    try {
      const body = buildEnvelope();
      const res = await signedPost(body, { secret: "some-totally-wrong-secret" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_SIGNATURE");
    } finally {
      delete process.env.MIDDLEWARE_WEBHOOK_SECRET_PREVIOUS;
    }
  });

  it("fails signature verification when the raw body is mutated after signing (raw-byte exactness)", async () => {
    const body = buildEnvelope();
    const timestamp = nowTimestamp();
    const signature = sign(body, timestamp, TEST_SECRET);
    // Flip one byte in the (still syntactically-plausible) JSON body — the
    // signature was computed over the ORIGINAL bytes, so this must fail even
    // though the mutated body may still parse as valid-looking JSON.
    const mutated = Buffer.from(body.toString("utf8").replace('"qty":1', '"qty":9'), "utf8");
    const res = await post(mutated, { timestamp, keyId: TEST_KEY_ID, signature });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_SIGNATURE");
  });

  it("returns 400 EMPTY_BODY for an empty request body", async () => {
    const timestamp = nowTimestamp();
    const signature = sign(Buffer.alloc(0), timestamp, TEST_SECRET);
    const res = await post(Buffer.alloc(0), { timestamp, keyId: TEST_KEY_ID, signature });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("EMPTY_BODY");
  });

  it("returns 400 MISSING_HEADER when a required header is absent", async () => {
    const body = buildEnvelope();
    const res = await post(body, { timestamp: nowTimestamp(), signature: sign(body, nowTimestamp(), TEST_SECRET) }); // keyId omitted
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_HEADER");
  });

  it("returns 400 MALFORMED_PAYLOAD for a validly signed but non-JSON body", async () => {
    const body = Buffer.from("not json at all", "utf8");
    const res = await signedPost(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MALFORMED_PAYLOAD");
  });

  it("returns 400 MALFORMED_PAYLOAD for a well-signed body that fails the DUMMY envelope schema", async () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    const res = await signedPost(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MALFORMED_PAYLOAD");
  });

  it("is an idempotent no-op replay when the same event id arrives again with the SAME raw bytes", async () => {
    const eventId = randomUUID();
    const body = buildEnvelope({ event_id: eventId });
    const first = await signedPost(body);
    expect(first.status).toBe(202);
    const before = await eventCount();

    const second = await signedPost(body);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("DUPLICATE");
    expect(await eventCount()).toBe(before); // no new row
    expect(second.body.event.id).toBe(first.body.event.id);
  });

  it("quarantines a replayed event id whose raw bytes hash differently", async () => {
    const eventId = randomUUID();
    const externalRef = `EXT-${randomUUID()}`;
    const first = buildEnvelope({ event_id: eventId, order: { external_ref: externalRef, items: [{ menu_item_id: randomUUID(), qty: 1 }] } });
    const firstRes = await signedPost(first);
    expect(firstRes.status).toBe(202);
    const before = await eventCount();

    const second = buildEnvelope({ event_id: eventId, order: { external_ref: externalRef, items: [{ menu_item_id: randomUUID(), qty: 5 }] } });
    const secondRes = await signedPost(second);
    expect(secondRes.status).toBe(200);
    expect(secondRes.body.status).toBe("QUARANTINED");
    expect(await eventCount()).toBe(before); // no NEW row — the existing row transitioned

    const [row] = await db.select().from(providerEvents).where(eq(providerEvents.providerEventId, eventId));
    expect(row!.state).toBe("QUARANTINED");
  });

  it("rejects an unregistered provider name with 400", async () => {
    const body = buildEnvelope();
    const timestamp = nowTimestamp();
    const signature = sign(body, timestamp, TEST_SECRET);
    const res = await post(body, { timestamp, keyId: TEST_KEY_ID, signature, provider: "SOME_UNKNOWN_VENDOR" });
    expect(res.status).toBe(400);
  });
});
