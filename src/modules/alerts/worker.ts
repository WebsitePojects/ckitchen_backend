/**
 * The owner-alerts worker for the background loop (scripts/run-workers.ts).
 *
 * The loop ticks every few seconds; scanning stock and orders that often is wasted work for
 * an email, so detection + composing runs at most once per SCAN_INTERVAL_MS while delivery
 * (one indexed query when idle) runs every tick, so retries go out on time.
 */
import type { DB } from "../../db/client.js";
import type { NamedWorker, WorkerRunResult } from "../../scripts/run-workers.js";
import { composeAlertDigest } from "./compose.js";
import type { AlertSettings } from "./config.js";
import { deliverAlertEmails } from "./deliver.js";
import { createResendSender, type SendEmail } from "./resend.js";
import { scanForAlerts } from "./scan.js";

const SCAN_INTERVAL_MS = 60_000;

export interface AlertsWorkerOptions {
  send?: SendEmail;
  now?: () => Date;
  scanIntervalMs?: number;
}

export function createAlertsWorker(settings: AlertSettings, opts: AlertsWorkerOptions = {}): NamedWorker {
  const send = opts.send ?? createResendSender();
  const clock = opts.now ?? (() => new Date());
  const scanIntervalMs = opts.scanIntervalMs ?? SCAN_INTERVAL_MS;
  let lastScanAt = Number.NEGATIVE_INFINITY;

  return {
    name: "owner-alerts",
    async run(db: DB): Promise<WorkerRunResult & Record<string, number>> {
      const now = clock();
      let opened = 0;
      let resolved = 0;
      let composed = 0;
      if (now.getTime() - lastScanAt >= scanIntervalMs) {
        lastScanAt = now.getTime();
        ({ opened, resolved } = await scanForAlerts(db, settings, now));
        const digest = await composeAlertDigest(db, settings, now);
        composed = digest.composed ? 1 : 0;
      }
      const delivery = await deliverAlertEmails(db, settings, send, now);
      return {
        claimed: opened + composed + delivery.claimed,
        opened,
        resolved,
        composed,
        sent: delivery.sent,
        retrying: delivery.retrying,
        failed: delivery.failed,
      };
    },
  };
}
