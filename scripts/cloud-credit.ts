/**
 * Adds (or, with a negative amount, removes) Max Cloud balance by hand, for a
 * payment received outside WeChat Pay and Alipay: a bank transfer, an invoice.
 *
 *   npm run cloud:credit -- <customer email> <amount in yuan> <reference>
 *   npm run cloud:credit -- dev@example.com 200 INV-2026-0007
 *
 * The reference (an invoice or receipt number) makes it safe to run twice:
 * the second run changes nothing. Run it where the relay's data lives (the
 * same STUDIO_DIR, default ~/.max-relay); the relay sees the change at once.
 */
// The relay reads its settings from .env in the app directory, and so does this script; exported variables win.
import "dotenv/config";
import { customerByEmail, customerFunds, adjustBalance } from "../server/cloud/store";

function fenFromYuan(text: string): number | undefined {
  const match = /^(-)?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return undefined;
  const fen = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] ? -fen : fen;
}

const [email, amount, ref] = process.argv.slice(2);
const fen = amount === undefined ? undefined : fenFromYuan(amount);
if (!email || fen === undefined || fen === 0 || !ref?.trim()) {
  console.error("Usage: npm run cloud:credit -- <customer email> <amount in yuan, e.g. 200 or 49.50> <reference>");
  process.exit(1);
}
const customer = customerByEmail(email.trim().toLowerCase());
if (!customer) {
  console.error(`No Max Cloud customer with the email ${email}.`);
  process.exit(1);
}
const now = Date.now();
const added = adjustBalance({ customerId: customer.id, amountFen: fen, ref: `manual:${ref.trim()}`, at: now });
const funds = customerFunds(customer.id, now);
console.log(
  added
    ? `${fen > 0 ? "Added" : "Removed"} ¥${(Math.abs(fen) / 100).toFixed(2)} for ${customer.email} (${ref.trim()}).`
    : `Reference ${ref.trim()} was already used; nothing changed.`
);
console.log(
  `Balance now ¥${(funds.fen / 100).toFixed(2)}, ${Math.floor(funds.freeSecondsLeft / 60)} free minutes left this month.`
);
