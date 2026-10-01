/**
 * Background worker runner — `npm run workers` (compiled: `node dist/scripts/run-workers.js`).
 *
 * Inbound GrabFood/foodpanda orders are persisted and acknowledged by the API, but the
 * follow-up work (ingest the order, notify the aggregator, send queued outbound commands)
 * lives in three claim-lease functions that nothing else schedules. Without this process a
 * foodpanda order expires un-accepted and Delivery Hero closes the vendor. Each function
 * claims rows with a conditional UPDATE / lease, so running this beside the API, or running
 * several copies, is safe — a lost race is a clean no-op.
 *
 * Runs as its own PM2 process (not inside server.ts) so a stuck aggregator call can never
 * block HTTP serving, and so the API can be scaled/restarted independently.
 *
 * Logging rule: worker name, counts and error MESSAGES only. Never payloads, order
 * contents, customer data, tokens or credentials (raw_payload holds PII; adapters hold secrets).
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { aggregatorCommands } from "../db/outbound-schema.js";
import { aggregatorAccounts } from "../db/schema.js";
import { runFoodpandaOutboundOnce } from "../modules/foodpanda/worker.js";
import { runGrabSubmitOrderWorkerOnce } from "../modules/grab/worker.js";
import { getOutboundAdapter } from "../modules/outbound/adapter.js";
import { processCommands } from "../modules/outbound/worker.js";
import type { AggregatorOutboundAdapter, OutboundCommandRequest, OutboundSendResult } from "../modules/outbound/types.js";

const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 60_000;
const HEARTBEAT_MS = 5 * 60_000;
/** Error text is the only thing logged about a failure; cap it so a huge upstream body can't flood logs. */
const MAX_LOGGED_ERROR_CHARS = 300;

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

const consoleLogger: Logger = {
  info: (message) => console.log(`[workers] ${message}`),
  error: (message) => console.error(`[workers] ${message}`),
};

/** What a worker reports back: `claimed` drives "did work"; any other fields are numeric counters that go into the log line as-is. */
export interface WorkerRunResult {
  claimed: number;
}

export interface NamedWorker {
  name: string;
  run(db: DB): Promise<WorkerRunResult>;
}

export type WorkerTickResult =
  | { name: string; ok: true; result: WorkerRunResult }
  | { name: string; ok: false; error: string };

export interface TickSummary {
  results: WorkerTickResult[];
  didWork: boolean;
  failed: boolean;
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > MAX_LOGGED_ERROR_CHARS ? `${message.slice(0, MAX_LOGGED_ERROR_CHARS)}…` : message;
}

/**
 * Runs every worker once. Workers are independent, so each gets its own try/catch: one
 * aggregator outage must not starve the others (a failing foodpanda call must not stop Grab
 * ingestion). Sequential rather than parallel to keep DB connection use and log order predictable.
 */
export async function runWorkerTick(db: DB, deps: { workers: readonly NamedWorker[]; log?: Logger }): Promise<TickSummary> {
  const log = deps.log ?? consoleLogger;
  const results: WorkerTickResult[] = [];

  for (const worker of deps.workers) {
    try {
      results.push({ name: worker.name, ok: true, result: await worker.run(db) });
    } catch (err) {
      const message = errorMessage(err);
      log.error(`${worker.name} failed: ${message}`);
      results.push({ name: worker.name, ok: false, error: message });
    }
  }

  return {
    results,
    didWork: results.some((r) => r.ok && r.result.claimed > 0),
    failed: results.some((r) => !r.ok),
  };
}

// ---------------------------------------------------------------------------
// Worker wiring
// ---------------------------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

// The adapters read these variables themselves but expose no "is configured" predicate, so the
// presence check is mirrored here. Keep in sync with readConfigFromEnv() in
// src/modules/outbound/foodpanda-adapter.ts and grab-adapter.ts.
function isFoodpandaConfigured(env: Env): boolean {
  return Boolean(
    env.FOODPANDA_MIDDLEWARE_BASE_URL && env.FOODPANDA_MIDDLEWARE_USERNAME && env.FOODPANDA_MIDDLEWARE_PASSWORD && env.FOODPANDA_CHAIN_CODE,
  );
}

function isGrabConfigured(env: Env): boolean {
  return Boolean(env.GRAB_API_CLIENT_ID && env.GRAB_API_CLIENT_SECRET && (env.GRAB_API_ENV === "staging" || env.GRAB_API_ENV === "production"));
}

/**
 * processCommands claims the globally oldest eligible command regardless of aggregator and
 * hands it to ONE adapter, so a single adapter would send foodpanda commands to Grab's API
 * (or the reverse). This adapter picks the real adapter per command from the command's listing
 * (`aggregator_account.aggregator`), reusing getOutboundAdapter() — the same registry the rest of
 * the codebase selects adapters from.
 */
export class AccountRoutingAdapter implements AggregatorOutboundAdapter {
  readonly provider = "ROUTER";

  constructor(
    private readonly db: DB,
    private readonly adapters: Readonly<Record<string, AggregatorOutboundAdapter | undefined>>,
  ) {}

  async sendCommand(cmd: OutboundCommandRequest): Promise<OutboundSendResult> {
    const [row] = await this.db
      .select({ aggregator: aggregatorAccounts.aggregator })
      .from(aggregatorCommands)
      .innerJoin(aggregatorAccounts, eq(aggregatorAccounts.id, aggregatorCommands.aggregatorAccountId))
      .where(eq(aggregatorCommands.id, cmd.commandId));

    // Fail closed: an unrecognized aggregator (e.g. OTHER) or one that is not configured is
    // rejected with a clear reason instead of being sent to the wrong partner.
    const adapter = row ? this.adapters[row.aggregator] : undefined;
    if (!adapter) {
      return { ok: false, kind: "TERMINAL", message: `No configured outbound adapter for aggregator "${row?.aggregator ?? "unknown"}".` };
    }
    return adapter.sendCommand(cmd);
  }
}

