/**
 * Worker runner (src/scripts/run-workers.ts): tick isolation, skip-when-unconfigured wiring,
 * the abortable loop, log hygiene, and per-aggregator command routing.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { aggregatorCommands } from "../src/db/outbound-schema.js";
import { aggregatorAccounts, brands, locations } from "../src/db/schema.js";
import { DummyOutboundAdapter } from "../src/modules/outbound/adapter.js";
import { processCommands } from "../src/modules/outbound/worker.js";
import {
  AccountRoutingAdapter,
  buildWorkers,
  parseIntervalMs,
  runWorkerLoop,
  runWorkerTick,
  type Logger,
  type NamedWorker,
} from "../src/scripts/run-workers.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);
});

afterAll(async () => {
  await closeDb(client);
});

const SAMPLE_SECRET = "s3cr3t-do-not-log-7f3a9c";

/** Every integration "configured", using a recognizable fake secret the log-hygiene test hunts for. */
const FULL_ENV = {
  FOODPANDA_MIDDLEWARE_BASE_URL: "https://fp.invalid",
  FOODPANDA_MIDDLEWARE_USERNAME: "user",
  FOODPANDA_MIDDLEWARE_PASSWORD: SAMPLE_SECRET,
  FOODPANDA_CHAIN_CODE: "chain",
  GRAB_API_CLIENT_ID: "grab-id",
  GRAB_API_CLIENT_SECRET: SAMPLE_SECRET,
  GRAB_API_ENV: "staging",
};

function captureLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { lines, log: { info: (m) => lines.push(`INFO ${m}`), error: (m) => lines.push(`ERROR ${m}`) } };
}

const idleWorker = (name: string, onRun?: () => void): NamedWorker => ({
  name,
  run: async () => {
    onRun?.();
    return { claimed: 0 };
  },
});

