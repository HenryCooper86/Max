// Max Cloud's materialized balance: customers.balance_fen equals the sum of the
// customer's ledger, however an entry is added, on a database that had the
// column from the start and on one that did not; and the reads of the 5-second
// check stay off the ledger's rows.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chargeSession,
  cloudSessionAlive,
  cloudSessionEnded,
  cloudSessionStarted,
  recoverCloudSessions,
  remainingSeconds
} from "../server/cloud";
import { secondsForFen } from "../server/cloud/billing";
import { setCloudClock, setCloudInstanceId, setCloudPaymentProviders } from "../server/cloud/context";
import { createProject, signup } from "../server/cloud/customers";
import type { PaidOrder, PaymentProvider } from "../server/cloud/payments";
import { adjustBalance, customerFunds, immediate, resetCloudDatabase } from "../server/cloud/store";
import { createTopup, creditPaidOrder, settleOrder, sweepTopups } from "../server/cloud/topups";

const START = Date.UTC(2026, 10, 18, 12, 0, 0);
const ENV_NAMES = ["CLOUD_SECRET_KEY", "CLOUD_PUBLIC_URL", "CLOUD_SIGNUP", "STUDIO_DIR"] as const;
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
let clock = START;

beforeEach(() => {
  process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.CLOUD_SIGNUP = "open";
  delete process.env.CLOUD_PUBLIC_URL;
  resetCloudDatabase(":memory:");
  clock = START;
  setCloudClock(() => clock);
  setCloudPaymentProviders([]);
  setCloudInstanceId("relay-a");
});

