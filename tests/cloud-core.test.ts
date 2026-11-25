import { DEFAULT_STUDIO } from "../shared/cloud-studio";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chargeSession, cloudEnabled, projectForApiKey, projectRuntime, remainingSeconds } from "../server/cloud";
import { bookedSeconds, ORDER_LIFETIME_MS, secondsForFen, usageCharge } from "../server/cloud/billing";
import { setCloudClock, setCloudPaymentProviders } from "../server/cloud/context";
import { cloudCounters } from "../server/cloud/counters";
import { createProject, patchProject, rotateProjectKey, deleteProject, signup } from "../server/cloud/customers";
import type { PaidOrder, PaymentProvider, QrOrder } from "../server/cloud/payments";
import { decryptModelKey, encryptModelKey } from "../server/cloud/secrets";
import {
  backupDatabase,
  immediate,
  insertConversation,
  insertOrder,
  ledgerEntries,
  liveProject,
  orderById,
  projectConversations,
  recentlyClosedOrders,
  resetCloudDatabase,
  type OrderRow
} from "../server/cloud/store";
import {
  createTopup,
  creditPaidOrder,
  settleOrder,
  startTopupSweep,
  stopTopupSweep,
  sweepTopups,
  topupStatus
} from "../server/cloud/topups";

const KEY = randomBytes(32);
const START = Date.UTC(2026, 10, 18, 12, 0, 0);
const ENV_NAMES = ["CLOUD_SECRET_KEY", "CLOUD_PUBLIC_URL", "STUDIO_DIR"] as const;
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

let clock = START;

function fakeProvider(id: PaymentProvider["id"] = "wechat") {
  const created: QrOrder[] = [];
  const closed: string[] = [];
  const paidAtProvider = new Map<string, PaidOrder>();
  const provider: PaymentProvider = {
    id,
    configured: () => true,
    createQrOrder: async (order) => {
      created.push(order);
      return { qrCode: `weixin://wxpay/bizpayurl?pr=${order.orderId}` };
    },
    parseNotification: async () => null,
    notificationAnswer: (accepted) => ({ status: accepted ? 204 : 400, contentType: "text/plain", body: "" }),
    queryOrder: async (orderId) => paidAtProvider.get(orderId) ?? null,
    closeOrder: async (orderId) => {
      closed.push(orderId);
    }
  };
  return { provider, created, closed, paidAtProvider };
}

async function newCustomer(email = `c${randomBytes(4).toString("hex")}@example.com`) {
  const result = await signup(email, "correct horse battery");
  if (!result.ok) throw new Error(result.error);
  return result.value.customer.id;
}

