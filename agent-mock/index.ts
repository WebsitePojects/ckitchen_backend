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
 * Configuration (environment variables):
 *   BASE_URL     — API base URL (default: http://localhost:4000/api/v1)
 *   AGENT_TOKEN  — value for X-Agent-Token header        (default: test-agent-token)
 *
 * Run:
 *   npx tsx agent-mock/index.ts
 *   (or via `npm run agent:mock`)
 */

const BASE_URL = (process.env["BASE_URL"] ?? "http://localhost:4000/api/v1").replace(/\/$/, "");
const AGENT_TOKEN = process.env["AGENT_TOKEN"] ?? "test-agent-token";

const POLL_INTERVAL_MS = 1500;  // §8.1: every ~1.5 s
const HEARTBEAT_INTERVAL_MS = 10_000; // §8.1: every ~10 s

// ---------------------------------------------------------------------------
// Minimal fetch helpers (Node 18+ built-in fetch)
// ---------------------------------------------------------------------------

function agentHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Agent-Token": AGENT_TOKEN,
  };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: agentHeaders(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: agentHeaders(),
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
    jobs = await getJson<PendingJob[]>("/agent/print-jobs/pending");
  } catch (err) {
    console.warn(`[agent] poll failed: ${(err as Error).message}`);
    return;
  }

  if (jobs.length === 0) return;

  console.log(`[agent] ${jobs.length} pending job(s)`);

  for (const job of jobs) {
    try {
      printKot(job);
      await postJson(`/agent/print-jobs/${job.id}/ack`, { status: "PRINTED" });
      console.log(`[agent] ACK PRINTED  ${job.id.slice(0, 8)}…`);
    } catch (err) {
      const errMsg = (err as Error).message;
      console.error(`[agent] print failed for ${job.id.slice(0, 8)}…: ${errMsg}`);
      try {
        await postJson(`/agent/print-jobs/${job.id}/ack`, {
          status: "FAILED",
          error: errMsg,
        });
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
    await postJson("/agent/printers/status", { printers: [] });
    console.log(`[agent] heartbeat sent`);
  } catch (err) {
    console.warn(`[agent] heartbeat failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`[agent] CloudKitchen ONE Mock Print Agent starting`);
console.log(`[agent] Base URL    : ${BASE_URL}`);
console.log(`[agent] Poll every  : ${POLL_INTERVAL_MS} ms`);
console.log(`[agent] Heartbeat   : every ${HEARTBEAT_INTERVAL_MS} ms`);
console.log(`[agent] Press Ctrl+C to stop\n`);

// Start polling
setInterval(() => {
  void pollPrintJobs();
}, POLL_INTERVAL_MS);

// Start heartbeat
sendHeartbeat(); // immediate first heartbeat
setInterval(() => {
  void sendHeartbeat();
}, HEARTBEAT_INTERVAL_MS);
