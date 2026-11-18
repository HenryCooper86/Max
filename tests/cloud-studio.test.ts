// Max Cloud Studio: what a project can be set up with, and how the relay runs it.
import dns from "node:dns";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STUDIO,
  normalizeOrigin,
  parseStudio,
  privateAddress,
  studioToolParameters,
  toolUrlProblem
} from "../shared/cloud-studio";
import { authorizeUpgrade, resetAuthRateLimit } from "../server/auth";
import { projectAssistantProfile } from "../server/assistant";
import { projectRuntime, registerEmbedRoutes } from "../server/cloud";
import { setCloudClock } from "../server/cloud/context";
import {
  conversationRecorder,
  listConversations,
  readConversation,
  saveConversation
} from "../server/cloud/conversations";
import {
  createProject,
  deleteProject,
  patchProject,
  revealWebhookSecret,
  rotateWebhookSecret,
  signup
} from "../server/cloud/customers";
import { mintEmbedSession, mintTestSession, resetCloudSessionLimits } from "../server/cloud/sessions";
import { resetCloudDatabase } from "../server/cloud/store";
import { guardedFetch, projectServerTools, testProjectTool } from "../server/cloud/tools";
import { grokDialect, openAiDialect } from "../server/providers/live/openai-realtime";
import { cloudSessionTokens } from "../server/session-tokens";

const START = Date.UTC(2026, 10, 18, 12, 0, 0);
const SITE = "https://shop.example.com";
const saved = { key: process.env.CLOUD_SECRET_KEY, signup: process.env.CLOUD_SIGNUP };
let clock = START;

beforeEach(() => {
  process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.CLOUD_SIGNUP = "open";
  resetCloudDatabase(":memory:");
  resetCloudSessionLimits();
  resetAuthRateLimit();
  clock = START;
  setCloudClock(() => clock);
});