export interface WorkerSetup {
  workers: NamedWorker[];
  /** Workers left out because their integration is not configured — logged once at startup, never per tick. */
  skipped: string[];
}

/**
 * Builds the worker list for the current environment. An unconfigured integration is skipped,
 * not run: the adapters answer "not configured" with a TERMINAL failure, which would
 * permanently mark queued rows DEAD for something an operator simply has not set up yet.
 */
export function buildWorkers(env: Env = process.env): WorkerSetup {
  const workers: NamedWorker[] = [];
  const skipped: string[] = [];

  // Grab's submit-order worker only reads our own receipt table; it needs no credentials.
  workers.push({ name: "grab-submit-order", run: (db) => runGrabSubmitOrderWorkerOnce(db) });

  const foodpandaConfigured = isFoodpandaConfigured(env);
  if (foodpandaConfigured) {
    workers.push({ name: "foodpanda-outbound", run: (db) => runFoodpandaOutboundOnce(db) });
  } else {
    skipped.push("foodpanda-outbound (FOODPANDA_MIDDLEWARE_* / FOODPANDA_CHAIN_CODE not set)");
  }

  const adapters: Record<string, AggregatorOutboundAdapter | undefined> = {};
  if (foodpandaConfigured) adapters.FOODPANDA = getOutboundAdapter("FOODPANDA") ?? undefined;
  if (isGrabConfigured(env)) adapters.GRABFOOD = getOutboundAdapter("GRABFOOD") ?? undefined;

  if (Object.keys(adapters).length > 0) {
    workers.push({ name: "outbound-commands", run: (db) => processCommands(db, new AccountRoutingAdapter(db, adapters)) });
  } else {
    skipped.push("outbound-commands (neither foodpanda nor Grab outbound API is configured)");
  }

  return { workers, skipped };
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

/** Parses WORKER_INTERVAL_MS: unset/garbage => default; otherwise clamped so a typo can neither hammer the DB nor stall the workers. */
export function parseIntervalMs(raw: string | undefined): number {
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) return DEFAULT_INTERVAL_MS;
  return Math.min(Math.max(Math.trunc(value), MIN_INTERVAL_MS), MAX_INTERVAL_MS);
}

export interface WorkerLoopOptions {
  db: DB;
  workers: readonly NamedWorker[];
  intervalMs: number;
  /** Aborting lets the in-flight tick finish, then ends the loop (and cuts the wait short). */
  signal: AbortSignal;
  log?: Logger;
  heartbeatMs?: number;
}

/**
 * Await-based loop (no setInterval) so ticks can never overlap: the next tick is scheduled only
 * after the previous one finished. Logs only when a tick did work or failed, plus a heartbeat so
 * "silence" can be told apart from "dead process" without flooding the log.
 */
export async function runWorkerLoop(opts: WorkerLoopOptions): Promise<void> {
  const log = opts.log ?? consoleLogger;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  let lastLogAt = Date.now();
  let idleTicks = 0;

  while (!opts.signal.aborted) {
    const tick = await runWorkerTick(opts.db, { workers: opts.workers, log });

    if (tick.didWork) {
      const detail = tick.results.flatMap((r) => (r.ok && r.result.claimed > 0 ? [`${r.name}=${JSON.stringify(r.result)}`] : []));
      log.info(`tick did work: ${detail.join(" ")}`);
      lastLogAt = Date.now();
    } else if (tick.failed) {
      lastLogAt = Date.now(); // failures were already logged per worker; they double as a sign of life.
    } else {
      idleTicks += 1;
      if (Date.now() - lastLogAt >= heartbeatMs) {
        log.info(`heartbeat: alive, ${idleTicks} idle ticks since last activity`);
        lastLogAt = Date.now();
        idleTicks = 0;
      }
    }

    try {
      await sleep(opts.intervalMs, undefined, { signal: opts.signal });
    } catch {
      // Aborted while waiting — shutdown requested; the while condition ends the loop.
    }
  }
}

// `npm run workers` / `node dist/scripts/run-workers.js`. Only runs as the entrypoint so tests can import this module.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const { createDb, closeDb } = await import("../db/client.js");
  const { loadConfig, isPostgresUrl } = await import("../config.js");
  const config = loadConfig();
  const { db, client } = createDb({ dataDir: config.dbPath, databaseUrl: config.databaseUrl });

  if (!isPostgresUrl(config.databaseUrl)) {
    // Same dev-only guard as server.ts: a remote DB is never auto-migrated, a local PGlite is.
    const { runMigrations } = await import("../db/migrate.js");
    await runMigrations(db);
  }

  const intervalMs = parseIntervalMs(process.env.WORKER_INTERVAL_MS);
  const { workers, skipped } = buildWorkers();
  consoleLogger.info(`started: interval=${intervalMs}ms workers=[${workers.map((w) => w.name).join(", ")}]`);
  for (const reason of skipped) consoleLogger.info(`skipped: ${reason}`);

  const shutdown = new AbortController();
  const onSignal = (signalName: string) => {
    if (shutdown.signal.aborted) {
      consoleLogger.info(`${signalName} received again — exiting immediately`);
      process.exit(1);
    }
    consoleLogger.info(`${signalName} received — finishing current tick, then exiting`);
    shutdown.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  await runWorkerLoop({ db, workers, intervalMs, signal: shutdown.signal });

  await closeDb(client); // GOTCHA: a postgres-js pool / file-backed PGlite keeps the event loop alive — close or the process hangs.
  consoleLogger.info("stopped");
  process.exit(0);
}
