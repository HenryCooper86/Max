/**
 * Settles one Max Cloud top-up order: asks its payment provider whether it was
 * paid, and credits it to the customer if it was, exactly as the provider's
 * own notification would have been.
 *
 *   npm run cloud:settle -- mc20261125093000abcdef0123456789
 *
 * For an order the relay has stopped asking about (it was closed as unpaid
 * more than a day after it expired) that the provider's records show as paid.
 * An order is credited once however often this runs, and a notification that
 * arrives later changes nothing. Never use `npm run cloud:credit` for an order
 * the relay has a record of: that adds a second payment of it.
 *
 * Run it on the relay host, in the app directory, with the relay's
 * environment: the same STUDIO_DIR (default ~/.max-relay) and the provider's
 * variables, or the provider cannot be asked.
 */
// The relay reads its settings from .env in the app directory, and so does this script; exported variables win.
import "dotenv/config";
import { customerById, customerFunds } from "../server/cloud/store";
import { settleOrder } from "../server/cloud/topups";

const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`;

/** Says why nothing could be done, and makes the exit code say so too. */
function refuse(reason: string): void {
  console.error(reason);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const [argument] = process.argv.slice(2);
  if (!argument || argument.startsWith("-")) {
    refuse("Usage: npm run cloud:settle -- <order id>");
    return;
  }
  const orderId = argument.trim();
  const result = await settleOrder(orderId);
  if (result.kind === "unknown-order") {
    refuse(`There is no Max Cloud order with the id ${orderId}.`);
    return;
  }
  const { order } = result;
  if (result.kind === "provider-missing") {
    refuse(`Order ${order.id} was to be paid with ${order.provider}, which is not configured on this relay.`);
    console.error("Run this where the relay runs, with that provider's variables in the environment.");
    return;
  }
  if (result.kind === "unpaid") {
    console.log(`The provider reports order ${order.id} (${yuan(order.amount_fen)}, ${order.status}) as not paid.`);
    console.log("Nothing was credited.");
    return;
  }
  if (result.credited === "duplicate") {
    console.log(`Order ${order.id} was already credited. Nothing changed.`);
    return;
  }
  if (result.credited !== "credited") {
    refuse(`The provider's answer about order ${order.id} does not match the order (${result.credited}).`);
    console.error("Nothing was credited.");
    return;
  }
  const customer = customerById(order.customer_id);
  console.log(
    `Order ${order.id} was paid: ${yuan(order.amount_fen)} credited to ${customer?.email ?? order.customer_id}.`
  );
  const funds = customerFunds(order.customer_id, Date.now());
  console.log(
    `Balance now ${yuan(funds.fen)}, ${Math.floor(funds.freeSecondsLeft / 60)} free minutes left this month.`
  );
}

main().catch((error: unknown) => {
  console.error(`Order could not be settled: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
