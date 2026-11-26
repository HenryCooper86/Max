/**
 * Makes the link that sets a new password for a Max Cloud customer who has
 * forgotten theirs, or whose password someone else may know:
 *
 *   npm run cloud:reset-password -- dev@example.com
 *
 * It prints a link for the customer to open. On that page the customer chooses
 * a new password, and every device is then signed out. The link works once,
 * for 60 minutes, and replaces any earlier one for the same customer.
 *
 * The relay sends no email: give the link to the customer over a channel you
 * trust.
 *
 * Run it on the relay host, in the app directory, where the relay's data lives
 * (the same STUDIO_DIR, default ~/.max-relay). The relay can keep running: it
 * reads the link from the database when the customer opens it.
 */
// The relay reads its settings from .env in the app directory, and so does this script; exported variables win.
import "dotenv/config";
import fs from "node:fs";
import { createPasswordReset } from "../server/cloud/customers";
import { cloudPublicUrl, relayPublicUrl } from "../server/cloud/context";
import { cloudDatabasePath, customerByEmail } from "../server/cloud/store";
import { config } from "../server/runtime-config";

const [argument] = process.argv.slice(2);
if (!argument || argument.startsWith("-")) {
  console.error("Usage: npm run cloud:reset-password -- <customer email>");
  process.exit(1);
}
const source = cloudDatabasePath();
if (source === ":memory:" || !fs.existsSync(source)) {
  console.error(`There is no Max Cloud database at ${source}. Run this where the relay keeps its data.`);
  process.exit(1);
}
const email = argument.trim().toLowerCase();
const customer = customerByEmail(email);
if (!customer) {
  console.error(`No Max Cloud customer with the email ${email}.`);
  process.exit(1);
}

const { token, expiresAt } = createPasswordReset(customer.id);
// Where the customer reaches the relay: CLOUD_PUBLIC_URL, else the relay's public address for telephony, else this
// machine, which only a browser on the relay host can open.
const base = cloudPublicUrl() ?? relayPublicUrl();
const local = `http://localhost:${config.port}`;
console.log(`Password reset link for ${customer.email}, for one use until ${new Date(expiresAt).toISOString()}:`);
console.log();
console.log(`  ${base ?? local}/console/reset?token=${token}`);
console.log();
if (!base) {
  console.log("Neither CLOUD_PUBLIC_URL nor TELEPHONY_PUBLIC_URL is set, so the link names this machine.");
  console.log(`Replace ${local} with the address your customers reach the relay at; the rest of the link stays.`);
}
console.log("The relay sends no email: give the link to the customer over a channel you trust.");
console.log("It replaces any earlier link for this customer. Once it is used, every device is signed out.");
