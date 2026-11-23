import { DEFAULT_STUDIO } from "../shared/cloud-studio";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import dns from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAuthRateLimit } from "../server/auth";
import { config } from "../server/runtime-config";
import {
  chargeSession,
  projectForApiKey,
  registerCloudPaymentRoutes,
  registerCloudRoutes,
  remainingSeconds
} from "../server/cloud";
import { setCloudClock, setCloudPaymentProviders } from "../server/cloud/context";
import type { PaidOrder, PaymentProvider } from "../server/cloud/payments";
import { resetCloudDatabase } from "../server/cloud/store";

const KEY = randomBytes(32).toString("base64");
const START = Date.UTC(2026, 10, 18, 12, 0, 0);
const PASSWORD = "correct horse battery";
const ENV_NAMES = ["CLOUD_SECRET_KEY", "CLOUD_PUBLIC_URL", "STUDIO_DIR"] as const;
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

let clock = START;
let server: Server | undefined;
let base = "";
let temporaryDirectory: string | undefined;
// Every response body seen, to prove no model key ever leaves the server.
let seenBodies: string[] = [];

/** A provider whose notifications are trusted when they carry `x-fake-signature: good`. */
function fakeProvider(id: PaymentProvider["id"] = "wechat") {
  const closed: string[] = [];
  const provider: PaymentProvider = {
    id,
    configured: () => true,
    createQrOrder: async (order) => ({ qrCode: `${id}://pay/${order.orderId}` }),
    parseNotification: async ({ headers, rawBody }) => {
      if (headers["x-fake-signature"] === "boom") throw new Error("verification crashed");
      if (headers["x-fake-signature"] !== "good") return null;
      return JSON.parse(rawBody) as PaidOrder;
    },
    notificationAnswer: (accepted) =>
      accepted
        ? { status: 204, contentType: "text/plain", body: "" }
        : { status: 400, contentType: "application/json", body: '{"code":"FAIL","message":"refused"}' },
    queryOrder: async () => null,
    closeOrder: async (orderId) => {
      closed.push(orderId);
    }
  };
  return { provider, closed };
}