describe("module import", () => {
  it("has no side effects: no startup line, no signal handlers, no loop (PM2 runs it via workers-main, not argv detection)", async () => {
    vi.resetModules();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    try {
      const fresh = await import("../src/scripts/run-workers.js");
      expect(typeof fresh.main).toBe("function");
      expect(logSpy).not.toHaveBeenCalled();
      expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("runWorkerTick", () => {
  it("runs every worker against an empty DB and reports zero work", async () => {
    const { workers, skipped } = buildWorkers(FULL_ENV);
    expect(workers.map((w) => w.name)).toEqual(["grab-submit-order", "foodpanda-outbound", "outbound-commands"]);
    expect(skipped).toEqual([]);

    const { log, lines } = captureLogger();
    const tick = await runWorkerTick(db, { workers, log });

    expect(tick.results.map((r) => r.name)).toEqual(["grab-submit-order", "foodpanda-outbound", "outbound-commands"]);
    expect(tick.results.every((r) => r.ok && r.result.claimed === 0)).toBe(true);
    expect(tick.didWork).toBe(false);
    expect(tick.failed).toBe(false);
    expect(lines).toEqual([]);
  });

  it("keeps running the other workers when one throws, and reports the failure for that worker only", async () => {
    const ran: string[] = [];
    const { log, lines } = captureLogger();
    const workers: NamedWorker[] = [
      idleWorker("first", () => ran.push("first")),
      {
        name: "broken",
        run: async () => {
          ran.push("broken");
          throw new Error("upstream exploded");
        },
      },
      idleWorker("last", () => ran.push("last")),
    ];

    const tick = await runWorkerTick(db, { workers, log });

    expect(ran).toEqual(["first", "broken", "last"]);
    expect(tick.failed).toBe(true);
    expect(tick.results.filter((r) => !r.ok).map((r) => r.name)).toEqual(["broken"]);
    expect(tick.results.find((r) => r.name === "broken")).toEqual({ name: "broken", ok: false, error: "upstream exploded" });
    expect(lines).toEqual(["ERROR broken failed: upstream exploded"]);
  });

  it("counts claimed rows as work", async () => {
    const tick = await runWorkerTick(db, { workers: [{ name: "busy", run: async () => ({ claimed: 2, done: 2 }) }], log: captureLogger().log });
    expect(tick.didWork).toBe(true);
  });
});

describe("buildWorkers", () => {
  it("skips unconfigured integrations and says why, without ever running them", () => {
    const { workers, skipped } = buildWorkers({});
    expect(workers.map((w) => w.name)).toEqual(["grab-submit-order"]);
    expect(skipped).toHaveLength(2);
    expect(skipped.join(" ")).toContain("foodpanda-outbound");
    expect(skipped.join(" ")).toContain("outbound-commands");
  });

  it("treats a partially configured foodpanda environment as unconfigured", () => {
    const { workers } = buildWorkers({ FOODPANDA_MIDDLEWARE_BASE_URL: "https://fp.invalid", FOODPANDA_CHAIN_CODE: "chain" });
    expect(workers.map((w) => w.name)).toEqual(["grab-submit-order"]);
  });

  it("runs outbound commands when only Grab is configured", () => {
    const { workers } = buildWorkers({ GRAB_API_CLIENT_ID: "id", GRAB_API_CLIENT_SECRET: "secret", GRAB_API_ENV: "production" });
    expect(workers.map((w) => w.name)).toEqual(["grab-submit-order", "outbound-commands"]);
  });
});

describe("parseIntervalMs", () => {
  it("defaults when unset or not a number, and clamps to [1000, 60000]", () => {
    expect(parseIntervalMs(undefined)).toBe(5000);
    expect(parseIntervalMs("")).toBe(5000);
    expect(parseIntervalMs("abc")).toBe(5000);
    expect(parseIntervalMs("2500")).toBe(2500);
    expect(parseIntervalMs("10")).toBe(1000);
    expect(parseIntervalMs("999999")).toBe(60000);
  });
});

describe("runWorkerLoop", () => {
  it("finishes the current tick when aborted, then stops without starting another", async () => {
    const shutdown = new AbortController();
    let completedTicks = 0;
    const workers: NamedWorker[] = [
      {
        name: "stopper",
        run: async () => {
          // Abort mid-tick on the 2nd run: this tick must still complete, the 3rd must never start.
          if (completedTicks === 1) shutdown.abort();
          await new Promise((r) => setTimeout(r, 20));
          completedTicks += 1;
          return { claimed: 0 };
        },
      },
    ];

    await runWorkerLoop({ db, workers, intervalMs: 1, signal: shutdown.signal, log: captureLogger().log });

    expect(completedTicks).toBe(2);
  });

  it("cuts the inter-tick wait short on abort instead of sleeping out the interval", async () => {
    const shutdown = new AbortController();
    const started = Date.now();
    const loop = runWorkerLoop({ db, workers: [idleWorker("idle")], intervalMs: 60_000, signal: shutdown.signal, log: captureLogger().log });
    setTimeout(() => shutdown.abort(), 30);
    await loop;
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stays silent on idle ticks, logs work and failures, and emits a heartbeat only when due", async () => {
    const quiet = new AbortController();
    const quietLog = captureLogger();
    let quietTicks = 0;
    await runWorkerLoop({
      db,
      workers: [
        idleWorker("idle", () => {
          quietTicks += 1;
          if (quietTicks === 3) quiet.abort();
        }),
      ],
      intervalMs: 1,
      signal: quiet.signal,
      log: quietLog.log,
    });
    expect(quietLog.lines).toEqual([]);

    const noisy = new AbortController();
    const noisyLog = captureLogger();
    let noisyTicks = 0;
    await runWorkerLoop({
      db,
      workers: [
        {
          name: "flaky",
          run: async () => {
            noisyTicks += 1;
            if (noisyTicks === 1) return { claimed: 1, done: 1 };
            if (noisyTicks === 2) throw new Error("boom");
            if (noisyTicks === 4) noisy.abort();
            return { claimed: 0 };
          },
        },
      ],
      intervalMs: 1,
      signal: noisy.signal,
      log: noisyLog.log,
      heartbeatMs: 0,
    });
    expect(noisyLog.lines[0]).toBe('INFO tick did work: flaky={"claimed":1,"done":1}');
    expect(noisyLog.lines[1]).toBe("ERROR flaky failed: boom");
    expect(noisyLog.lines.some((l) => l.startsWith("INFO heartbeat"))).toBe(true);
  });

  it("never writes a configured secret to the log, including for real workers over many ticks", async () => {
    const shutdown = new AbortController();
    const { log, lines } = captureLogger();
    const { workers } = buildWorkers(FULL_ENV);
    let ticks = 0;
    const counted: NamedWorker[] = [
      ...workers,
      idleWorker("counter", () => {
        ticks += 1;
        if (ticks === 3) shutdown.abort();
      }),
    ];

    await runWorkerLoop({ db, workers: counted, intervalMs: 1, signal: shutdown.signal, log, heartbeatMs: 0 });

    expect(ticks).toBe(3);
    expect(lines.length).toBeGreaterThan(0); // heartbeatMs 0 guarantees the log path really ran
    expect(lines.join("\n")).not.toContain(SAMPLE_SECRET);
  });
});

describe("AccountRoutingAdapter", () => {
  async function listing(aggregator: "FOODPANDA" | "GRABFOOD" | "OTHER") {
    const s = randomUUID().slice(0, 8);
    const [location] = await db.insert(locations).values({ code: `RW-${s}`, name: `RW Outlet ${s}` }).returning();
    const [brand] = await db
      .insert(brands)
      .values({ locationId: location!.id, name: `RW Brand ${s}`, color: "#112233", salesPerfId: `rw-${s}` })
      .returning();
    const [account] = await db
      .insert(aggregatorAccounts)
      .values({ brandId: brand!.id, locationId: location!.id, mappingStatus: "RESOLVED", aggregator, externalMerchantId: `RW-${s}`, controlMode: "API" })
      .returning();
    return account!.id;
  }

  async function pauseCommand(aggregatorAccountId: string) {
    const [row] = await db
      .insert(aggregatorCommands)
      .values({ aggregatorAccountId, commandType: "PAUSE_STORE", payload: {}, idempotencyKey: `rw-${randomUUID()}` })
      .returning();
    return row!;
  }

  it("sends each command through the adapter of its own listing's aggregator and fails closed for the rest", async () => {
    const foodpanda = new DummyOutboundAdapter();
    const grab = new DummyOutboundAdapter();
    const fpCommand = await pauseCommand(await listing("FOODPANDA"));
    const grabCommand = await pauseCommand(await listing("GRABFOOD"));
    const otherCommand = await pauseCommand(await listing("OTHER"));

    const result = await processCommands(db, new AccountRoutingAdapter(db, { FOODPANDA: foodpanda, GRABFOOD: grab }), { limit: 50 });

    expect(result).toMatchObject({ claimed: 3, sent: 2, dead: 1 });
    expect(foodpanda.calls.map((c) => c.commandId)).toEqual([fpCommand.id]);
    expect(grab.calls.map((c) => c.commandId)).toEqual([grabCommand.id]);
    const [other] = await db.select().from(aggregatorCommands).where(eq(aggregatorCommands.id, otherCommand.id));
    expect(other!.status).toBe("DEAD");
    expect(other!.lastError).toContain("OTHER");
  });
});
