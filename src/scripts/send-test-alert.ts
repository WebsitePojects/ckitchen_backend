/**
 * Sends one test alert email to the owners, through the real outbox and Resend, to prove the
 * setup end to end: `npm run alerts:test` (compiled: `node dist/scripts/send-test-alert.js`).
 *
 * Each run sends one new email on purpose (it is an operator check, not a business effect).
 * Prints counts and the delivery state only, never addresses or the API key.
 */
import { closeDb, createDb } from "../db/client.js";
import { loadConfig } from "../config.js";
import { queueTestEmail } from "../modules/alerts/compose.js";
import { readAlertSettings } from "../modules/alerts/config.js";
import { deliverAlertEmails } from "../modules/alerts/deliver.js";
import { createResendSender } from "../modules/alerts/resend.js";

const config = loadConfig();
const alerts = readAlertSettings();
if (!alerts.ok) {
  console.error(`[alerts:test] alerts are off: ${alerts.reason}`);
  process.exit(1);
}

const { db, client } = createDb({ dataDir: config.dbPath, databaseUrl: config.databaseUrl });
try {
  const queued = await queueTestEmail(db, alerts.settings, new Date());
  if (!queued) {
    console.error("[alerts:test] no recipients: no ACTIVE OWNER user and ALERT_EMAIL_TO is empty");
    process.exitCode = 1;
  } else {
    const result = await deliverAlertEmails(db, alerts.settings, createResendSender(), new Date());
    console.log(`[alerts:test] queued for ${queued.recipients} recipient(s); sent=${result.sent} retrying=${result.retrying} failed=${result.failed}`);
    if (result.sent !== 1) {
      console.log("[alerts:test] not sent yet: the worker retries it; check alert_email.last_error for the reason");
      process.exitCode = 1;
    }
  }
} finally {
  await closeDb(client);
}