function newProject(customerId: string, name = "Shop") {
  const result = createProject(customerId, { name });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

// These suites exercise accounts, projects and money; signup by invitation has
// its own tests (tests/cloud-invites.test.ts).
const savedSignup = process.env.CLOUD_SIGNUP;
beforeEach(() => {
  process.env.CLOUD_SIGNUP = "open";
});
afterEach(() => {
  if (savedSignup === undefined) delete process.env.CLOUD_SIGNUP;
  else process.env.CLOUD_SIGNUP = savedSignup;
});

beforeEach(() => {
  process.env.CLOUD_SECRET_KEY = KEY.toString("base64");
  delete process.env.CLOUD_PUBLIC_URL;
  resetCloudDatabase(":memory:");
  clock = START;
  setCloudClock(() => clock);
  setCloudPaymentProviders([]);
});

afterEach(() => {
  resetCloudDatabase();
  setCloudClock();
  setCloudPaymentProviders();
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

describe("CLOUD_SECRET_KEY", () => {
  it("turns Max Cloud on only for exactly 32 bytes in hex or base64", () => {
    const cases: Array<[string | undefined, boolean]> = [
      [undefined, false],
      ["", false],
      ["   ", false],
      [KEY.toString("hex"), true],
      [KEY.toString("hex").toUpperCase(), true],
      [KEY.toString("base64"), true],
      [KEY.toString("base64url"), true],
      [randomBytes(31).toString("base64"), false],
      [randomBytes(33).toString("hex"), false],
      [randomBytes(16).toString("hex"), false],
      ["not a key at all, not a key at all!!", false],
      ["changeme", false]
    ];
    for (const [value, enabled] of cases) {
      if (value === undefined) delete process.env.CLOUD_SECRET_KEY;
      else process.env.CLOUD_SECRET_KEY = value;
      expect(cloudEnabled(), String(value)).toBe(enabled);
    }
  });
});

describe("model key encryption", () => {
  it("round-trips under AES-256-GCM in the v2 format (naming its key) with a fresh IV each time", () => {
    const first = encryptModelKey("sk-live-secret", KEY, "prj_a");
    const second = encryptModelKey("sk-live-secret", KEY, "prj_a");
    expect(first).toMatch(/^v2:[0-9a-f]{8}:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(first.split(":")[2]!, "base64")).toHaveLength(12);
    expect(first).not.toBe(second);
    expect(first).not.toContain("sk-live-secret");
    expect(decryptModelKey(first, KEY, "prj_a")).toBe("sk-live-secret");
    expect(decryptModelKey(second, KEY, "prj_a")).toBe("sk-live-secret");
  });

  it("refuses tampered ciphertext, another key, or another project's row", () => {
    const stored = encryptModelKey("sk-live-secret", KEY, "prj_a");
    const [version, keyId, iv, tag, ciphertext] = stored.split(":");
    const flipped = Buffer.from(ciphertext!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(
      decryptModelKey([version, keyId, iv, tag, flipped.toString("base64")].join(":"), KEY, "prj_a")
    ).toBeUndefined();
    expect(decryptModelKey(stored, randomBytes(32), "prj_a")).toBeUndefined();
    expect(decryptModelKey(stored, KEY, "prj_b")).toBeUndefined();
    expect(decryptModelKey("garbage", KEY, "prj_a")).toBeUndefined();
    expect(decryptModelKey("v2:a:b:c", KEY, "prj_a")).toBeUndefined();
  });
});

describe("projects for the relay", () => {
  it("finds a live project by its API key, and forgets it after rotation or deletion", async () => {
    const customerId = await newCustomer();
    const { project, apiKey } = newProject(customerId);
    expect(apiKey).toMatch(/^mpk_[A-Za-z0-9_-]{43}$/);
    expect(project.keyPrefix).toBe(apiKey.slice(0, 8));
    expect(projectForApiKey(apiKey)).toMatchObject({ projectId: project.id, customerId });
    expect(projectForApiKey(`${apiKey}x`)).toBeUndefined();
    expect(projectForApiKey("mcs_whatever")).toBeUndefined();
    expect(projectForApiKey("")).toBeUndefined();

    const rotated = rotateProjectKey(customerId, project.id);
    if (!rotated.ok) throw new Error(rotated.error);
    expect(projectForApiKey(apiKey)).toBeUndefined();
    expect(projectForApiKey(rotated.value.apiKey)).toMatchObject({ projectId: project.id, customerId });

    delete process.env.CLOUD_SECRET_KEY;
    expect(projectForApiKey(rotated.value.apiKey)).toBeUndefined();
    process.env.CLOUD_SECRET_KEY = KEY.toString("base64");

    expect(deleteProject(customerId, project.id).ok).toBe(true);
    expect(projectForApiKey(rotated.value.apiKey)).toBeUndefined();
  });

  it("gives a session the decrypted model key and the project's profile", async () => {
    const customerId = await newCustomer();
    const { project } = newProject(customerId);
    expect(projectRuntime(project.id)).toBeUndefined();

    expect(patchProject(customerId, project.id, { modelKey: "  sk-proj-abc  ", backend: "gemini" }).ok).toBe(true);
    expect(projectRuntime(project.id)).toEqual({
      projectId: project.id,
      customerId,
      name: "Shop",
      backend: "gemini",
      modelKey: "sk-proj-abc",
      assistantName: "Assistant",
      studio: { ...DEFAULT_STUDIO, keepConversations: true }
    });

    patchProject(customerId, project.id, { assistantName: "Ava", instructions: "Be brief.", greeting: "Hi!" });
    expect(projectRuntime(project.id)).toMatchObject({
      assistantName: "Ava",
      instructions: "Be brief.",
      greeting: "Hi!"
    });

    process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("hex");
    expect(projectRuntime(project.id)).toBeUndefined();
    delete process.env.CLOUD_SECRET_KEY;
    expect(projectRuntime(project.id)).toBeUndefined();
    process.env.CLOUD_SECRET_KEY = KEY.toString("base64");

    expect(patchProject(customerId, project.id, { modelKey: "" }).ok).toBe(true);
    expect(projectRuntime(project.id)).toBeUndefined();
    patchProject(customerId, project.id, { modelKey: "sk-again" });
    expect(projectRuntime(project.id)?.modelKey).toBe("sk-again");
    deleteProject(customerId, project.id);
    expect(projectRuntime(project.id)).toBeUndefined();
    expect(projectRuntime("prj_unknown")).toBeUndefined();
  });

  it("keeps each customer to 20 live projects", async () => {
    const customerId = await newCustomer();
    const ids = Array.from({ length: 20 }, (_, index) => newProject(customerId, `P${index}`).project.id);
    const refused = createProject(customerId, { name: "One too many" });
    expect(refused).toMatchObject({ ok: false, status: 409 });
    deleteProject(customerId, ids[0]!);
    expect(createProject(customerId, { name: "Room again" }).ok).toBe(true);
  });
});

describe("money rules", () => {
  it("charges whole seconds, free seconds first, then 15 fen a minute rounded up", () => {
    expect(bookedSeconds(30.2)).toBe(31);
    expect(bookedSeconds(0)).toBe(0);
    expect(bookedSeconds(-5)).toBe(0);
    expect(bookedSeconds(Number.NaN)).toBe(0);
    expect(usageCharge(100, 60_000)).toEqual({ freeSeconds: 100, costFen: 0 });
    expect(usageCharge(70, 10)).toEqual({ freeSeconds: 10, costFen: 15 });
    expect(usageCharge(61, 0)).toEqual({ freeSeconds: 0, costFen: 16 });
    expect(usageCharge(1, 0)).toEqual({ freeSeconds: 0, costFen: 1 });
    expect(usageCharge(4, 0)).toEqual({ freeSeconds: 0, costFen: 1 });
    expect(usageCharge(5, 0)).toEqual({ freeSeconds: 0, costFen: 2 });
    expect(secondsForFen(5_000)).toBe(20_000);
    expect(secondsForFen(-3)).toBe(-12);
  });

  it("books sessions against the monthly free seconds, then the balance, and can go negative", async () => {
    const customerId = await newCustomer();
    const { project } = newProject(customerId);
    const charge = (sessionId: string, seconds: number, endedAt = clock) =>
      chargeSession({ customerId, projectId: project.id, sessionId, seconds, endedAt });

    expect(remainingSeconds(customerId)).toBe(60_000);
    charge("s1", 30.2);
    expect(remainingSeconds(customerId)).toBe(60_000 - 31);
    charge("s2", 59_959);
    expect(remainingSeconds(customerId)).toBe(10);
    charge("s3", 70); // 10 free + 60 paid = 15 fen
    expect(remainingSeconds(customerId)).toBe(-60);
    charge("s4", 61); // 16 fen
    expect(remainingSeconds(customerId)).toBe(secondsForFen(-31));
    expect(remainingSeconds(customerId)).toBe(-124);
  });

  it("is idempotent on the session id", async () => {
    const customerId = await newCustomer();
    const { project } = newProject(customerId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      chargeSession({ customerId, projectId: project.id, sessionId: "same", seconds: 120, endedAt: clock });
    }
    expect(remainingSeconds(customerId)).toBe(60_000 - 120);
  });

  it("starts the free seconds again each UTC month, keeping the balance", async () => {
    const customerId = await newCustomer();
    const { project } = newProject(customerId);
    const november = Date.UTC(2026, 10, 30, 23, 59, 0);
    const december = Date.UTC(2026, 11, 1, 0, 0, 30);
    chargeSession({ customerId, projectId: project.id, sessionId: "nov", seconds: 60_240, endedAt: november });
    expect(remainingSeconds(customerId, november)).toBe(-240); // 60 fen owed
    expect(remainingSeconds(customerId, december)).toBe(60_000 - 240);
    chargeSession({ customerId, projectId: project.id, sessionId: "dec", seconds: 100, endedAt: december });
    expect(remainingSeconds(customerId, december)).toBe(60_000 - 100 - 240);
    expect(remainingSeconds(customerId, november)).toBe(-240);
  });

  it("never throws at the caller and ignores sessions it cannot attribute", async () => {
    const customerId = await newCustomer();
    expect(() =>
      chargeSession({ customerId: "cus_unknown", projectId: "prj_x", sessionId: "x", seconds: 10, endedAt: clock })
    ).not.toThrow();
    expect(() =>
      chargeSession({ customerId, projectId: "", sessionId: "y", seconds: 10, endedAt: clock })
    ).not.toThrow();
    chargeSession({ customerId, projectId: "prj_x", sessionId: "z", seconds: Number.NaN, endedAt: Number.NaN });
    expect(remainingSeconds(customerId)).toBe(60_000);
    expect(remainingSeconds("cus_unknown")).toBe(0);
  });
});

describe("top-ups", () => {
  async function pendingOrder(providerId: PaymentProvider["id"] = "wechat") {
    const fake = fakeProvider(providerId);
    setCloudPaymentProviders([fake.provider]);
    process.env.CLOUD_PUBLIC_URL = "https://max.example.com/";
    const customerId = await newCustomer();
    const created = await createTopup(customerId, { pack: "cny200", provider: providerId });
    if (!created.ok) throw new Error(created.error);
    return { fake, customerId, order: created.value };
  }

  it("creates a 15-minute QR order with the provider and a notify URL", async () => {
    const { fake, order } = await pendingOrder();
    expect(order.orderId).toMatch(/^mc\d{14}[0-9a-f]{16}$/);
    expect(order.orderId).toHaveLength(32);
    expect(order).toMatchObject({ provider: "wechat", amountFen: 20_000, expiresAt: START + 15 * 60_000 });
    expect(order.qrCode).toContain(order.orderId);
    expect(fake.created).toEqual([
      {
        orderId: order.orderId,
        amountFen: 20_000,
        description: "Max Cloud top-up",
        notifyUrl: "https://max.example.com/cloud/pay/wechat/notify",
        expiresAt: START + 15 * 60_000
      }
    ]);
  });

  it("credits a verified payment exactly once", async () => {
    const { customerId, order } = await pendingOrder();
    const paid = { orderId: order.orderId, providerTxnId: "4200001", amountFen: 20_000 };
    const credited = cloudCounters().max_cloud_topups_credited_total!;
    expect(creditPaidOrder(paid, "wechat")).toBe("credited");
    expect(creditPaidOrder(paid, "wechat")).toBe("duplicate");
    expect(creditPaidOrder({ ...paid, providerTxnId: "4200002" }, "wechat")).toBe("duplicate");
    expect(remainingSeconds(customerId)).toBe(60_000 + 80_000);
    expect(cloudCounters().max_cloud_topups_credited_total).toBe(credited + 1);
    expect(await topupStatus(customerId, order.orderId)).toEqual({ ok: true, value: { status: "paid" } });
  });

  it("refuses a wrong amount, another provider, an unknown order or a malformed one", async () => {
    const { customerId, order } = await pendingOrder();
    const refused = cloudCounters().max_cloud_topups_refused_total!;
    expect(creditPaidOrder({ orderId: order.orderId, providerTxnId: "t", amountFen: 19_999 }, "wechat")).toBe(
      "amount-mismatch"
    );
    expect(creditPaidOrder({ orderId: order.orderId, providerTxnId: "t", amountFen: 20_000 }, "alipay")).toBe(
      "provider-mismatch"
    );
    expect(creditPaidOrder({ orderId: "mcunknown000000", providerTxnId: "t", amountFen: 20_000 }, "wechat")).toBe(
      "unknown-order"
    );
    expect(creditPaidOrder({ orderId: order.orderId, providerTxnId: "", amountFen: 20_000 }, "wechat")).toBe("invalid");
    expect(creditPaidOrder({ orderId: order.orderId, providerTxnId: "t", amountFen: 200.5 }, "wechat")).toBe("invalid");
    expect(creditPaidOrder({ orderId: "bad id!", providerTxnId: "t", amountFen: 20_000 }, "wechat")).toBe("invalid");
    expect(remainingSeconds(customerId)).toBe(60_000);
    expect(cloudCounters().max_cloud_topups_refused_total).toBe(refused + 6);
    expect(await topupStatus(customerId, order.orderId)).toEqual({ ok: true, value: { status: "pending" } });
  });

  it("asks the provider about a pending order and credits what it confirms", async () => {
    const { fake, customerId, order } = await pendingOrder();
    expect((await topupStatus(customerId, order.orderId)).ok).toBe(true);
    fake.paidAtProvider.set(order.orderId, { orderId: order.orderId, providerTxnId: "q1", amountFen: 20_000 });
    clock += 3_000; // the provider is asked at most once every 3 s per order
    expect(await topupStatus(customerId, order.orderId)).toEqual({ ok: true, value: { status: "paid" } });
    expect(await topupStatus(customerId, order.orderId)).toEqual({ ok: true, value: { status: "paid" } });
    expect(remainingSeconds(customerId)).toBe(140_000);
    const stranger = await newCustomer();
    expect(await topupStatus(stranger, order.orderId)).toMatchObject({ ok: false, status: 404 });
  });

  it("closes an expired order, also at the provider, yet still credits a verified late payment", async () => {
    const { fake, customerId, order } = await pendingOrder();
    clock += 15 * 60_000 + 1;
    expect(await topupStatus(customerId, order.orderId)).toEqual({ ok: true, value: { status: "closed" } });
    await Promise.resolve();
    expect(fake.closed).toEqual([order.orderId]);
    // The provider's word that the money was taken outranks our own expiry.
    expect(creditPaidOrder({ orderId: order.orderId, providerTxnId: "late", amountFen: 20_000 }, "wechat")).toBe(
      "credited"
    );
    expect(remainingSeconds(customerId)).toBe(140_000);
  });

  it("checks an expired order with the provider once before closing it", async () => {
    const { fake, customerId, order } = await pendingOrder();
    fake.paidAtProvider.set(order.orderId, { orderId: order.orderId, providerTxnId: "q2", amountFen: 20_000 });
    clock += 60 * 60_000;
    expect(await topupStatus(customerId, order.orderId)).toEqual({ ok: true, value: { status: "paid" } });
    expect(fake.closed).toEqual([]);
  });

  it("validates the pack and provider, and needs CLOUD_PUBLIC_URL for real providers", async () => {
    const fake = fakeProvider("wechat");
    const test = fakeProvider("test");
    setCloudPaymentProviders([fake.provider, test.provider]);
    const customerId = await newCustomer();
    expect(await createTopup(customerId, { pack: "cny7", provider: "wechat" })).toMatchObject({ status: 400 });
    expect(await createTopup(customerId, { pack: "cny50", provider: "alipay" })).toMatchObject({ status: 400 });
    expect(await createTopup(customerId, { pack: "cny50" })).toMatchObject({ status: 400 });
    expect(await createTopup(customerId, { pack: "cny50", provider: "wechat" })).toMatchObject({ status: 503 });
    process.env.CLOUD_PUBLIC_URL = "ftp://max.example.com";
    expect(await createTopup(customerId, { pack: "cny50", provider: "wechat" })).toMatchObject({ status: 503 });
    expect(fake.created).toEqual([]);
    const viaTest = await createTopup(customerId, { pack: "cny50", provider: "test" });
    expect(viaTest).toMatchObject({ ok: true, value: { amountFen: 5_000, provider: "test" } });
  });

  it("closes the order when the provider cannot create it", async () => {
    const fake = fakeProvider("wechat");
    fake.provider.createQrOrder = async () => {
      throw new Error("provider down");
    };
    setCloudPaymentProviders([fake.provider]);
    process.env.CLOUD_PUBLIC_URL = "https://max.example.com";
    const customerId = await newCustomer();
    expect(await createTopup(customerId, { pack: "cny50", provider: "wechat" })).toMatchObject({
      ok: false,
      status: 502
    });
  });

  it("limits a customer to five unpaid orders at a time", async () => {
    const fake = fakeProvider("wechat");
    setCloudPaymentProviders([fake.provider]);
    process.env.CLOUD_PUBLIC_URL = "https://max.example.com";
    const customerId = await newCustomer();
    for (let index = 0; index < 5; index += 1) {
      expect((await createTopup(customerId, { pack: "cny50", provider: "wechat" })).ok).toBe(true);
    }
    expect(await createTopup(customerId, { pack: "cny50", provider: "wechat" })).toMatchObject({ status: 429 });
    clock += 16 * 60_000;
    expect((await createTopup(customerId, { pack: "cny50", provider: "wechat" })).ok).toBe(true);
  });

  describe("the sweep", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const paid = (orderId: string, providerTxnId: string, amountFen = 20_000): PaidOrder => ({
      orderId,
      providerTxnId,
      amountFen
    });

    const orderNumber = (index: number) => `mc${String(index).padStart(30, "0")}`;
    /** Stores an order of `customerId` whose id is its number, as createTopup stores one. */
    function store(
      customerId: string,
      index: number,
      status: OrderRow["status"],
      expiresAt: number,
      provider = "wechat"
    ): void {
      insertOrder({
        id: orderNumber(index),
        customer_id: customerId,
        provider,
        pack: "cny200",
        amount_fen: 20_000,
        status,
        provider_txn_id: null,
        created_at: expiresAt - ORDER_LIFETIME_MS,
        paid_at: null,
        expires_at: expiresAt
      });
    }

    it("credits a payment nobody is polling for, once its provider confirms it", async () => {
      const { fake, customerId, order } = await pendingOrder();
      const queried = vi.spyOn(fake.provider, "queryOrder");
      expect(await sweepTopups()).toBe(0);
      expect(orderById(order.orderId)?.status).toBe("pending");
      // The customer paid and closed the dialog, and the provider's notification is lost.
      fake.paidAtProvider.set(order.orderId, paid(order.orderId, "sweep"));
      expect(await sweepTopups()).toBe(0); // Asked a moment ago: not again within 3 seconds.
      clock += 3_000;
      expect(await sweepTopups()).toBe(1);
      expect(orderById(order.orderId)).toMatchObject({ status: "paid", provider_txn_id: "sweep" });
      expect(remainingSeconds(customerId)).toBe(140_000);
      expect(await sweepTopups()).toBe(0); // Settled: nothing left to ask about.
      expect(queried).toHaveBeenCalledTimes(2);
    });

    it("shares the limit on provider queries with the customer's polling: one per order every 3 seconds", async () => {
      const { fake, customerId, order } = await pendingOrder();
      const queried = vi.spyOn(fake.provider, "queryOrder");
      await topupStatus(customerId, order.orderId); // The console's poll asks the provider.
      expect(await sweepTopups()).toBe(0);
      expect(queried).toHaveBeenCalledTimes(1);
      clock += 3_000;
      await sweepTopups();
      expect(queried).toHaveBeenCalledTimes(2);
    });

    it("asks about an expired order before closing it, so a payment made at the last second is credited", async () => {
      const { fake, customerId, order } = await pendingOrder();
      fake.paidAtProvider.set(order.orderId, paid(order.orderId, "late"));
      clock += 15 * 60_000 + 1;
      expect(await sweepTopups()).toBe(1);
      expect(fake.closed).toEqual([]);
      expect(remainingSeconds(customerId)).toBe(140_000);
    });

    it("closes an expired order at its provider too, and asks about it again a quarter of an hour later", async () => {
      const { fake, order } = await pendingOrder();
      const queried = vi.spyOn(fake.provider, "queryOrder");
      clock += 15 * 60_000 + 1;
      expect(await sweepTopups()).toBe(0);
      expect(orderById(order.orderId)?.status).toBe("closed");
      await Promise.resolve();
      expect(fake.closed).toEqual([order.orderId]);
      // It has just answered: not asked about again before a quarter of an hour has gone by.
      clock += 15 * 60_000 - 1;
      expect(await sweepTopups()).toBe(0);
      expect(queried).toHaveBeenCalledTimes(1);
      clock += 1;
      expect(await sweepTopups()).toBe(0);
      expect(queried).toHaveBeenCalledTimes(2);
      // Still inside the day after it expired: asked about again, in case the first answer was wrong.
      clock += 24 * 3_600_000 - 15 * 60_000 - 1_000;
      expect(await sweepTopups()).toBe(0);
      expect(queried).toHaveBeenCalledTimes(3);
      // A day after it expired: left alone.
      clock += 2_000;
      expect(await sweepTopups()).toBe(0);
      expect(queried).toHaveBeenCalledTimes(3);
    });

    it("closes an expired order when the query fails, yet credits it once a later sweep finds it paid", async () => {
      const { fake, customerId, order } = await pendingOrder();
      const queryOrder = fake.provider.queryOrder;
      let providerDown = true;
      fake.provider.queryOrder = async (orderId) => {
        if (providerDown) throw new Error("provider down");
        return queryOrder(orderId);
      };
      vi.spyOn(console, "warn").mockImplementation(() => {});
      clock += 15 * 60_000 + 1;
      expect(await sweepTopups()).toBe(0);
      expect(orderById(order.orderId)?.status).toBe("closed");
      // A quarter of an hour later the provider is back, and the customer had paid just before the order expired.
      providerDown = false;
      fake.paidAtProvider.set(order.orderId, paid(order.orderId, "recovered"));
      clock += 15 * 60_000;
      expect(await sweepTopups()).toBe(1);
      expect(orderById(order.orderId)).toMatchObject({ status: "paid", provider_txn_id: "recovered" });
      expect(remainingSeconds(customerId)).toBe(140_000);
      // Exactly once, whoever reports the payment again.
      expect(await sweepTopups()).toBe(0);
      expect(creditPaidOrder(paid(order.orderId, "recovered"), "wechat")).toBe("duplicate");
      expect(remainingSeconds(customerId)).toBe(140_000);
    });

    it("goes round the closed orders: a second sweep asks about ones the first did not", async () => {
      const fake = fakeProvider("wechat");
      setCloudPaymentProviders([fake.provider]);
      process.env.CLOUD_PUBLIC_URL = "https://max.example.com";
      const customerId = await newCustomer();
      // Thirty orders closed as unpaid inside the day after they expired, none asked about yet.
      for (let index = 1; index <= 30; index += 1) store(customerId, index, "closed", clock - index * 60_000);
      const queried = vi.spyOn(fake.provider, "queryOrder");
      const asked = () => {
        const ids = queried.mock.calls.map(([orderId]) => orderId);
        queried.mockClear();
        return ids;
      };

      await sweepTopups();
      const first = asked();
      clock += 60_000;
      await sweepTopups();
      const second = asked();
      // Twenty fit in one sweep, the most recently expired first. The next takes the other ten, and none of the
      // twenty again: they have just answered.
      expect(first).toEqual(Array.from({ length: 20 }, (_, index) => orderNumber(index + 1)));
      expect(second).toEqual(Array.from({ length: 10 }, (_, index) => orderNumber(index + 21)));
      // A quarter of an hour after the first sweep, those twenty are the ones asked about longest ago.
      clock += 14 * 60_000;
      await sweepTopups();
      expect(asked()).toEqual(first);
    });

    it("asks about twenty orders a sweep: pending first, then the closed ones asked longest ago", async () => {
      const { fake, customerId, order } = await pendingOrder();
      const queried = vi.spyOn(fake.provider, "queryOrder");
      // One more pending, then thirty closed as unpaid inside the day after they expired, the oldest numbered 60.
      // One more closed a day and an hour ago, and one closed before it expired.
      store(customerId, 100, "pending", clock + 1 + ORDER_LIFETIME_MS);
      for (let index = 1; index <= 30; index += 1) store(customerId, index + 30, "closed", clock - index * 60_000);
      store(customerId, 61, "closed", clock - 25 * 3_600_000);
      store(customerId, 62, "closed", clock + ORDER_LIFETIME_MS);
      const asked = () => {
        const ids = queried.mock.calls.map(([orderId]) => orderId);
        queried.mockClear();
        return ids;
      };

      await sweepTopups();
      // The two pending ones, then the eighteen closed ones that expired most recently.
      expect(asked()).toEqual([
        order.orderId,
        orderNumber(100),
        ...Array.from({ length: 18 }, (_, index) => orderNumber(index + 31))
      ]);
      clock += 60_000;
      await sweepTopups();
      // The pending ones again, then twelve closed ones the first sweep did not reach.
      expect(asked()).toEqual([
        order.orderId,
        orderNumber(100),
        ...Array.from({ length: 12 }, (_, index) => orderNumber(index + 49))
      ]);
    });

    it("leaves out orders whose provider is not configured, but closes them once they expire", async () => {
      const fake = fakeProvider("wechat");
      setCloudPaymentProviders([fake.provider]);
      const customerId = await newCustomer();
      // Alipay is not configured on this relay, so nothing can be asked about its orders: twenty pending, five
      // closed as unpaid. They must not take the sweep's twenty places from orders that can be asked about, a
      // pending WeChat order that expires after all of them and one closed as unpaid an hour ago.
      for (let index = 201; index <= 220; index += 1) {
        store(customerId, index, "pending", clock + index + ORDER_LIFETIME_MS, "alipay");
      }
      for (let index = 221; index <= 225; index += 1) {
        store(customerId, index, "closed", clock - index * 60_000, "alipay");
      }
      store(customerId, 229, "pending", clock + 30 * 60_000 + ORDER_LIFETIME_MS);
      store(customerId, 230, "closed", clock - 60 * 60_000);
      const queried = vi.spyOn(fake.provider, "queryOrder");
      const asked = () => queried.mock.calls.map(([orderId]) => orderId);

      await sweepTopups();
      expect(asked()).toEqual([orderNumber(229), orderNumber(230)]);
      // An expired order of that provider is closed all the same, and asked about never.
      store(customerId, 226, "pending", clock - 1, "alipay");
      clock += 60_000;
      queried.mockClear();
      await sweepTopups();
      expect(orderById(orderNumber(226))?.status).toBe("closed");
      expect(asked()).toEqual([orderNumber(229)]);
    });

    it("reads the closed orders that expired most recently first", async () => {
      const customerId = await newCustomer();
      for (let index = 301; index <= 305; index += 1) store(customerId, index, "closed", clock - index * 60_000);
      expect(recentlyClosedOrders(clock, 24 * 3_600_000, 3).map((order) => order.id)).toEqual([
        orderNumber(301),
        orderNumber(302),
        orderNumber(303)
      ]);
    });

    it("once restored, is settled by the sweep: what it knows is credited once, the rest not at all", async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-cloud-restore-"));
      const file = path.join(directory, "cloud.sqlite");
      try {
        // As a relay that keeps a database file has it.
        resetCloudDatabase(file);
        const { fake, customerId, order } = await pendingOrder();
        const backup = backupDatabase(path.join(directory, "backup.sqlite"));
        // After the backup was taken, the customer pays that order, starts another and pays that too.
        const later = await createTopup(customerId, { pack: "cny50", provider: "wechat" });
        if (!later.ok) throw new Error(later.error);
        fake.paidAtProvider.set(order.orderId, paid(order.orderId, "first"));
        fake.paidAtProvider.set(later.value.orderId, paid(later.value.orderId, "second", 5_000));

        // The backup is restored as the relay's database, and the relay started again.
        resetCloudDatabase();
        fs.copyFileSync(backup, file);
        fs.rmSync(`${file}-wal`, { force: true });
        fs.rmSync(`${file}-shm`, { force: true });
        resetCloudDatabase(file);

        // Nothing is added by hand. The sweep credits the order the backup still knows, once and as a top-up. The
        // other has no row here, so nothing credits it: that is the case for `npm run cloud:credit`.
        expect(await sweepTopups()).toBe(1);
        expect(await sweepTopups()).toBe(0);
        expect(remainingSeconds(customerId)).toBe(140_000);
        expect(ledgerEntries(customerId, 10)).toEqual([
          expect.objectContaining({ kind: "topup", ref: order.orderId, amount_fen: 20_000 })
        ]);
        expect(orderById(later.value.orderId)).toBeUndefined();
      } finally {
        resetCloudDatabase();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it("logs a query that fails and goes on with the other orders", async () => {
      const { fake, customerId, order } = await pendingOrder();
      const later = await createTopup(customerId, { pack: "cny50", provider: "wechat" });
      if (!later.ok) throw new Error(later.error);
      fake.paidAtProvider.set(later.value.orderId, paid(later.value.orderId, "second", 5_000));
      const queryOrder = fake.provider.queryOrder;
      fake.provider.queryOrder = async (orderId) => {
        if (orderId === order.orderId) throw new Error("provider down");
        return queryOrder(orderId);
      };
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await sweepTopups()).toBe(1);
      expect(warned).toHaveBeenCalledWith(expect.stringContaining("order query failed"));
      expect(warned.mock.calls.flat().join("\n")).toContain("provider down");
      expect(orderById(later.value.orderId)?.status).toBe("paid");
      expect(orderById(order.orderId)?.status).toBe("pending");
    });

    it("asks nothing while Max Cloud is off", async () => {
      const { fake } = await pendingOrder();
      const queried = vi.spyOn(fake.provider, "queryOrder");
      delete process.env.CLOUD_SECRET_KEY;
      expect(await sweepTopups()).toBe(0);
      expect(queried).not.toHaveBeenCalled();
      process.env.CLOUD_SECRET_KEY = KEY.toString("base64");
    });

    describe("its timer", () => {
      afterEach(async () => {
        await stopTopupSweep(0);
        vi.useRealTimers();
        vi.restoreAllMocks();
      });

      it("does not keep the relay alive, is started once, and is cleared when the sweep stops", async () => {
        await pendingOrder();
        const scheduled: NodeJS.Timeout[] = [];
        const real = globalThis.setInterval;
        vi.spyOn(globalThis, "setInterval").mockImplementation((callback, ms) => {
          const timer = real(callback, ms);
          scheduled.push(timer);
          return timer;
        });
        const cleared = vi.spyOn(globalThis, "clearInterval");
        startTopupSweep();
        startTopupSweep();
        expect(scheduled).toHaveLength(1);
        expect(scheduled[0]!.hasRef()).toBe(false);
        await stopTopupSweep(1_000);
        expect(cleared).toHaveBeenCalledWith(scheduled[0]);
      });

      it("sweeps every minute, and not once it is stopped", async () => {
        vi.useFakeTimers();
        const { fake, customerId, order } = await pendingOrder();
        clock += 1_000;
        const unpaid = await createTopup(customerId, { pack: "cny50", provider: "wechat" });
        if (!unpaid.ok) throw new Error(unpaid.error);
        fake.paidAtProvider.set(order.orderId, paid(order.orderId, "sweep"));
        startTopupSweep();
        await vi.advanceTimersByTimeAsync(59_999);
        expect(orderById(order.orderId)?.status).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        expect(orderById(order.orderId)?.status).toBe("paid");
        await stopTopupSweep(1_000);
        // An order still waiting would be asked about every minute, had the sweep not stopped.
        const queried = vi.spyOn(fake.provider, "queryOrder");
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(queried).not.toHaveBeenCalled();
        expect(orderById(unpaid.value.orderId)?.status).toBe("pending");
      });

      it("runs one sweep at a time, and one that is waiting on the provider stops at its next order", async () => {
        vi.useFakeTimers();
        const { fake, customerId, order } = await pendingOrder();
        clock += 1_000;
        const next = await createTopup(customerId, { pack: "cny50", provider: "wechat" });
        if (!next.ok) throw new Error(next.error);
        // The provider does not answer for a while.
        let answer: (paid: PaidOrder | null) => void = () => {};
        const answering = new Promise<PaidOrder | null>((resolve) => {
          answer = resolve;
        });
        const queried = vi.spyOn(fake.provider, "queryOrder").mockImplementation(() => answering);
        startTopupSweep();
        await vi.advanceTimersByTimeAsync(3 * 60_000);
        expect(queried).toHaveBeenCalledTimes(1);
        const stopped = stopTopupSweep(5_000);
        answer(paid(order.orderId, "late"));
        await stopped;
        expect(orderById(order.orderId)?.status).toBe("paid");
        // The order after it is left for the next sweep.
        expect(queried).toHaveBeenCalledTimes(1);
        expect(orderById(next.value.orderId)?.status).toBe("pending");
      });
    });
  });

  describe("settling one order by hand", () => {
    it("credits an order the sweep has stopped asking about, once, as a notification would", async () => {
      const { fake, customerId, order } = await pendingOrder();
      // Closed as unpaid, then two days go by: outside the sweep's day, so nothing asks about it any more.
      clock += 15 * 60_000 + 1;
      await sweepTopups();
      expect(orderById(order.orderId)?.status).toBe("closed");
      clock += 2 * 24 * 3_600_000;
      // The provider's records show that it was paid after all.
      const payment = { orderId: order.orderId, providerTxnId: "by-hand", amountFen: order.amountFen };
      fake.paidAtProvider.set(order.orderId, payment);
      expect(await sweepTopups()).toBe(0);
      expect(orderById(order.orderId)?.status).toBe("closed");

      const queried = vi.spyOn(fake.provider, "queryOrder");
      expect(await settleOrder(order.orderId)).toMatchObject({ kind: "confirmed", credited: "credited" });
      expect(queried).toHaveBeenCalledTimes(1);
      expect(orderById(order.orderId)).toMatchObject({ status: "paid", provider_txn_id: "by-hand" });
      expect(remainingSeconds(customerId)).toBe(140_000);
      // A notification that arrives later, and running it again, change nothing.
      expect(creditPaidOrder(payment, "wechat")).toBe("duplicate");
      expect(await settleOrder(order.orderId)).toMatchObject({ kind: "confirmed", credited: "duplicate" });
      expect(queried).toHaveBeenCalledTimes(1);
      expect(remainingSeconds(customerId)).toBe(140_000);
      expect(ledgerEntries(customerId, 10).map((entry) => [entry.kind, entry.ref])).toEqual([["topup", order.orderId]]);
    });

    it("credits nothing for an order the provider says was not paid", async () => {
      const { customerId, order } = await pendingOrder();
      const settled = await settleOrder(order.orderId);
      expect(settled).toMatchObject({ kind: "unpaid", order: { id: order.orderId, status: "pending" } });
      expect(remainingSeconds(customerId)).toBe(60_000);
      expect(orderById(order.orderId)?.status).toBe("pending");
    });

    it("refuses an unknown order and a provider that is not configured, asking no one", async () => {
      const { fake, order } = await pendingOrder();
      const queried = vi.spyOn(fake.provider, "queryOrder");
      expect(await settleOrder("mcunknown0000000000000000000000")).toEqual({ kind: "unknown-order" });
      expect(await settleOrder("not an order id")).toEqual({ kind: "unknown-order" });
      setCloudPaymentProviders([]);
      expect(await settleOrder(order.orderId)).toMatchObject({
        kind: "provider-missing",
        order: { id: order.orderId }
      });
      expect(queried).not.toHaveBeenCalled();
      expect(orderById(order.orderId)?.status).toBe("pending");
    });
  });
});

describe("deleting a project", () => {
  it("removes it with its conversations, or neither when the conversations cannot be removed", async () => {
    const customerId = await newCustomer();
    const { project } = newProject(customerId);
    insertConversation({
      id: "con_1",
      customer_id: customerId,
      project_id: project.id,
      started_at: clock,
      ended_at: clock + 30_000,
      seconds: 30,
      source: "api",
      preview: "Hello",
      turns: "[]"
    });
    // The transcripts cannot be deleted (the disk is full, say).
    immediate((db) =>
      db.exec(
        "CREATE TRIGGER broken BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END"
      )
    );
    expect(() => deleteProject(customerId, project.id)).toThrow(/database or disk is full/);
    // Nothing was half deleted: the project is still there, so the customer's retry can delete it.
    expect(liveProject(project.id, customerId)).toMatchObject({ id: project.id });
    expect(projectConversations(project.id, customerId, 10)).toHaveLength(1);
    immediate((db) => db.exec("DROP TRIGGER broken"));
    expect(deleteProject(customerId, project.id)).toEqual({ ok: true, value: { ok: true } });
    expect(liveProject(project.id, customerId)).toBeUndefined();
    expect(projectConversations(project.id, customerId, 10)).toEqual([]);
  });
});
