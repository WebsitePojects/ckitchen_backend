/**
 * Mock Print Agent — CK1-API-003 §8  (prototype stand-in for the real .NET agent)
 *
 * This is the Node/TypeScript stand-in for the production Windows .NET Print Agent.
 * Instead of pushing raw ESC/POS bytes to a thermal printer it simply logs the KOT
 * payload to stdout and immediately ACKs it as PRINTED.
 *
 * Behaviour mirrors §8.1 of the API spec exactly:
 *   - Every ~1.5 s  : GET  /agent/print-jobs/pending     (poll)
 *   - Each pending job: log KOT → POST /agent/print-jobs/{id}/ack  {status:"PRINTED"}
 *   - Every ~10 s   : POST /agent/printers/status         (heartbeat)
 *
 * SF-2 (audit-backend.md CRITICAL #2) rollout note — TWO DIFFERENT tokens now:
 *   1. BOOTSTRAP_AGENT_TOKEN (env `AGENT_TOKEN`) — the shared install-time
 *      secret, used ONLY for the one `POST /agent/register` call.
 *   2. The per-agent token returned RAW in that register response — captured
 *      here and used for every OTHER agent call (pending/ack/heartbeat). It is
 *      never persisted to disk in this mock (kept in memory only); the real
 *      .NET agent should persist it (e.g. DPAPI-protected local file) so it
 *      survives a restart without needing the bootstrap secret again — though
 *      re-registering is always safe (it simply rotates the token).
 *
 * Configuration (environment variables):
 *   BASE_URL     — API base URL (default: http://localhost:4000/api/v1)
 *   AGENT_TOKEN  — bootstrap secret for /agent/register ONLY (default: test-agent-token)
 *   LOCATION_ID  — outlet this agent registers for (uuid, REQUIRED). Every other
 *                  agent endpoint derives its outlet scope from the per-agent
 *                  token itself (server-side), not from anything this mock sends.
 *
 * Run:
 *   LOCATION_ID=<uuid> npx tsx agent-mock/index.ts
 *   (or via `npm run agent:mock` with LOCATION_ID set in the environment)
 */

const BASE_URL = (process.env["BASE_URL"] ?? "http://localhost:4000/api/v1").replace(/\/$/, "");
const BOOTSTRAP_AGENT_TOKEN = process.env["AGENT_TOKEN"] ?? "test-agent-token";
const LOCATION_ID = process.env["LOCATION_ID"];

if (!LOCATION_ID) {
  console.error(
    "[agent] LOCATION_ID environment variable is required (the outlet this agent pulls jobs for).",
  );
  process.exit(1);
}

const POLL_INTERVAL_MS = 1500;  // §8.1: every ~1.5 s
const HEARTBEAT_INTERVAL_MS = 10_000; // §8.1: every ~10 s

// Set once by register() at startup — the per-agent token minted for THIS
// agent+location, used for every call except /agent/register itself.
let agentToken: string | undefined;

// ---------------------------------------------------------------------------
// Minimal fetch helpers (Node 18+ built-in fetch)
// ---------------------------------------------------------------------------

function agentHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Agent-Token": token,
  };
}

/** Per-agent-token header for post-registration calls. Throws if called before register(). */
function requireAgentHeaders(): Record<string, string> {
  if (!agentToken) {
    throw new Error("agent token not set — register() must succeed before polling/ack/heartbeat");
  }
  return agentHeaders(agentToken);
}

async function getJson<T>(path: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown, headers: Record<string, string>): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// KOT types (§8.3 payload shape)
// ---------------------------------------------------------------------------

interface KotItem {
  qty: number;
  name: string;
  notes: string | null;
}

interface KotPayload {
  type: string;
  brand: string;
  aggregator: string;
  order_ref: string;
  station: string;
  placed_at: string;
  customer: string | null;
  items: KotItem[];
  footer: string;
}

interface PrinterInfo {
  id: string;
  connection: string;
  address: string;
}

interface PendingJob {
  id: string;
  printer: PrinterInfo | null;
  payload: KotPayload;
}

// ---------------------------------------------------------------------------
// "Print" a KOT to stdout (prototype stand-in for ESC/POS output)
// ---------------------------------------------------------------------------

