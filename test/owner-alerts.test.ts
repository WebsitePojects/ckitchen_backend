/**
 * Owner email alerts (migration 0044): low stock, orders nobody started, orders cooking too
 * long. Each problem is emailed once, re-alerted only after it clears and recurs, and every
 * email is delivered exactly once per idempotency key with bounded retries.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { alertEmails, alertEvents, inventoryStock, orders, users, warehouses } from "../src/db/schema.js";
import { readAlertSettings, type AlertSettings } from "../src/modules/alerts/config.js";
import { composeAlertDigest } from "../src/modules/alerts/compose.js";
import { deliverAlertEmails, MAX_ATTEMPTS } from "../src/modules/alerts/deliver.js";
import { renderAlertDigest } from "../src/modules/alerts/render.js";
import { createResendSender, type OutgoingEmail, type SendEmail, type SendOutcome } from "../src/modules/alerts/resend.js";
import { scanForAlerts } from "../src/modules/alerts/scan.js";
import { buildWorkers } from "../src/scripts/run-workers.js";

let app: Express;
let db: DB;
let token: string;
let brandId: string;
let accountId: string;
let menuItemId: string;
let kitchenWarehouseId: string;
let mainWarehouseId: string;

const settings: AlertSettings = {
  resendApiKey: "re_test_key",
  from: "ORION Alerts <alerts@example.com>",
  extraRecipients: ["ops@example.com"],
  appUrl: "https://app.example.com",
  unattendedMinutes: 15,
  stuckMinutes: 60,
};

const auth = () => ({ Authorization: `Bearer ${token}` });
const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);

interface SentCall {
  email: OutgoingEmail;
  key: string;
}
function fakeSender(outcomes: SendOutcome[] = []): SendEmail & { calls: SentCall[] } {
  const calls: SentCall[] = [];
  const fn = (async (_key: string, email: OutgoingEmail, idempotencyKey: string) => {
    calls.push({ email, key: idempotencyKey });
    return outcomes.shift() ?? { ok: true, providerMessageId: `msg-${calls.length}` };
  }) as SendEmail & { calls: SentCall[] };
  fn.calls = calls;
  return fn;
}

async function makeIngredient(name: string, threshold: number): Promise<string> {
  const res = await request(app).post("/api/v1/ingredients").set(auth()).send({ name, unit: "kg", unit_cost: 10, low_stock_threshold: threshold });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function setStock(warehouseId: string, ingredientId: string, quantity: number): Promise<string> {
  const [row] = await db
    .insert(inventoryStock)
    .values({ warehouseId, ingredientId, quantity: String(quantity) })
    .onConflictDoUpdate({ target: [inventoryStock.warehouseId, inventoryStock.ingredientId], set: { quantity: String(quantity) } })
    .returning({ id: inventoryStock.id });
  return row!.id;
}

let refSeq = 0;
async function placeOrder(placedAt: Date): Promise<string> {
  refSeq += 1;
  const res = await request(app)
    .post("/api/v1/ingest/order")
    .set(auth())
    .send({
      brand_id: brandId,
      aggregator: "GRABFOOD",
      aggregator_account_id: accountId,
      external_ref: `ALERT-${refSeq}`,
      placed_at: placedAt.toISOString(),
      items: [{ menu_item_id: menuItemId, qty: 1 }],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.order_id as string;
}

const openEvents = (kind?: string) =>
  db
    .select()
    .from(alertEvents)
    .then((rows) => rows.filter((r) => r.resolvedAt === null && (!kind || r.kind === kind)));

beforeAll(async () => {
  db = createDb().db;
  await seed(db);
  app = createApp(db);
  token = (await request(app).post("/api/v1/auth/login").send({ email: "admin@cloudkitchen.local", password: "admin123" })).body.token;

  const stations = (await request(app).get("/api/v1/stations").set(auth())).body as Array<{ id: string }>;
  brandId = (await request(app).post("/api/v1/brands").set(auth()).send({ name: "Alert Brand", color: "#225588" })).body.id;
  accountId = (
    await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set(auth())
      .send({ aggregator: "GRABFOOD", external_merchant_id: "ALERT-GF", credential_ref: "ref-alert" })
  ).body.id;
  menuItemId = (await request(app).post(`/api/v1/brands/${brandId}/menu`).set(auth()).send({ name: "Alert Bowl", price: "150", station_id: stations[0]!.id })).body.id;

  await db.insert(users).values({ name: "Real Owner", email: "owner@kitchen-alerts.ph", passwordHash: "x", role: "OWNER" });

  const all = await db.select().from(warehouses);
  kitchenWarehouseId = all.find((w) => w.type === "KITCHEN")!.id;
  mainWarehouseId = all.find((w) => w.type === "MAIN" && w.locationId === all.find((k) => k.id === kitchenWarehouseId)!.locationId)!.id;
}, 60_000);

beforeEach(async () => {
  await db.delete(alertEvents);
  await db.delete(alertEmails);
});

describe("alert settings", () => {
  it("is off without a key, and refuses a half-configured setup instead of guessing", () => {
    expect(readAlertSettings({})).toEqual({ ok: false, reason: "RESEND_API_KEY not set" });
    expect(readAlertSettings({ RESEND_API_KEY: "re_x" }).ok).toBe(false);
    expect(readAlertSettings({ RESEND_API_KEY: "re_x", ALERT_EMAIL_FROM: "not an email" }).ok).toBe(false);
    expect(readAlertSettings({ RESEND_API_KEY: "re_x", ALERT_EMAIL_FROM: "a@b.co", ALERT_EMAIL_TO: "x@y.co, nope" }).ok).toBe(false);
    expect(readAlertSettings({ RESEND_API_KEY: "re_x", ALERT_EMAIL_FROM: "a@b.co", ALERT_ORDER_STUCK_MINUTES: "0" }).ok).toBe(false);
  });

  it("accepts a named sender and applies the default thresholds", () => {
    const result = readAlertSettings({ RESEND_API_KEY: "re_x", ALERT_EMAIL_FROM: "ORION Alerts <alerts@orion.example.com>", ALERT_APP_URL: "https://app.example.com/" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.unattendedMinutes).toBe(15);
    expect(result.settings.stuckMinutes).toBe(60);
    expect(result.settings.appUrl).toBe("https://app.example.com");
  });

  it("the worker list includes owner-alerts only when configured", () => {
    expect(buildWorkers({}).skipped.some((s) => s.startsWith("owner-alerts"))).toBe(true);
    const on = buildWorkers({ RESEND_API_KEY: "re_x", ALERT_EMAIL_FROM: "a@b.co" });
    expect(on.workers.map((w) => w.name)).toContain("owner-alerts");
  });
});

describe("low stock", () => {
  it("alerts once per episode, resolves when restocked, and alerts again on the next dip", async () => {
    const now = new Date();
    const ingredientId = await makeIngredient("Alert Chicken", 5);
    const stockId = await setStock(kitchenWarehouseId, ingredientId, 3);

    expect((await scanForAlerts(db, settings, now)).opened).toBeGreaterThanOrEqual(1);
    expect((await scanForAlerts(db, settings, now)).opened).toBe(0); // repeat scan: no new alert
    expect((await openEvents("LOW_STOCK")).filter((e) => e.subjectId === stockId)).toHaveLength(1);

    await setStock(kitchenWarehouseId, ingredientId, 10);
    await scanForAlerts(db, settings, now);
    expect((await openEvents("LOW_STOCK")).some((e) => e.subjectId === stockId)).toBe(false);

    await setStock(kitchenWarehouseId, ingredientId, 2);
    await scanForAlerts(db, settings, now);
    const history = (await db.select().from(alertEvents)).filter((e) => e.subjectId === stockId);
    expect(history).toHaveLength(2);
    expect(history.filter((e) => e.resolvedAt === null)).toHaveLength(1);
  });

  it("ignores untracked items (threshold 0) and the MAIN warehouse", async () => {
    const untracked = await makeIngredient("Alert Untracked", 0);
    const untrackedStock = await setStock(kitchenWarehouseId, untracked, 0);
    const mainOnly = await makeIngredient("Alert Main Only", 5);
    const mainStock = await setStock(mainWarehouseId, mainOnly, 1);
    await setStock(kitchenWarehouseId, mainOnly, 50);

    await scanForAlerts(db, settings, new Date());
    const subjects = (await openEvents()).map((e) => e.subjectId);
    expect(subjects).not.toContain(untrackedStock);
    expect(subjects).not.toContain(mainStock);
  });

  it("concurrent scans open one alert, not two", async () => {
    const ingredientId = await makeIngredient("Alert Race", 4);
    const stockId = await setStock(kitchenWarehouseId, ingredientId, 1);
    const now = new Date();
    await Promise.all([scanForAlerts(db, settings, now), scanForAlerts(db, settings, now)]);
    expect((await openEvents()).filter((e) => e.subjectId === stockId)).toHaveLength(1);
  });
});

describe("orders left unattended or stuck", () => {
  it("alerts on an order still NEW after 15 minutes, not on a fresh or a day-old one", async () => {
    const now = new Date();
    const late = await placeOrder(minutesAgo(now, 20));
    const fresh = await placeOrder(minutesAgo(now, 5));
    const ancient = await placeOrder(minutesAgo(now, 30 * 60));

    await scanForAlerts(db, settings, now);
    const subjects = (await openEvents("ORDER_UNATTENDED")).map((e) => e.subjectId);
    expect(subjects).toContain(late);
    expect(subjects).not.toContain(fresh);
    expect(subjects).not.toContain(ancient);
  });

  it("starting the order resolves it; cooking past 60 minutes raises a stuck alert", async () => {
    const now = new Date();
    const orderId = await placeOrder(minutesAgo(now, 90));
    await scanForAlerts(db, settings, now);
    expect((await openEvents("ORDER_UNATTENDED")).map((e) => e.subjectId)).toContain(orderId);

    await db.update(orders).set({ status: "PREPARING", prepAt: minutesAgo(now, 70) }).where(eq(orders.id, orderId));
    await scanForAlerts(db, settings, now);
    expect((await openEvents("ORDER_UNATTENDED")).map((e) => e.subjectId)).not.toContain(orderId);
    expect((await openEvents("ORDER_STUCK")).map((e) => e.subjectId)).toContain(orderId);

    await db.update(orders).set({ status: "READY", readyAt: now }).where(eq(orders.id, orderId));
    await scanForAlerts(db, settings, now);
    expect((await openEvents("ORDER_STUCK")).map((e) => e.subjectId)).not.toContain(orderId);
  });
});

describe("digest composing", () => {
  it("puts every new alert into one email, once, addressed to owners plus ALERT_EMAIL_TO", async () => {
    const now = new Date();
    await placeOrder(minutesAgo(now, 25));
    await setStock(kitchenWarehouseId, await makeIngredient("Alert Rice", 8), 2);
    await scanForAlerts(db, settings, now);

    const [a, b] = await Promise.all([composeAlertDigest(db, settings, now), composeAlertDigest(db, settings, now)]);
    expect([a, b].filter((r) => r.composed)).toHaveLength(1);
    expect((await composeAlertDigest(db, settings, now)).composed).toBe(false);

    const emails = await db.select().from(alertEmails);
    expect(emails).toHaveLength(1);
    // The seeded owner (admin@cloudkitchen.local) is a reserved, undeliverable domain: never emailed.
    expect(emails[0]!.recipients).toEqual(["owner@kitchen-alerts.ph", "ops@example.com"]);
    expect(emails[0]!.subject).toMatch(/order.* not started/);
    expect(emails[0]!.subject).toMatch(/low on stock/);
    expect((await db.select().from(alertEvents)).every((e) => e.emailId === emails[0]!.id)).toBe(true);
  });

  it("waits (does not drop alerts) while there is nobody to send to", async () => {
    const now = new Date();
    await setStock(kitchenWarehouseId, await makeIngredient("Alert Nobody", 9), 1);
    await scanForAlerts(db, settings, now);
    await db.update(users).set({ status: "BLOCKED" }).where(eq(users.role, "OWNER"));
    try {
      expect(await composeAlertDigest(db, { ...settings, extraRecipients: [] }, now)).toEqual({ composed: false, reason: "no_recipients" });
    } finally {
      await db.update(users).set({ status: "ACTIVE" }).where(eq(users.role, "OWNER"));
    }
    expect((await composeAlertDigest(db, settings, now)).composed).toBe(true);
  });

  it("escapes names typed by staff before they reach the HTML email", () => {
    const rendered = renderAlertDigest(
      [{ kind: "LOW_STOCK", details: { item: `<script>alert(1)</script>`, outlet: `O"Brien & Co`, quantity: "1", threshold: "5", unit: "kg" } }],
      { now: new Date(), timezone: "Asia/Manila", appUrl: null },
    );
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("O&quot;Brien &amp; Co");
    expect(rendered.subject).toBe("ORION alert: 1 item low on stock");
  });
});

describe("delivery", () => {
  async function queuedEmail(now: Date): Promise<string> {
    await setStock(kitchenWarehouseId, await makeIngredient(`Alert Deliver ${Math.random()}`, 5), 1);
    await scanForAlerts(db, settings, now);
    const composed = await composeAlertDigest(db, settings, now);
    if (!composed.composed) throw new Error("expected an email");
    return composed.emailId;
  }
  const emailRow = async (id: string) => (await db.select().from(alertEmails).where(eq(alertEmails.id, id)))[0]!;

  it("sends once with the email id as Idempotency-Key, and never again", async () => {
    const now = new Date();
    const id = await queuedEmail(now);
    const send = fakeSender();
    const [r1, r2] = await Promise.all([deliverAlertEmails(db, settings, send, now), deliverAlertEmails(db, settings, send, now)]);
    expect(r1.sent + r2.sent).toBe(1);
    await deliverAlertEmails(db, settings, send, now);
    expect(send.calls).toHaveLength(1);
    expect(send.calls[0]!.key).toBe(id);
    expect(send.calls[0]!.email.from).toBe(settings.from);
    const row = await emailRow(id);
    expect(row.status).toBe("SENT");
    expect(row.providerMessageId).toBe("msg-1");
  });

  it("retries a provider outage later with the identical request, then gives up after the cap", async () => {
    const now = new Date();
    const id = await queuedEmail(now);
    const outage: SendOutcome = { ok: false, retryable: true, message: "Resend 503 service_unavailable: down" };
    const send = fakeSender(Array.from({ length: MAX_ATTEMPTS }, () => ({ ...outage })));

    await deliverAlertEmails(db, settings, send, now);
    let row = await emailRow(id);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.availableAt.getTime()).toBe(now.getTime() + 60_000);

    await deliverAlertEmails(db, settings, send, new Date(now.getTime() + 30_000)); // not due yet
    expect(send.calls).toHaveLength(1);

    let t = now.getTime();
    for (let i = 2; i <= MAX_ATTEMPTS; i += 1) {
      t += 31 * 60_000; // past any backoff
      await deliverAlertEmails(db, settings, send, new Date(t));
    }
    row = await emailRow(id);
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.lastError).toContain("503");
    expect(new Set(send.calls.map((c) => c.key))).toEqual(new Set([id]));
    expect(new Set(send.calls.map((c) => JSON.stringify(c.email))).size).toBe(1);
  });

  it("a rejected request (bad sender domain, bad key) fails at once without retry storms", async () => {
    const now = new Date();
    const id = await queuedEmail(now);
    const send = fakeSender([{ ok: false, retryable: false, message: "Resend 403 validation_error: domain not verified" }]);
    await deliverAlertEmails(db, settings, send, now);
    await deliverAlertEmails(db, settings, send, new Date(now.getTime() + 60 * 60_000));
    expect(send.calls).toHaveLength(1);
    expect((await emailRow(id)).status).toBe("FAILED");
  });

  it("a worker that died mid-send is recovered after its lease expires, with the same key", async () => {
    const now = new Date();
    const id = await queuedEmail(now);
    await db.update(alertEmails).set({ status: "SENDING", attempts: 1, leaseUntil: new Date(now.getTime() - 1) }).where(eq(alertEmails.id, id));
    const send = fakeSender();
    await deliverAlertEmails(db, settings, send, now);
    expect(send.calls.map((c) => c.key)).toEqual([id]);
    const row = await emailRow(id);
    expect(row.status).toBe("SENT");
    expect(row.attempts).toBe(2);
  });

  it("a live lease is left alone", async () => {
    const now = new Date();
    const id = await queuedEmail(now);
    await db.update(alertEmails).set({ status: "SENDING", leaseUntil: new Date(now.getTime() + 60_000) }).where(and(eq(alertEmails.id, id)));
    const send = fakeSender();
    await deliverAlertEmails(db, settings, send, now);
    expect(send.calls).toHaveLength(0);
  });
});

describe("Resend client", () => {
  const email: OutgoingEmail = { from: "a@b.co", to: ["c@d.co"], subject: "s", text: "t", html: "<p>t</p>" };
  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

  it("sends the key, and classifies outcomes", async () => {
    let seen: Headers | undefined;
    const ok = createResendSender((async (_url: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response(JSON.stringify({ id: "re-1" }), { status: 200 });
    }) as unknown as typeof fetch);
    expect(await ok("re_key", email, "key-1")).toEqual({ ok: true, providerMessageId: "re-1" });
    expect(seen?.get("Idempotency-Key")).toBe("key-1");
    expect(seen?.get("Authorization")).toBe("Bearer re_key");

    const cases: Array<[number, string, boolean]> = [
      [429, "rate_limit_exceeded", true],
      [500, "application_error", true],
      [503, "service_unavailable", true],
      [409, "concurrent_idempotent_requests", true],
      [409, "invalid_idempotent_request", false],
      [403, "validation_error", false],
      [422, "missing_required_field", false],
    ];
    for (const [status, name, retryable] of cases) {
      const outcome = await createResendSender(respond(status, { name, message: "x" }))("re_key", email, "k");
      expect(outcome, `${status} ${name}`).toMatchObject({ ok: false, retryable });
    }

    const down = createResendSender((async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch);
    expect(await down("re_key", email, "k")).toMatchObject({ ok: false, retryable: true });
  });
});
