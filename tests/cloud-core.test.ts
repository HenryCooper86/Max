import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chargeSession, cloudEnabled, projectForApiKey, projectRuntime, remainingSeconds } from "../server/cloud";
import { bookedSeconds, secondsForFen, usageCharge } from "../server/cloud/billing";
import { setCloudClock, setCloudPaymentProviders } from "../server/cloud/context";
import { createProject, patchProject, rotateProjectKey, deleteProject, signup } from "../server/cloud/customers";
import type { PaidOrder, PaymentProvider, QrOrder } from "../server/cloud/payments";
import { decryptModelKey, encryptModelKey } from "../server/cloud/secrets";
import { resetCloudDatabase } from "../server/cloud/store";
import { createTopup, creditPaidOrder, topupStatus } from "../server/cloud/topups";

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
  it("round-trips under AES-256-GCM in the v1 format with a fresh IV each time", () => {
    const first = encryptModelKey("sk-live-secret", KEY, "prj_a");
    const second = encryptModelKey("sk-live-secret", KEY, "prj_a");
    expect(first).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(first.split(":")[1]!, "base64")).toHaveLength(12);
    expect(first).not.toBe(second);
    expect(first).not.toContain("sk-live-secret");
    expect(decryptModelKey(first, KEY, "prj_a")).toBe("sk-live-secret");
    expect(decryptModelKey(second, KEY, "prj_a")).toBe("sk-live-secret");
  });

  it("refuses tampered ciphertext, another key, or another project's row", () => {
    const stored = encryptModelKey("sk-live-secret", KEY, "prj_a");
    const [version, iv, tag, ciphertext] = stored.split(":");
    const flipped = Buffer.from(ciphertext!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(decryptModelKey([version, iv, tag, flipped.toString("base64")].join(":"), KEY, "prj_a")).toBeUndefined();
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
    expect(projectForApiKey(apiKey)).toEqual({ projectId: project.id, customerId });
    expect(projectForApiKey(`${apiKey}x`)).toBeUndefined();
    expect(projectForApiKey("mcs_whatever")).toBeUndefined();
    expect(projectForApiKey("")).toBeUndefined();

    const rotated = rotateProjectKey(customerId, project.id);
    if (!rotated.ok) throw new Error(rotated.error);
    expect(projectForApiKey(apiKey)).toBeUndefined();
    expect(projectForApiKey(rotated.value.apiKey)).toEqual({ projectId: project.id, customerId });

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
      backend: "gemini",
      modelKey: "sk-proj-abc",
      assistantName: "Assistant"
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
    expect(creditPaidOrder(paid, "wechat")).toBe("credited");
    expect(creditPaidOrder(paid, "wechat")).toBe("duplicate");
    expect(creditPaidOrder({ ...paid, providerTxnId: "4200002" }, "wechat")).toBe("duplicate");
    expect(remainingSeconds(customerId)).toBe(60_000 + 80_000);
    expect(await topupStatus(customerId, order.orderId)).toEqual({ ok: true, value: { status: "paid" } });
  });

  it("refuses a wrong amount, another provider, an unknown order or a malformed one", async () => {
    const { customerId, order } = await pendingOrder();
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
    expect(await topupStatus(customerId, order.orderId)).toEqual({ ok: true, value: { status: "pending" } });
  });

  it("asks the provider about a pending order and credits what it confirms", async () => {
    const { fake, customerId, order } = await pendingOrder();
    expect((await topupStatus(customerId, order.orderId)).ok).toBe(true);
    fake.paidAtProvider.set(order.orderId, { orderId: order.orderId, providerTxnId: "q1", amountFen: 20_000 });
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
});
