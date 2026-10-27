/**
 * Operator CLI for account bootstrap (server only):
 *
 *   npm run owner:grant -- you@gmail.com "Your Name"   create the owner + send the Clerk invite
 *   npm run seed:retire                                 block the seeded demo accounts
 *
 * Compiled: node dist/scripts/operator-accounts.js <command> ...
 * Prints outcomes and counts; never passwords, tokens or keys.
 */
import { closeDb, createDb } from "../db/client.js";
import { loadConfig } from "../config.js";
import { grantFirstOwner, retireSeedAccounts } from "../modules/admin/operator-accounts.js";

const [command, ...args] = process.argv.slice(2);
const config = loadConfig();
const { db, client } = createDb({ dataDir: config.dbPath, databaseUrl: config.databaseUrl });

try {
  if (command === "grant-owner") {
    const [email, ...nameParts] = args;
    if (!email || nameParts.length === 0) {
      console.error('usage: npm run owner:grant -- you@gmail.com "Your Name"');
      process.exitCode = 1;
    } else {
      const result = await grantFirstOwner(db, { email, name: nameParts.join(" ") });
      if (result.outcome === "refused") {
        console.error(`[owner:grant] refused: ${result.reason}`);
        process.exitCode = 1;
      } else {
        console.log(`[owner:grant] ${result.outcome}; invitation: ${result.invitation}`);
        if (result.invitation === "sent") {
          console.log("[owner:grant] check that inbox for the Clerk invitation, then sign in with Google or an email code.");
          // Operator's own terminal only: the link signs up this one email, so send it privately.
          if (result.inviteUrl) console.log(`[owner:grant] or open this private sign-up link: ${result.inviteUrl}`);
        }
      }
    }
  } else if (command === "retire-seeds") {
    const result = await retireSeedAccounts(db);
    if (result.outcome === "refused") {
      console.error(`[seed:retire] refused: ${result.reason}`);
      process.exitCode = 1;
    } else {
      console.log(`[seed:retire] blocked ${result.blocked} account(s); ended ${result.sessionsEnded} session(s)`);
    }
  } else {
    console.error("usage: operator-accounts grant-owner <email> <name> | retire-seeds");
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`[operator] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeDb(client);
}