function printKot(job: PendingJob): void {
  const p = job.payload;
  const sep = "─".repeat(40);
  const ts = new Date(p.placed_at).toLocaleTimeString("en-PH", { hour12: false });
  const printerLabel = job.printer
    ? `${job.printer.connection}@${job.printer.address}`
    : "(no printer)";

  console.log(`\n${sep}`);
  console.log(`  [MOCK PRINT] Job: ${job.id.slice(0, 8)}…`);
  console.log(`  Printer   : ${printerLabel}`);
  console.log(`  Brand     : ${p.brand}  (${p.aggregator})`);
  console.log(`  Ref       : ${p.order_ref}  @ ${ts}`);
  console.log(`  Station   : ${p.station}`);
  if (p.customer) console.log(`  Customer  : ${p.customer}`);
  console.log("  Items:");
  for (const item of p.items) {
    const notes = item.notes ? `  [${item.notes}]` : "";
    console.log(`    ${item.qty}× ${item.name}${notes}`);
  }
  console.log(`  ${p.footer}`);
  console.log(sep);
}

// ---------------------------------------------------------------------------
// Poll loop — GET /agent/print-jobs/pending → ack each
// ---------------------------------------------------------------------------

async function pollPrintJobs(): Promise<void> {
  let jobs: PendingJob[];
  try {
    jobs = await getJson<PendingJob[]>("/agent/print-jobs/pending", requireAgentHeaders());
  } catch (err) {
    console.warn(`[agent] poll failed: ${(err as Error).message}`);
    return;
  }

  if (jobs.length === 0) return;

  console.log(`[agent] ${jobs.length} pending job(s)`);

  for (const job of jobs) {
    try {
      printKot(job);
      await postJson(`/agent/print-jobs/${job.id}/ack`, { status: "PRINTED" }, requireAgentHeaders());
      console.log(`[agent] ACK PRINTED  ${job.id.slice(0, 8)}…`);
    } catch (err) {
      const errMsg = (err as Error).message;
      console.error(`[agent] print failed for ${job.id.slice(0, 8)}…: ${errMsg}`);
      try {
        await postJson(
          `/agent/print-jobs/${job.id}/ack`,
          { status: "FAILED", error: errMsg },
          requireAgentHeaders(),
        );
        console.log(`[agent] ACK FAILED   ${job.id.slice(0, 8)}…`);
      } catch (ackErr) {
        console.error(`[agent] ACK failed too: ${(ackErr as Error).message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat — POST /agent/printers/status
// ---------------------------------------------------------------------------

async function sendHeartbeat(): Promise<void> {
  try {
    await postJson("/agent/printers/status", { printers: [] }, requireAgentHeaders());
    console.log(`[agent] heartbeat sent`);
  } catch (err) {
    console.warn(`[agent] heartbeat failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Register — POST /agent/register (bootstrap secret) → mints the per-agent token
// ---------------------------------------------------------------------------

interface RegisterResponse {
  ok: boolean;
  agent_id: string;
  agent_name: string;
  location_id: string;
  token: string;
}

async function register(): Promise<void> {
  const result = await postJson<RegisterResponse>(
    "/agent/register",
    { agent_name: "Mock Agent", location_id: LOCATION_ID },
    agentHeaders(BOOTSTRAP_AGENT_TOKEN),
  );
  agentToken = result.token; // SF-2: from here on, use THIS, never the bootstrap secret
  console.log(`[agent] registered as ${result.agent_id} for location ${result.location_id}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[agent] CloudKitchen ONE Mock Print Agent starting`);
  console.log(`[agent] Base URL    : ${BASE_URL}`);
  console.log(`[agent] Location    : ${LOCATION_ID}`);
  console.log(`[agent] Poll every  : ${POLL_INTERVAL_MS} ms`);
  console.log(`[agent] Heartbeat   : every ${HEARTBEAT_INTERVAL_MS} ms`);

  // Register before polling — mints the per-agent token every other call uses.
  await register();
  console.log(`[agent] Press Ctrl+C to stop\n`);

  // Start polling
  setInterval(() => {
    void pollPrintJobs();
  }, POLL_INTERVAL_MS);

  // Start heartbeat
  await sendHeartbeat(); // immediate first heartbeat
  setInterval(() => {
    void sendHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

void main();
