/**
 * Entrypoint for the background worker process (`npm run workers`).
 *
 * Calls `main()` unconditionally instead of detecting "am I the entry file" via
 * `process.argv[1]`: under PM2 fork mode argv[1] is PM2's ProcessContainerFork.js wrapper, so an
 * argv-based check never matched, `main()` never ran, and the process sat online and silent.
 */
import { main } from "./run-workers.js";

try {
  await main();
  process.exit(0);
} catch (err) {
  // Message only: stacks/causes from DB or aggregator clients can carry connection strings or payload text.
  console.error(`[workers] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