afterEach(() => {
  resetCloudDatabase();
  setCloudClock();
  vi.restoreAllMocks();
  for (const [name, value] of [
    ["CLOUD_SECRET_KEY", saved.key],
    ["CLOUD_SIGNUP", saved.signup]
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function customer() {
  const result = await signup(`c${randomBytes(4).toString("hex")}@example.com`, "correct horse battery");
  if (!result.ok) throw new Error(result.error);
  return result.value.customer.id;
}

function project(customerId: string, body: Record<string, unknown> = { name: "Shop" }) {
  const result = createProject(customerId, body);
  if (!result.ok) throw new Error(result.error);
  return result.value.project;
}

function patch(customerId: string, projectId: string, body: Record<string, unknown>) {
  const result = patchProject(customerId, projectId, body);
  if (!result.ok) throw new Error(result.error);
  return result.value.project;
}

const ORDER_TOOL = {
  name: "check_order",
  description: "Look up an order's status by its number.",
  url: "https://api.example.com/tools/order",
  parameters: [{ name: "orderId", type: "string", description: "Like A-1042", required: true }]
};

describe("Studio settings", () => {
  it("fills in defaults and keeps only valid settings", () => {
    expect(parseStudio(undefined, "openai").value).toEqual(DEFAULT_STUDIO);
    const parsed = parseStudio(
      {
        voice: "cedar",
        language: "es",
        knowledge: "  Open 9-5.  ",
        tools: [ORDER_TOOL],
        publicEmbed: { enabled: true, origins: ["shop.example.com/", " ", "https://shop.example.com"] },
        widget: { label: "Ask us", accent: "#2FD08A", position: "bottom-left" },
        keepConversations: false
      },
      "openai"
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.value).toMatchObject({
      voice: "cedar",
      language: "es",
      knowledge: "Open 9-5.",
      publicEmbed: { enabled: true, origins: [SITE] },
      widget: { label: "Ask us", accent: "#2fd08a", position: "bottom-left" },
      keepConversations: false
    });
    expect(parsed.value?.tools[0]?.parameters[0]).toEqual({
      name: "orderId",
      type: "string",
      description: "Like A-1042",
      required: true,
      options: []
    });
  });

  it.each([
    [{ voice: "eve" }, "not one of this backend's voices"],
    [{ language: "xx" }, "language"],
    [{ knowledge: "x".repeat(20_001) }, "at most 20,000"],
    [{ tools: [{ ...ORDER_TOOL, name: "Check Order" }] }, "must start with a letter"],
    [{ tools: [{ ...ORDER_TOOL, description: "" }] }, "needs a description"],
    [{ tools: [ORDER_TOOL, ORDER_TOOL] }, "Two tools are named check_order"],
    [{ tools: [{ ...ORDER_TOOL, url: "http://api.example.com/x" }] }, "https://"],
    [{ tools: [{ ...ORDER_TOOL, url: "https://127.0.0.1/x" }] }, "public address"],
    [{ tools: [{ ...ORDER_TOOL, url: "https://${CLOUD_SECRET_KEY}.example.com" }] }, "variables"],
    [{ tools: [{ ...ORDER_TOOL, parameters: [{ name: "a b" }] }] }, "letters, digits"],
    [{ publicEmbed: { enabled: true, origins: [] } }, "Add the website"],
    [{ publicEmbed: { enabled: false, origins: ["http://shop.example.com"] } }, "not a website address"],
    [{ widget: { accent: "green" } }, "#2fd08a"]
  ])("refuses %j", (input, message) => {
    expect(parseStudio(input, "openai").error).toContain(message);
  });

  it("turns tool parameters into the JSON Schema the model reads", () => {
    const tool = parseStudio(
      {
        tools: [
          {
            ...ORDER_TOOL,
            parameters: [
              { name: "orderId", type: "string", required: true },
              { name: "size", type: "string", options: ["S", "M", "S", ""] },
              { name: "gift", type: "boolean", options: ["ignored"] }
            ]
          }
        ]
      },
      "openai"
    ).value!.tools[0]!;
    expect(studioToolParameters(tool)).toEqual({
      type: "object",
      properties: {
        orderId: { type: "string" },
        size: { type: "string", enum: ["S", "M"] },
        gift: { type: "boolean" }
      },
      required: ["orderId"]
    });
  });

  it("knows private addresses and website origins", () => {
    for (const host of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "172.20.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "::1",
      "[fd00::1]",
      "::ffff:127.0.0.1",
      "fe80::1"
    ]) {
      expect(privateAddress(host)).toBe(true);
    }
    for (const host of ["::7f00:1", "::127.0.0.1", "2002:7f00:1::", "2001:0:4136::1", "2001::1", "fec0::1"]) {
      expect(privateAddress(host)).toBe(true);
    }
    for (const host of ["8.8.8.8", "172.32.0.1", "2606:4700::1111", "example.com"])
      expect(privateAddress(host)).toBe(false);
    expect(toolUrlProblem("https://metadata.google.internal/x")).toContain("public");
    expect(toolUrlProblem("https://user:pw@api.example.com")).toContain("user name");
    expect(toolUrlProblem("https://api.example.com:8443/x")).toContain("port");
    expect(toolUrlProblem("https://api.example.com/x")).toBeUndefined();
    expect(normalizeOrigin("Shop.Example.com/path?q=1")).toBe(SITE);
    expect(normalizeOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeOrigin("http://shop.example.com")).toBeUndefined();
    expect(normalizeOrigin("intranet")).toBeUndefined();
  });
});

describe("projects with Studio settings", () => {
  it("records conversations only when the customer chose to", async () => {
    // Projects from before the Studio have no settings: nothing is recorded for them.
    expect(parseStudio({}, "openai").value?.keepConversations).toBe(false);
    expect(DEFAULT_STUDIO.keepConversations).toBe(false);
    const owner = await customer();
    expect(project(owner).studio.keepConversations).toBe(true);
    expect(project(owner, { name: "Quiet", studio: { keepConversations: false } }).studio.keepConversations).toBe(
      false
    );
  });

  it("starts from a template and saves Studio changes", async () => {
    const owner = await customer();
    const created = project(owner, {
      name: "Bakery",
      assistantName: "Ava",
      instructions: "Help customers order cakes.",
      greeting: "Hi, I'm Ava!",
      studio: { template: "orders", knowledge: "Open 8-6." }
    });
    expect(created).toMatchObject({
      assistantName: "Ava",
      greeting: "Hi, I'm Ava!",
      studio: { template: "orders", knowledge: "Open 8-6." },
      hasWebhookSecret: false
    });
    expect(created.publicId).toMatch(/^pub_[0-9a-f]{24}$/);

    const updated = patch(owner, created.id, { studio: { ...created.studio, voice: "cedar", tools: [ORDER_TOOL] } });
    expect(updated.studio.voice).toBe("cedar");
    expect(updated.hasWebhookSecret).toBe(true);
    const secret = revealWebhookSecret(owner, created.id);
    expect(secret.ok && secret.value.secret).toMatch(/^whsec_/);
    const rotated = rotateWebhookSecret(owner, created.id);
    expect(rotated.ok && rotated.value.secret).not.toBe(secret.ok && secret.value.secret);

    expect(patchProject(owner, created.id, { studio: { tools: "nope" } })).toMatchObject({ ok: false, status: 400 });
  });

  it("falls back to the new backend's default voice when the backend changes", async () => {
    const owner = await customer();
    const created = project(owner);
    patch(owner, created.id, { studio: { voice: "cedar" } });
    expect(patch(owner, created.id, { backend: "grok" }).studio.voice).toBe("");
    expect(patch(owner, created.id, { backend: "gemini", studio: { voice: "cedar" } }).studio.voice).toBe("");
    expect(patch(owner, created.id, { studio: { voice: "Puck" } }).studio.voice).toBe("Puck");
  });

  it("gives a session the voice, language, knowledge and tools", async () => {
    const owner = await customer();
    const created = project(owner);
    patch(owner, created.id, {
      modelKey: "sk-test",
      studio: { voice: "cedar", language: "es", knowledge: "We open at 9.", tools: [ORDER_TOOL] }
    });
    const runtime = projectRuntime(created.id)!;
    expect(runtime.studio).toMatchObject({ voice: "cedar", language: "es", knowledge: "We open at 9." });
    expect(runtime.webhookSecret).toMatch(/^whsec_/);

    const profile = projectAssistantProfile({
      name: "Ava",
      instructions: "Be brief.",
      language: runtime.studio.language,
      knowledge: runtime.studio.knowledge
    });
    expect(profile.languages).toEqual(["es"]);
    expect(profile.instructions).toContain("Be brief.");
    expect(profile.instructions).toContain("<reference>\nWe open at 9.\n</reference>");

    const tools = projectServerTools(runtime.studio, runtime.webhookSecret);
    expect(tools.map((tool) => tool.name)).toEqual(["check_order"]);
    expect(tools[0]?.parameters).toMatchObject({ required: ["orderId"] });

    expect(openAiDialect("k", "cedar").voice("female")).toBe("cedar");
    expect(openAiDialect("k").voice("female")).toBe("marin");
    expect(grokDialect("k", "leo").voice("male")).toBe("leo");
  });

  it("keeps conversations, newest first, and deletes them with the project", async () => {
    const owner = await customer();
    const created = project(owner);
    const recorder = conversationRecorder(() => clock);
    recorder.event({ type: "transcript", turnId: "t1", speaker: "rider", text: "Where is my", final: false });
    recorder.event({ type: "transcript", turnId: "t1", speaker: "rider", text: "Where is my order?", final: true });
    recorder.event({ type: "tool.activity", callId: "c", name: "check_order", where: "server", state: "started" });
    recorder.event({ type: "tool.activity", callId: "c", name: "check_order", state: "succeeded", durationMs: 412.4 });
    recorder.event({ type: "transcript", turnId: "t2", speaker: "agent", text: "It ships today.", final: true });
    recorder.event({
      type: "transcript",
      turnId: "t2",
      speaker: "agent",
      text: "It ships today, by 5 pm.",
      final: true
    });
    const id = saveConversation({ customerId: owner, projectId: created.id, source: "embed", seconds: 42.4, recorder });
    expect(id).toMatch(/^conv_/);
    expect(
      saveConversation({
        customerId: owner,
        projectId: created.id,
        source: "api",
        seconds: 3,
        recorder: conversationRecorder()
      })
    ).toBeUndefined();

    const list = listConversations(owner, created.id);
    expect(list.ok && list.value.conversations).toEqual([
      expect.objectContaining({ id, seconds: 42, source: "embed", preview: "Where is my order?" })
    ]);
    const read = readConversation(owner, id!);
    expect(read.ok && read.value.conversation.turns.map((turn) => [turn.speaker, turn.text, turn.ok])).toEqual([
      ["user", "Where is my order?", undefined],
      ["tool", "check_order", true],
      ["agent", "It ships today, by 5 pm.", undefined]
    ]);
    expect(readConversation(await customer(), id!)).toMatchObject({ ok: false, status: 404 });

    // Thirty days later, saving another prunes it.
    clock += 31 * 86_400_000;
    const later = conversationRecorder(() => clock);
    later.event({ type: "transcript", turnId: "x", speaker: "rider", text: "Hello", final: true });
    saveConversation({ customerId: owner, projectId: created.id, source: "test", seconds: 1, recorder: later });
    expect(readConversation(owner, id!)).toMatchObject({ ok: false });

    deleteProject(owner, created.id);
    expect(listConversations(owner, created.id)).toMatchObject({ ok: false, status: 404 });
    // A session that ends after its project was deleted leaves nothing behind.
    const orphan = conversationRecorder(() => clock);
    orphan.event({ type: "transcript", turnId: "o", speaker: "rider", text: "Still there?", final: true });
    expect(
      saveConversation({ customerId: owner, projectId: created.id, source: "api", seconds: 2, recorder: orphan })
    ).toBeUndefined();
  });
});

describe("session tokens without the project key", () => {
  it("mints test sessions for the owner only, once a model key is saved", async () => {
    const owner = await customer();
    const created = project(owner);
    expect(mintTestSession(owner, created.id)).toMatchObject({ ok: false, status: 409 });
    patch(owner, created.id, { modelKey: "sk-test" });
    expect(mintTestSession(await customer(), created.id)).toMatchObject({ ok: false, status: 404 });
    const minted = mintTestSession(owner, created.id);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(cloudSessionTokens.grant(minted.value.token)?.project).toMatchObject({
      projectId: created.id,
      customerId: owner,
      source: "test"
    });
  });

  it("mints embed sessions only for listed websites, pinned to that website", async () => {
    const owner = await customer();
    const created = project(owner);
    patch(owner, created.id, { modelKey: "sk-test" });
    const mint = (origin: string | undefined, address = "203.0.113.5") =>
      mintEmbedSession({ publicId: created.publicId, origin, address });
    expect(mint(SITE)).toMatchObject({ ok: false, status: 403 });
    patch(owner, created.id, { studio: { publicEmbed: { enabled: true, origins: [SITE] } } });
    expect(mint("https://evil.example.com")).toMatchObject({ ok: false, status: 403 });
    expect(mint(undefined)).toMatchObject({ ok: false, status: 403 });
    expect(mintEmbedSession({ publicId: "pub_nope", origin: SITE, address: "x" })).toMatchObject({ status: 404 });

    const minted = mint(SITE);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(cloudSessionTokens.grant(minted.value.token)?.project).toMatchObject({ source: "embed", origin: SITE });

    const upgrade = (origin: string) =>
      authorizeUpgrade({
        headers: { origin },
        url: `/agent?token=${minted.value.token}`,
        socket: { remoteAddress: "203.0.113.9" }
      } as unknown as IncomingMessage);
    expect(upgrade(SITE)).toEqual({ ok: true });
    expect(upgrade("https://evil.example.com")).toMatchObject({ ok: false, code: 403 });

    // Ten a minute from one visitor.
    for (let index = 0; index < 9; index += 1) mint(SITE);
    expect(mint(SITE)).toMatchObject({ ok: false, status: 429 });
    expect(mint(SITE, "198.51.100.7").ok).toBe(true);
  });

  it("lets public-embed tokens push out only other embed tokens", async () => {
    const owner = await customer();
    const created = project(owner);
    patch(owner, created.id, { modelKey: "sk-test", studio: { publicEmbed: { enabled: true, origins: [SITE] } } });
    const test = mintTestSession(owner, created.id);
    if (!test.ok) throw new Error(test.error);
    for (let index = 0; index < 220; index += 1) {
      mintEmbedSession({ publicId: created.publicId, origin: SITE, address: `198.51.100.${index % 200}` });
      if (index % 100 === 99) resetCloudSessionLimits();
    }
    expect(cloudSessionTokens.grant(test.value.token)).toBeDefined();
  });

  it("answers the browser's CORS preflight and the token request", async () => {
    const owner = await customer();
    const created = project(owner);
    patch(owner, created.id, { modelKey: "sk-test", studio: { publicEmbed: { enabled: true, origins: [SITE] } } });
    const app = express();
    app.use(express.json());
    registerEmbedRoutes(app);
    const server: Server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/public-session-tokens`;
    try {
      const preflight = await fetch(base, { method: "OPTIONS", headers: { Origin: SITE } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(SITE);
      const ok = await fetch(base, {
        method: "POST",
        headers: { Origin: SITE, "content-type": "application/json" },
        body: JSON.stringify({ project: created.publicId })
      });
      expect(ok.status).toBe(201);
      expect(((await ok.json()) as { token: string }).token).toMatch(/^vst_/);
      const refused = await fetch(base, {
        method: "POST",
        headers: { Origin: "https://other.example.com", "content-type": "application/json" },
        body: JSON.stringify({ project: created.publicId })
      });
      expect(refused.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe("calling customers' tools", () => {
  it("refuses names that resolve to private addresses", async () => {
    vi.spyOn(dns, "lookup").mockImplementation(((
      _host: string,
      _options: unknown,
      callback: (error: null, addresses: dns.LookupAddress[]) => void
    ) => callback(null, [{ address: "169.254.169.254", family: 4 }])) as unknown as typeof dns.lookup);
    await expect(guardedFetch("https://rebind.example.com/x", { method: "POST", body: "{}" })).rejects.toThrow(
      /private/
    );
    await expect(guardedFetch("https://10.0.0.1/x", { method: "POST", body: "{}" })).rejects.toThrow(/public/);
  });

  it("reports a test call's failure in words", async () => {
    const studio = parseStudio({ tools: [ORDER_TOOL] }, "openai").value!;
    expect(await testProjectTool(studio, undefined, "missing", {})).toMatchObject({
      ok: false,
      error: expect.stringContaining("No tool")
    });
    vi.spyOn(dns, "lookup").mockImplementation(((
      _host: string,
      _options: unknown,
      callback: (error: null, addresses: dns.LookupAddress[]) => void
    ) => callback(null, [{ address: "127.0.0.1", family: 4 }])) as unknown as typeof dns.lookup);
    const result = await testProjectTool(studio, "whsec_x", "check_order", { orderId: "A-1" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("public") });
  });
});