async function startApp(): Promise<void> {
  const app = express();
  registerCloudPaymentRoutes(app);
  app.use(express.json({ limit: "32kb", strict: true }));
  registerCloudRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

type Call = { status: number; body: Record<string, unknown>; text: string; headers: Headers };

async function call(
  method: string,
  route: string,
  options: { token?: string; json?: unknown; raw?: string; headers?: Record<string, string> } = {}
): Promise<Call> {
  const headers: Record<string, string> = { Connection: "close", ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let requestBody: string | undefined = options.raw;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${route}`, { method, headers, body: requestBody, redirect: "manual" });
  const text = await response.text();
  seenBodies.push(text);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: response.status, body, text, headers: response.headers };
}

async function signupCustomer(email = `c${randomBytes(4).toString("hex")}@example.com`) {
  const response = await call("POST", "/cloud/api/signup", { json: { email, password: PASSWORD } });
  expect(response.status).toBe(201);
  return { token: response.body.token as string, customer: response.body.customer as { id: string; email: string } };
}

async function createProject(token: string, name = "Shop") {
  const response = await call("POST", "/cloud/api/projects", { token, json: { name } });
  expect(response.status).toBe(201);
  return response.body as { project: { id: string; keyPrefix: string }; apiKey: string };
}

describe("a project's flow over HTTP", () => {
  it("is read and saved as the flow builder draws it, by its owner alone", async () => {
    await startApp();
    const owner = await signupCustomer();
    const { project } = await createProject(owner.token);
    const route = `/cloud/api/projects/${project.id}/flow`;
    const tool = {
      name: "check_order",
      description: "Look up an order's status by its number.",
      url: "https://api.example.com/tools/order",
      parameters: []
    };
    await call("PATCH", `/cloud/api/projects/${project.id}`, {
      token: owner.token,
      json: { studio: { tools: [tool] } }
    });
    // One agent: the start alone, and the tools a step could be limited to.
    expect((await call("GET", route, { token: owner.token })).body).toEqual({
      ok: true,
      steps: [{ id: "main" }],
      problems: [],
      tools: ["check_order"]
    });
    const steps = [
      { id: "main", handoffs: [{ to: "refunds", when: "Money back." }], at: [40, 40] },
      {
        id: "refunds",
        description: "Refunds.",
        instructions: "Refund politely.",
        tools: ["check_order"],
        at: [440, 40]
      }
    ];
    const saved = await call("PUT", route, { token: owner.token, json: { steps } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ ok: true, steps, tools: ["check_order"], problems: [] });
    // The project comes back too, for the rest of the Studio: its other settings are as they were.
    expect(saved.body.project.studio.flow).toEqual(steps);
    expect(saved.body.project.studio.tools).toEqual([tool]);
    expect((await call("GET", route, { token: owner.token })).body.steps).toEqual(steps);

    // A request that names no steps changes nothing: it is not read as "no flow".
    for (const json of [{}, { steps: "main" }, { flow: [] }]) {
      expect(await call("PUT", route, { token: owner.token, json })).toMatchObject({
        status: 400,
        body: { error: "The flow must be a list of steps." }
      });
    }
    // Nor does a save of the settings that says nothing of the flow.
    const patched = await call("PATCH", `/cloud/api/projects/${project.id}`, {
      token: owner.token,
      json: { studio: { tools: [tool], voice: "cedar" } }
    });
    expect(patched.body.project.studio).toMatchObject({ voice: "cedar", flow: steps });
    const refused = await call("PUT", route, {
      token: owner.token,
      json: { steps: [{ id: "main", handoffs: [{ to: "nowhere" }] }] }
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("there is no agent nowhere to hand over to");
    expect((await call("GET", route, { token: owner.token })).body.steps).toEqual(steps);

    const other = await signupCustomer();
    expect((await call("GET", route, { token: other.token })).status).toBe(404);
    expect((await call("PUT", route, { token: other.token, json: { steps: [] } })).status).toBe(404);
    expect((await call("GET", route)).status).toBe(401);
    expect((await call("PUT", route, { json: { steps: [] } })).status).toBe(401);
    expect((await call("GET", route, { token: owner.token })).body.steps).toEqual(steps);
  });
});

describe("a project's conversation webhook over HTTP", () => {
  it("tests the saved address, shows how the last delivery went, and is the owner's alone", async () => {
    await startApp();
    const owner = await signupCustomer();
    const { project } = await createProject(owner.token);
    const route = `/cloud/api/projects/${project.id}/conversation-webhook`;
    // Nothing saved yet: nothing to test.
    expect((await call("GET", route, { token: owner.token })).body).toEqual({ url: "", last: null });
    expect(await call("POST", `${route}/test`, { token: owner.token })).toMatchObject({
      status: 400,
      body: { ok: false, error: "Save the address first." }
    });
    const saved = await call("PATCH", `/cloud/api/projects/${project.id}`, {
      token: owner.token,
      json: { studio: { conversationWebhook: "https://hooks.example.com/max" } }
    });
    expect(saved.status).toBe(200);
    expect((await call("GET", route, { token: owner.token })).body).toEqual({
      url: "https://hooks.example.com/max",
      last: null
    });
    // The request goes out by the rules of a tool call: a name that leads to a private address is refused.
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockImplementation(((
        _host: string,
        _options: unknown,
        callback: (error: null, addresses: dns.LookupAddress[]) => void
      ) => callback(null, [{ address: "127.0.0.1", family: 4 }])) as unknown as typeof dns.lookup);
    const tested = await call("POST", `${route}/test`, { token: owner.token });
    lookup.mockRestore();
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ ok: false, error: "the address must be public, not a private one" });
    // Another customer has no such project.
    const other = await signupCustomer();
    expect((await call("GET", route, { token: other.token })).status).toBe(404);
    expect((await call("POST", `${route}/test`, { token: other.token })).status).toBe(404);
    expect((await call("GET", route)).status).toBe(401);
  });
});

describe("a project's traces collector over HTTP", () => {
  it("keeps its headers secret, and tests the saved endpoint for its owner alone", async () => {
    await startApp();
    const owner = await signupCustomer();
    const { project } = await createProject(owner.token);
    const route = `/cloud/api/projects/${project.id}/traces-test`;
    // Nothing saved yet: nothing to test.
    expect(await call("POST", route, { token: owner.token })).toMatchObject({
      status: 400,
      body: { ok: false, error: "Save the endpoint first." }
    });
    const secret = "x-api-key=sk-lf-very-secret-value";
    const saved = await call("PATCH", `/cloud/api/projects/${project.id}`, {
      token: owner.token,
      json: {
        studio: { traces: { endpoint: "https://collector.example.com/v1/traces", content: false } },
        tracesHeaders: secret
      }
    });
    expect(saved.status).toBe(200);
    expect(saved.body.project).toMatchObject({
      hasTracesHeaders: true,
      studio: { traces: { endpoint: "https://collector.example.com/v1/traces", content: false } }
    });
    expect((await call("GET", "/cloud/api/projects", { token: owner.token })).body.projects).toMatchObject([
      { hasTracesHeaders: true }
    ]);
    const refused = await call("PATCH", `/cloud/api/projects/${project.id}`, {
      token: owner.token,
      json: { tracesHeaders: "host=evil.example.com" }
    });
    expect(refused).toMatchObject({ status: 400, body: { error: "The host header cannot be set here." } });
    // The request goes out by the rules of a tool call: a name that leads to a private address is refused.
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockImplementation(((
        _host: string,
        _options: unknown,
        callback: (error: null, addresses: dns.LookupAddress[]) => void
      ) => callback(null, [{ address: "127.0.0.1", family: 4 }])) as unknown as typeof dns.lookup);
    const tested = await call("POST", route, { token: owner.token });
    lookup.mockRestore();
    expect(tested.status).toBe(200);
    expect(tested.body).toEqual({ ok: false, error: "the address must be public, not a private one" });
    // Another customer has no such project.
    const other = await signupCustomer();
    expect((await call("POST", route, { token: other.token })).status).toBe(404);
    expect((await call("POST", route)).status).toBe(401);
    // Nothing the server said held the headers.
    expect(seenBodies.join("\n")).not.toContain("sk-lf-very-secret-value");
  });
});

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

beforeEach(async () => {
  process.env.CLOUD_SECRET_KEY = KEY;
  delete process.env.CLOUD_PUBLIC_URL;
  resetCloudDatabase(":memory:");
  clock = START;
  setCloudClock(() => clock);
  setCloudPaymentProviders([]);
  resetAuthRateLimit();
  seenBodies = [];
  await startApp();
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  }
  resetCloudDatabase();
  setCloudClock();
  setCloudPaymentProviders();
  resetAuthRateLimit();
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("without CLOUD_SECRET_KEY", () => {
  it("answers every /cloud route with 503", async () => {
    delete process.env.CLOUD_SECRET_KEY;
    setCloudPaymentProviders([fakeProvider("wechat").provider, fakeProvider("test").provider]);
    const routes: Array<[string, string]> = [
      ["GET", "/cloud/api/packs"],
      ["POST", "/cloud/api/signup"],
      ["POST", "/cloud/api/login"],
      ["GET", "/cloud/api/me"],
      ["GET", "/cloud/api/projects"],
      ["POST", "/cloud/pay/wechat/notify"],
      ["GET", "/cloud/pay/test/mc123456"],
      ["GET", "/cloud/anything"]
    ];
    for (const [method, route] of routes) {
      const response = await call(method, route, method === "POST" ? { json: {} } : {});
      expect(response.status, route).toBe(503);
      expect(response.body, route).toEqual({ ok: false, error: "Max Cloud is not configured" });
      expect(response.headers.get("cache-control"), route).toBe("no-store");
    }
    const malformed = await call("POST", "/cloud/api/signup", {
      raw: "{not json",
      headers: { "Content-Type": "application/json" }
    });
    expect(malformed.status).toBe(503);
  });

  it("keeps even a rejected JSON body uncached while on", async () => {
    const malformed = await call("POST", "/cloud/api/signup", {
      raw: "{not json",
      headers: { "Content-Type": "application/json" }
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("no-store");
  });
});

describe("customer accounts", () => {
  it("signs up, reads me, logs out and logs back in", async () => {
    const signup = await call("POST", "/cloud/api/signup", {
      json: { email: "  Dev@Example.COM ", password: PASSWORD }
    });
    expect(signup.status).toBe(201);
    expect(signup.headers.get("cache-control")).toBe("no-store");
    const token = signup.body.token as string;
    expect(token).toMatch(/^mcs_[A-Za-z0-9_-]{43}$/);
    expect(signup.body.customer).toEqual({
      id: expect.stringMatching(/^cus_/),
      email: "dev@example.com",
      createdAt: START
    });

    const me = await call("GET", "/cloud/api/me", { token });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      customer: { id: (signup.body.customer as { id: string }).id, email: "dev@example.com", createdAt: START },
      balance: { fen: 0, freeSecondsLeft: 60_000, month: "2026-11" }
    });

    expect((await call("POST", "/cloud/api/logout", { token })).body).toEqual({ ok: true });
    expect((await call("GET", "/cloud/api/me", { token })).status).toBe(401);
    expect((await call("POST", "/cloud/api/logout", { token })).status).toBe(401);

    const login = await call("POST", "/cloud/api/login", { json: { email: "DEV@example.com", password: PASSWORD } });
    expect(login.status).toBe(200);
    expect(login.body.token).not.toBe(token);
    expect((await call("GET", "/cloud/api/me", { token: login.body.token as string })).status).toBe(200);
  });

  it("refuses a taken email, a wrong password and malformed input", async () => {
    await signupCustomer("taken@example.com");
    const duplicate = await call("POST", "/cloud/api/signup", {
      json: { email: "TAKEN@example.com", password: "another password" }
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.ok).toBe(false);

    const wrong = await call("POST", "/cloud/api/login", {
      json: { email: "taken@example.com", password: "nope nope nope" }
    });
    const unknown = await call("POST", "/cloud/api/login", { json: { email: "who@example.com", password: PASSWORD } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual({ ok: false, error: "Wrong email or password" });
    expect(unknown.body).toEqual(wrong.body);

    const bad: unknown[] = [
      { email: "not-an-email", password: PASSWORD },
      { email: `${"a".repeat(250)}@example.com`, password: PASSWORD },
      { email: "a@b", password: PASSWORD },
      { email: "x@example.com", password: "short" },
      { email: "x@example.com", password: "p".repeat(201) },
      { email: 5, password: PASSWORD }
    ];
    for (const json of bad) {
      expect((await call("POST", "/cloud/api/signup", { json })).status, JSON.stringify(json)).toBe(400);
    }
  });

  it("ignores staff tokens and garbage, and expires sessions after 30 days", async () => {
    const { token } = await signupCustomer();
    for (const presented of ["sess_abc", "mcs_wrong", token.slice(0, -1)]) {
      expect((await call("GET", "/cloud/api/me", { token: presented })).status).toBe(401);
    }
    expect((await call("GET", "/cloud/api/me")).status).toBe(401);
    clock += 30 * 86_400_000 - 1;
    expect((await call("GET", "/cloud/api/me", { token })).status).toBe(200);
    clock += 1;
    expect((await call("GET", "/cloud/api/me", { token })).status).toBe(401);
  });

  it("rate-limits signup and login per client address", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= config.authAttemptsPerMinute; attempt += 1) {
      const route = attempt % 2 ? "/cloud/api/login" : "/cloud/api/signup";
      statuses.push((await call("POST", route, { json: { email: "x", password: "y" } })).status);
    }
    expect(statuses.slice(0, -1).every((status) => status === 400 || status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("projects", () => {
  it("creates, updates, rotates and deletes a project, showing the key only once", async () => {
    const { token } = await signupCustomer();
    const created = await createProject(token);
    expect(created.apiKey).toMatch(/^mpk_[A-Za-z0-9_-]{43}$/);
    expect(created.project).toEqual({
      id: expect.stringMatching(/^prj_/),
      name: "Shop",
      keyPrefix: created.apiKey.slice(0, 8),
      backend: "openai",
      hasModelKey: false,
      hasTracesHeaders: false,
      assistantName: "",
      instructions: "",
      greeting: "",
      studio: { ...DEFAULT_STUDIO, keepConversations: true },
      publicId: expect.stringMatching(/^pub_[0-9a-f]{24}$/),
      hasWebhookSecret: false,
      monthlyMinutesCap: null,
      analysisOnOwnKey: true,
      createdAt: START
    });
    const id = created.project.id;

    const list = await call("GET", "/cloud/api/projects", { token });
    expect(list.body).toEqual({ projects: [created.project] });
    expect(list.text).not.toContain(created.apiKey);

    const patched = await call("PATCH", `/cloud/api/projects/${id}`, {
      token,
      json: {
        name: " Help desk ",
        backend: "grok",
        modelKey: "xai-SECRET-model-key-123",
        assistantName: "Ava",
        instructions: "Answer in one line.\nBe kind.",
        greeting: "Hello!"
      }
    });
    expect(patched.status).toBe(200);
    expect(patched.body.project).toMatchObject({
      name: "Help desk",
      backend: "grok",
      hasModelKey: true,
      assistantName: "Ava",
      instructions: "Answer in one line.\nBe kind.",
      greeting: "Hello!"
    });
    expect(
      (await call("PATCH", `/cloud/api/projects/${id}`, { token, json: { name: "Renamed" } })).body.project
    ).toMatchObject({ name: "Renamed", hasModelKey: true, backend: "grok" });
    expect(
      (await call("PATCH", `/cloud/api/projects/${id}`, { token, json: { modelKey: "" } })).body.project
    ).toMatchObject({ hasModelKey: false });
    await call("PATCH", `/cloud/api/projects/${id}`, { token, json: { modelKey: "xai-SECRET-model-key-123" } });

    const rotated = await call("POST", `/cloud/api/projects/${id}/rotate-key`, { token });
    expect(rotated.status).toBe(200);
    const newKey = rotated.body.apiKey as string;
    expect(newKey).not.toBe(created.apiKey);
    expect((rotated.body.project as { keyPrefix: string }).keyPrefix).toBe(newKey.slice(0, 8));
    expect(projectForApiKey(created.apiKey)).toBeUndefined();
    expect(projectForApiKey(newKey)?.projectId).toBe(id);

    expect((await call("DELETE", `/cloud/api/projects/${id}`, { token })).body).toEqual({ ok: true });
    expect(projectForApiKey(newKey)).toBeUndefined();
    expect((await call("GET", "/cloud/api/projects", { token })).body).toEqual({ projects: [] });
    expect((await call("PATCH", `/cloud/api/projects/${id}`, { token, json: { name: "x" } })).status).toBe(404);
    expect((await call("DELETE", `/cloud/api/projects/${id}`, { token })).status).toBe(404);

    for (const body of seenBodies) expect(body).not.toContain("SECRET-model-key");
  });

  it("validates every field", async () => {
    const { token } = await signupCustomer();
    const { project } = await createProject(token);
    const invalid: unknown[] = [
      { backend: "anthropic" },
      { backend: 3 },
      { name: "" },
      { name: "n".repeat(61) },
      { name: "line\nbreak" },
      { assistantName: "a".repeat(25) },
      { instructions: "i".repeat(8001) },
      { greeting: "g".repeat(301) },
      { modelKey: "k".repeat(401) },
      { modelKey: "two words" },
      { modelKey: 42 }
    ];
    for (const json of invalid) {
      const response = await call("PATCH", `/cloud/api/projects/${project.id}`, { token, json });
      expect(response.status, JSON.stringify(json)).toBe(400);
      expect(response.body.ok).toBe(false);
    }
    const atLimits = await call("PATCH", `/cloud/api/projects/${project.id}`, {
      token,
      json: {
        name: "n".repeat(60),
        assistantName: "a".repeat(24),
        instructions: "i".repeat(8000),
        greeting: "g".repeat(300),
        modelKey: "k".repeat(400)
      }
    });
    expect(atLimits.status).toBe(200);
    expect((await call("POST", "/cloud/api/projects", { token, json: {} })).status).toBe(400);
    expect((await call("POST", "/cloud/api/projects", { token, json: { name: "   " } })).status).toBe(400);
  });

  it("keeps each customer's projects to themselves", async () => {
    const alice = await signupCustomer();
    const bob = await signupCustomer();
    const { project } = await createProject(alice.token, "Alice's");
    expect((await call("GET", "/cloud/api/projects", { token: bob.token })).body).toEqual({ projects: [] });
    expect(
      (await call("PATCH", `/cloud/api/projects/${project.id}`, { token: bob.token, json: { modelKey: "sk-bob" } }))
        .status
    ).toBe(404);
    expect((await call("POST", `/cloud/api/projects/${project.id}/rotate-key`, { token: bob.token })).status).toBe(404);
    expect((await call("DELETE", `/cloud/api/projects/${project.id}`, { token: bob.token })).status).toBe(404);
    const aliceList = await call("GET", "/cloud/api/projects", { token: alice.token });
    expect(aliceList.body.projects).toEqual([expect.objectContaining({ id: project.id, hasModelKey: false })]);
  });

  it("stores the database privately and never in plain text: tokens, API keys, model keys, passwords", async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "max-cloud-"));
    process.env.STUDIO_DIR = temporaryDirectory;
    resetCloudDatabase();
    const { token } = await signupCustomer();
    const { project, apiKey } = await createProject(token);
    await call("PATCH", `/cloud/api/projects/${project.id}`, { token, json: { modelKey: "sk-PLAINTEXT-NEVER" } });
    const file = path.join(temporaryDirectory, "cloud.sqlite");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    resetCloudDatabase(":memory:");
    const stored = [file, `${file}-wal`]
      .filter((candidate) => fs.existsSync(candidate))
      .map((candidate) => fs.readFileSync(candidate).toString("latin1"))
      .join("");
    expect(stored).toContain("prj_");
    for (const secret of [token, apiKey, "sk-PLAINTEXT-NEVER", PASSWORD]) expect(stored).not.toContain(secret);
  });
});

describe("balance, usage and ledger", () => {
  it("reports this month's usage per project and the latest ledger entries", async () => {
    const { token, customer } = await signupCustomer();
    const { project } = await createProject(token, "Kiosk");
    const other = await createProject(token, "Phone");
    chargeSession({ customerId: customer.id, projectId: project.id, sessionId: "a", seconds: 59_990, endedAt: clock });
    chargeSession({
      customerId: customer.id,
      projectId: other.project.id,
      sessionId: "b",
      seconds: 70,
      endedAt: clock
    });
    chargeSession({
      customerId: customer.id,
      projectId: other.project.id,
      sessionId: "b",
      seconds: 70,
      endedAt: clock
    });
    chargeSession({
      customerId: customer.id,
      projectId: project.id,
      sessionId: "last-month",
      seconds: 600,
      endedAt: Date.UTC(2026, 9, 31, 12)
    });

    const usage = await call("GET", "/cloud/api/usage", { token });
    expect(usage.body).toEqual({
      month: "2026-11",
      seconds: 60_060,
      minutes: 1001,
      freeSecondsUsed: 60_000,
      chargedFen: 15,
      projects: [
        { projectId: project.id, name: "Kiosk", seconds: 59_990, chargedFen: 0 },
        { projectId: other.project.id, name: "Phone", seconds: 70, chargedFen: 15 }
      ]
    });
    const october = await call("GET", "/cloud/api/usage?month=2026-10", { token });
    expect(october.body).toMatchObject({ month: "2026-10", seconds: 600, freeSecondsUsed: 600, chargedFen: 0 });
    expect((await call("GET", "/cloud/api/usage?month=2026-13", { token })).status).toBe(400);
    expect((await call("GET", "/cloud/api/usage?month=nope", { token })).status).toBe(400);

    const me = await call("GET", "/cloud/api/me", { token });
    expect(me.body.balance).toEqual({ fen: -15, freeSecondsLeft: 0, month: "2026-11" });
    expect(remainingSeconds(customer.id)).toBe(-60);

    const ledger = await call("GET", "/cloud/api/ledger", { token });
    const entries = ledger.body.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      id: expect.any(Number),
      kind: "usage",
      amountFen: 0,
      seconds: 600,
      projectId: project.id,
      ref: "last-month",
      createdAt: START
    });
    expect(entries[1]).toMatchObject({ kind: "usage", amountFen: -15, seconds: 70, ref: "b" });

    const stranger = await signupCustomer();
    expect((await call("GET", "/cloud/api/ledger", { token: stranger.token })).body).toEqual({ entries: [] });
  });
});

describe("top-ups over HTTP", () => {
  async function customerWithOrder(providers = [fakeProvider("wechat")]) {
    setCloudPaymentProviders(providers.map((fake) => fake.provider));
    process.env.CLOUD_PUBLIC_URL = "https://max.example.com";
    const { token, customer } = await signupCustomer();
    const created = await call("POST", "/cloud/api/topups", { token, json: { pack: "cny50", provider: "wechat" } });
    expect(created.status).toBe(201);
    return { token, customer, order: created.body as { orderId: string; amountFen: number } };
  }

  function notify(provider: string, paid: unknown, signature = "good", raw?: string) {
    return call("POST", `/cloud/pay/${provider}/notify`, {
      raw: raw ?? JSON.stringify(paid),
      headers: { "Content-Type": "application/json", "x-fake-signature": signature }
    });
  }

  it("lists packs and the configured providers without a login", async () => {
    setCloudPaymentProviders([fakeProvider("wechat").provider, fakeProvider("alipay").provider]);
    const packs = await call("GET", "/cloud/api/packs");
    expect(packs.body).toEqual({
      packs: [
        { id: "cny50", fen: 5000 },
        { id: "cny200", fen: 20000 },
        { id: "cny1000", fen: 100000 }
      ],
      providers: ["wechat", "alipay"]
    });
  });

  it("credits a notified payment once, however often it is notified", async () => {
    const { token, order } = await customerWithOrder();
    expect(order).toMatchObject({ provider: "wechat", amountFen: 5000, qrCode: `wechat://pay/${order.orderId}` });
    expect((await call("GET", `/cloud/api/topups/${order.orderId}`, { token })).body).toEqual({ status: "pending" });

    const paid = { orderId: order.orderId, providerTxnId: "42000001", amountFen: 5000 };
    const first = await notify("wechat", paid);
    const second = await notify("wechat", paid);
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect((await call("GET", `/cloud/api/topups/${order.orderId}`, { token })).body).toEqual({ status: "paid" });
    expect(((await call("GET", "/cloud/api/me", { token })).body.balance as { fen: number }).fen).toBe(5000);
    const entries = (await call("GET", "/cloud/api/ledger", { token })).body.entries as Array<Record<string, unknown>>;
    expect(entries).toEqual([
      { id: expect.any(Number), kind: "topup", amountFen: 5000, seconds: 0, ref: order.orderId, createdAt: START }
    ]);
  });

  it("refuses forged, wrong-amount, unknown, cross-provider, oversized and crashing notifications", async () => {
    const { token, order } = await customerWithOrder([fakeProvider("wechat"), fakeProvider("alipay")]);
    const paid = { orderId: order.orderId, providerTxnId: "t1", amountFen: 5000 };
    const refusals = [
      await notify("wechat", paid, "forged"),
      await notify("wechat", { ...paid, amountFen: 1 }),
      await notify("wechat", { ...paid, orderId: "mc000000000000000000000000000000" }),
      await notify("alipay", paid),
      await notify("wechat", paid, "good", "x".repeat(70 * 1024)),
      await notify("wechat", paid, "boom"),
      await notify("wechat", null, "good", "{not json")
    ];
    for (const response of refusals) {
      expect(response.status).toBe(400);
      expect(response.text).toBe('{"code":"FAIL","message":"refused"}');
    }
    expect((await call("POST", "/cloud/pay/stripe/notify", { raw: "{}" })).status).toBe(404);
    expect((await call("GET", `/cloud/api/topups/${order.orderId}`, { token })).body).toEqual({ status: "pending" });
    expect(((await call("GET", "/cloud/api/me", { token })).body.balance as { fen: number }).fen).toBe(0);
  });

  it("closes an expired order when it is read", async () => {
    const wechat = fakeProvider("wechat");
    const { token, order } = await customerWithOrder([wechat]);
    clock += 15 * 60_000;
    expect((await call("GET", `/cloud/api/topups/${order.orderId}`, { token })).body).toEqual({ status: "closed" });
    expect(wechat.closed).toEqual([order.orderId]);
  });

  it("validates top-up requests and hides other customers' orders", async () => {
    const { order } = await customerWithOrder();
    const stranger = await signupCustomer();
    expect((await call("GET", `/cloud/api/topups/${order.orderId}`, { token: stranger.token })).status).toBe(404);
    expect((await call("GET", "/cloud/api/topups/mc..", { token: stranger.token })).status).toBe(404);
    const badPack = await call("POST", "/cloud/api/topups", {
      token: stranger.token,
      json: { pack: "cny1", provider: "wechat" }
    });
    expect(badPack.status).toBe(400);
    const badProvider = await call("POST", "/cloud/api/topups", {
      token: stranger.token,
      json: { pack: "cny50", provider: "alipay" }
    });
    expect(badProvider.status).toBe(400);
    delete process.env.CLOUD_PUBLIC_URL;
    const noUrl = await call("POST", "/cloud/api/topups", {
      token: stranger.token,
      json: { pack: "cny50", provider: "wechat" }
    });
    expect(noUrl.status).toBe(503);
    expect((await call("POST", "/cloud/api/topups", { json: { pack: "cny50", provider: "wechat" } })).status).toBe(401);
  });

  it("pays a test order from its page", async () => {
    setCloudPaymentProviders([fakeProvider("test").provider]);
    const { token } = await signupCustomer();
    const created = await call("POST", "/cloud/api/topups", { token, json: { pack: "cny200", provider: "test" } });
    expect(created.status).toBe(201);
    const orderId = created.body.orderId as string;

    const page = await call("GET", `/cloud/pay/test/${orderId}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.text).toContain("Mark as paid");
    expect(page.text).toContain("¥200.00");

    const viaForm = await call("POST", `/cloud/pay/test/${orderId}`, { headers: { Accept: "text/html" } });
    expect(viaForm.status).toBe(303);
    expect(viaForm.headers.get("location")).toBe(`/cloud/pay/test/${orderId}`);
    const again = await call("POST", `/cloud/pay/test/${orderId}`, { headers: { Accept: "application/json" } });
    expect(again.body).toEqual({ ok: true, status: "paid" });
    expect(((await call("GET", "/cloud/api/me", { token })).body.balance as { fen: number }).fen).toBe(20_000);
    expect((await call("GET", `/cloud/pay/test/${orderId}`)).text).not.toContain("Mark as paid");
    expect((await call("GET", "/cloud/pay/test/mc000000000000000000")).status).toBe(404);
  });

  it("refuses the test pages without the test provider, or for an expired or real order", async () => {
    const { token, order } = await customerWithOrder([fakeProvider("wechat"), fakeProvider("test")]);
    expect((await call("GET", `/cloud/pay/test/${order.orderId}`)).status).toBe(404);
    expect((await call("POST", `/cloud/pay/test/${order.orderId}`)).status).toBe(404);

    const testOrder = await call("POST", "/cloud/api/topups", { token, json: { pack: "cny50", provider: "test" } });
    const testId = testOrder.body.orderId as string;
    clock += 15 * 60_000;
    expect((await call("POST", `/cloud/pay/test/${testId}`)).status).toBe(409);

    setCloudPaymentProviders([fakeProvider("wechat").provider]);
    expect((await call("GET", `/cloud/pay/test/${testId}`)).status).toBe(404);
    expect(((await call("GET", "/cloud/api/me", { token })).body.balance as { fen: number }).fen).toBe(0);
  });

  it("answers unknown /cloud addresses with JSON 404s", async () => {
    const { token } = await signupCustomer();
    expect((await call("GET", "/cloud/api/nothing", { token })).status).toBe(404);
    const elsewhere = await call("GET", "/cloud/nothing");
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.body).toEqual({ ok: false, error: "Not found." });
    expect(elsewhere.headers.get("cache-control")).toBe("no-store");
  });
});