afterEach(() => {
  resetCloudDatabase();
  setCloudClock();
  setCloudPaymentProviders();
  setCloudInstanceId();
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

function fakeProvider(id: PaymentProvider["id"] = "wechat") {
  const paidAtProvider = new Map<string, PaidOrder>();
  const provider: PaymentProvider = {
    id,
    configured: () => true,
    createQrOrder: async (order) => ({ qrCode: `weixin://wxpay/bizpayurl?pr=${order.orderId}` }),
    parseNotification: async () => null,
    notificationAnswer: (accepted) => ({ status: accepted ? 204 : 400, contentType: "text/plain", body: "" }),
    queryOrder: async (orderId) => paidAtProvider.get(orderId) ?? null,
    closeOrder: async () => {}
  };
  return { provider, paidAtProvider };
}

async function newCustomer(email = `c${randomBytes(4).toString("hex")}@example.com`) {
  const result = await signup(email, "correct horse battery");
  if (!result.ok) throw new Error(result.error);
  return result.value.customer.id;
}

function newProject(customerId: string) {
  const result = createProject(customerId, { name: "Shop" });
  if (!result.ok) throw new Error(result.error);
  return result.value.project.id;
}

const paid = (orderId: string, providerTxnId: string, amountFen = 5_000): PaidOrder => ({
  orderId,
  providerTxnId,
  amountFen
});

describe("the materialized balance", () => {
  const ledgerSum = (customerId: string) =>
    immediate(
      (db) =>
        (
          db
            .prepare("SELECT COALESCE(SUM(amount_fen), 0) AS fen FROM ledger WHERE customer_id = ?")
            .get(customerId) as { fen: number }
        ).fen
    );
  const storedBalance = (customerId: string) =>
    immediate(
      (db) =>
        (db.prepare("SELECT balance_fen FROM customers WHERE id = ?").get(customerId) as { balance_fen: number })
          .balance_fen
    );
  const agrees = (customerId: string) => expect(storedBalance(customerId)).toBe(ledgerSum(customerId));

  it("stays equal to the sum of the ledger through top-ups, usage, adjustments, settles and remainders", async () => {
    const customerId = await newCustomer();
    const projectId = newProject(customerId);
    const fake = fakeProvider();
    setCloudPaymentProviders([fake.provider]);
    process.env.CLOUD_PUBLIC_URL = "https://max.example.com";

    const order = async () => {
      const created = await createTopup(customerId, { pack: "cny50", provider: "wechat" });
      if (!created.ok) throw new Error(created.error);
      return created.value.orderId;
    };
    const first = await order();
    const second = await order();
    const third = await order();
    await order(); // a fourth, left pending: never credited
    agrees(customerId);

    // Credited each way a payment can be: the provider's notification, the sweep, and by hand after expiry.
    expect(creditPaidOrder(paid(first, "n1"), "wechat")).toBe("credited");
    agrees(customerId);
    fake.paidAtProvider.set(second, paid(second, "s1"));
    clock += 3_000;
    expect(await sweepTopups()).toBe(1);
    agrees(customerId);
    clock += 15 * 60_000 + 1;
    await sweepTopups(); // the third expires and is closed as unpaid
    fake.paidAtProvider.set(third, paid(third, "h1"));
    expect(await settleOrder(third)).toMatchObject({ kind: "confirmed", credited: "credited" });
    agrees(customerId);

    // Usage: the month's free seconds go first, then the balance.
    chargeSession({ customerId, projectId, sessionId: "s-long", seconds: 60_100, endedAt: clock });
    agrees(customerId);

    // Adjustments by hand, both ways, idempotent on their reference.
    expect(adjustBalance({ customerId, amountFen: 2_000, ref: "manual:INV-1", at: clock })).toBe(true);
    expect(adjustBalance({ customerId, amountFen: -500, ref: "manual:REFUND-1", at: clock })).toBe(true);
    expect(adjustBalance({ customerId, amountFen: 2_000, ref: "manual:INV-1", at: clock })).toBe(false);
    agrees(customerId);

    // A session booked early as abandoned, then found longer: a remainder entry, one charge in all.
    cloudSessionStarted({ sessionId: "s-stall", customerId, projectId });
    clock += 60_000;
    cloudSessionAlive({ sessionId: "s-stall", customerId, projectId }, 60);
    agrees(customerId); // a running session is not a ledger entry
    clock += 61_000;
    setCloudInstanceId("relay-b");
    expect(recoverCloudSessions()).toBe(1);
    agrees(customerId);
    setCloudInstanceId("relay-a");
    expect(cloudSessionEnded({ customerId, projectId, sessionId: "s-stall", seconds: 200, endedAt: clock })).toBe(
      "booked"
    );
    agrees(customerId);

    // 3 top-ups (15,000) + adjustments (+1,500) − usage (25 + 50) = 16,425 fen.
    expect(customerFunds(customerId, clock).fen).toBe(16_425);
    expect(remainingSeconds(customerId)).toBe(secondsForFen(16_425));
  });

  it("is filled from the ledger of a database that predates it, the first time that is opened", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-cloud-balance-"));
    const file = path.join(directory, "cloud.sqlite");
    try {
      resetCloudDatabase(file);
      const customerId = await newCustomer();
      const projectId = newProject(customerId);
      adjustBalance({ customerId, amountFen: 5_000, ref: "manual:INV-1", at: clock });
      chargeSession({ customerId, projectId, sessionId: "s-1", seconds: 60_100, endedAt: clock });
      const expected = ledgerSum(customerId);
      expect(storedBalance(customerId)).toBe(expected);

      // A database as the previous release left it: no balance column and no trigger.
      const older = new DatabaseSync(file);
      try {
        older.exec("DROP TRIGGER ledger_entry_moves_balance; ALTER TABLE customers DROP COLUMN balance_fen");
      } finally {
        older.close();
      }

      resetCloudDatabase(file);
      expect(customerFunds(customerId, clock).fen).toBe(expected);
      expect(storedBalance(customerId)).toBe(expected);

      // An entry written by a connection that knows nothing of the column moves it all the same, and the next open
      // does not fill it again.
      const stranger = new DatabaseSync(file);
      try {
        stranger.exec("PRAGMA busy_timeout = 5000");
        stranger
          .prepare(
            "INSERT INTO ledger (customer_id, kind, amount_fen, free_seconds, seconds, project_id, ref, month, created_at) VALUES (?, 'adjust', 700, 0, 0, NULL, 'manual:elsewhere', '2026-11', ?)"
          )
          .run(customerId, clock);
      } finally {
        stranger.close();
      }
      expect(customerFunds(customerId, clock).fen).toBe(expected + 700);
      resetCloudDatabase(file);
      expect(customerFunds(customerId, clock).fen).toBe(expected + 700);
    } finally {
      resetCloudDatabase(":memory:");
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is read from the customer's row, and the month's free seconds from an index, without the ledger's rows", () => {
    const plan = (sql: string) =>
      immediate((db) =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((step) => step.detail)
      );
    expect(plan("SELECT balance_fen FROM customers WHERE id = ?")).toEqual([
      expect.stringMatching(/^SEARCH customers USING INDEX sqlite_autoindex_customers_1 \(id=\?\)$/)
    ]);
    expect(
      plan("SELECT COALESCE(SUM(free_seconds), 0) FROM ledger WHERE customer_id = ? AND kind = 'usage' AND month = ?")
    ).toEqual([expect.stringMatching(/USING COVERING INDEX idx_ledger_customer_month_free/)]);
    expect(
      plan("SELECT COALESCE(SUM(seconds), 0) FROM ledger WHERE project_id = ? AND kind = 'usage' AND month = ?")
    ).toEqual([expect.stringMatching(/USING COVERING INDEX idx_ledger_project_month_seconds/)]);
  });
});
