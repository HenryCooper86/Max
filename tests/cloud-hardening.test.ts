// Regressions for the Max Cloud security review: token floods, crash-proof
// billing, revoked keys, provider polling and the test payment provider.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloudSessionAlive,
  cloudSessionStarted,
  projectForApiKey,
  projectKeyValid,
  recoverCloudSessions,
  remainingSeconds
} from "../server/cloud";
import { setCloudClock, setCloudPaymentProviders } from "../server/cloud/context";
import { createProject, deleteProject, rotateProjectKey, signup } from "../server/cloud/customers";
import { createTestProvider } from "../server/cloud/payments/test-provider";
import type { PaymentProvider } from "../server/cloud/payments";
import { resetCloudDatabase } from "../server/cloud/store";
import { createTopup, topupStatus } from "../server/cloud/topups";
import { createSessionTokenStore } from "../server/session-tokens";

const START = Date.UTC(2026, 10, 18, 12, 0, 0);
let clock = START;
const saved = { key: process.env.CLOUD_SECRET_KEY, url: process.env.CLOUD_PUBLIC_URL };

beforeEach(() => {
  process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.CLOUD_PUBLIC_URL = "https://max.example.com";
  resetCloudDatabase(":memory:");
  clock = START;
  setCloudClock(() => clock);
  setCloudPaymentProviders([]);
});

afterEach(() => {
  resetCloudDatabase();
  setCloudClock();
  setCloudPaymentProviders();
  for (const [name, value] of [
    ["CLOUD_SECRET_KEY", saved.key],
    ["CLOUD_PUBLIC_URL", saved.url]
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function customerWithProject() {
  const account = await signup(`c${randomBytes(4).toString("hex")}@example.com`, "correct horse battery");
  if (!account.ok) throw new Error(account.error);
  const customerId = account.value.customer.id;
  const project = createProject(customerId, { name: "Shop" });
  if (!project.ok) throw new Error(project.error);
  return { customerId, projectId: project.value.project.id, apiKey: project.value.apiKey };
}

describe("project session tokens", () => {
  it("a project can only push out its own tokens, never anyone else's", () => {
    const store = createSessionTokenStore(() => 1_000, { maxLive: 50, perProject: 3 });
    const relay = store.mint({});
    if (!relay.ok) throw new Error(relay.error);
    const flood = { projectId: "p-flood", customerId: "c1", keyHash: "h" };
    const own: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const minted = store.mint({}, flood);
      if (minted.ok) own.push(minted.token);
    }
    expect(store.grant(relay.token)).toBeDefined();
    expect(own.filter((token) => store.grant(token)).length).toBe(3);
    expect(store.size()).toBe(4);
  });

  it("caps the context a Cloud token may carry", () => {
    const store = createSessionTokenStore(() => 1_000, { maxContextChars: 1_000 });
    expect(store.mint({ context: "x".repeat(1_001) })).toMatchObject({ ok: false });
    expect(store.mint({ context: "x".repeat(1_000) })).toMatchObject({ ok: true });
  });
});

describe("revoked project keys", () => {
  it("end once the key is rotated or the project deleted", async () => {
    const { customerId, projectId, apiKey } = await customerWithProject();
    const project = projectForApiKey(apiKey);
    if (!project) throw new Error("no project");
    expect(projectKeyValid(projectId, project.keyHash)).toBe(true);
    rotateProjectKey(customerId, projectId);
    expect(projectKeyValid(projectId, project.keyHash)).toBe(false);
    const fresh = await customerWithProject();
    const freshKey = projectForApiKey(fresh.apiKey)!;
    deleteProject(fresh.customerId, fresh.projectId);
    expect(projectKeyValid(fresh.projectId, freshKey.keyHash)).toBe(false);
  });
});

describe("crash-proof billing", () => {
  it("books sessions left open by a crash, up to their last checkpoint, exactly once", async () => {
    const { customerId, projectId } = await customerWithProject();
    const before = remainingSeconds(customerId);
    cloudSessionStarted({ sessionId: "s-crash", customerId, projectId });
    clock += 90_000;
    cloudSessionAlive("s-crash");
    clock += 10_000; // the process dies before the next checkpoint
    expect(recoverCloudSessions()).toBe(1);
    expect(before - remainingSeconds(customerId)).toBe(90);
    expect(recoverCloudSessions()).toBe(0);
  });
});

describe("order status polling", () => {
  it("asks the payment provider at most once every few seconds per order", async () => {
    const { customerId } = await customerWithProject();
    const queryOrder = vi.fn(async () => null);
    const provider: PaymentProvider = {
      id: "wechat",
      configured: () => true,
      createQrOrder: async (order) => ({ qrCode: `weixin://x?${order.orderId}` }),
      parseNotification: async () => null,
      notificationAnswer: () => ({ status: 204, contentType: "text/plain", body: "" }),
      queryOrder,
      closeOrder: async () => {}
    };
    setCloudPaymentProviders([provider]);
    const order = await createTopup(customerId, { pack: "cny50", provider: "wechat" });
    if (!order.ok) throw new Error(order.error);
    for (let index = 0; index < 20; index += 1) await topupStatus(customerId, order.value.orderId);
    expect(queryOrder).toHaveBeenCalledTimes(1);
    clock += 3_000;
    await topupStatus(customerId, order.value.orderId);
    expect(queryOrder).toHaveBeenCalledTimes(2);
  });
});

describe("the test payment provider", () => {
  it("never runs on a relay the public can reach", () => {
    const on = { CLOUD_PAYMENTS_TEST: "on", NODE_ENV: "development" };
    expect(createTestProvider({ env: { ...on } }).configured()).toBe(true);
    expect(createTestProvider({ env: { ...on, CLOUD_PUBLIC_URL: "http://localhost:8787" } }).configured()).toBe(true);
    expect(createTestProvider({ env: { ...on, CLOUD_PUBLIC_URL: "https://max.example.com" } }).configured()).toBe(
      false
    );
    expect(createTestProvider({ env: { ...on, NODE_ENV: "production" } }).configured()).toBe(false);
  });
});
