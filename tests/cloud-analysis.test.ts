// Max Cloud: what each conversation of a project is analysed for when it ends.
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ANALYSIS, DEFAULT_STUDIO, parseStudio, studioAnalysisConfig } from "../shared/cloud-studio";
import { analyseProjectConversation, projectAnalysisModel } from "../server/cloud/analysis";
import { cloudConversationEnded, settleConversationAnalyses } from "../server/cloud/conversation-end";
import { setCloudClock } from "../server/cloud/context";
import { conversationRecorder, listConversations, readConversation } from "../server/cloud/conversations";
import { createProject, listProjects, patchProject, signup } from "../server/cloud/customers";
import { resetCloudDatabase } from "../server/cloud/store";

const START = Date.UTC(2026, 10, 23, 12, 0, 0);
const saved = { key: process.env.CLOUD_SECRET_KEY, signup: process.env.CLOUD_SIGNUP };
let clock = START;

beforeEach(() => {
  process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.CLOUD_SIGNUP = "open";
  resetCloudDatabase(":memory:");
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

const ANALYSIS = {
  enabled: true,
  summary: true,
  sentiment: true,
  successCriteria: "The visitor was given their order status.",
  fields: [
    { name: "order_number", type: "string", description: "The order number the visitor asked about." },
    { name: "topic", type: "enum", description: "What it was about.", options: ["orders", "returns", "other"] }
  ]
};

const RESULT = {
  summary: "The visitor asked where order A-1042 was and was told it ships tomorrow.",
  sentiment: "positive",
  success: true,
  successReason: "The status was given.",
  data: { order_number: "A-1042", topic: "orders" }
};

/** A chat model that answers with this, and remembers what it was asked. */
function model(answer: unknown = RESULT, status = 200) {
  const asked: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const request = vi.fn(async (url: unknown, init?: RequestInit) => {
    asked.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>
    });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: typeof answer === "string" ? answer : JSON.stringify(answer) } }]
      }),
      { status }
    );
  });
  return { asked, request: request as unknown as typeof fetch };
}

describe("a project's analysis settings", () => {
  it("are off until turned on, and keep what was written when turned off again", () => {
    expect(DEFAULT_STUDIO.analysis).toEqual(DEFAULT_ANALYSIS);
    expect(parseStudio({}, "openai").value!.analysis).toEqual({
      enabled: false,
      summary: true,
      sentiment: false,
      successCriteria: "",
      fields: []
    });
    expect(studioAnalysisConfig(parseStudio({}, "openai").value!)).toBeUndefined();
    const on = parseStudio({ analysis: ANALYSIS }, "openai").value!;
    expect(on.analysis).toEqual(ANALYSIS);
    expect(studioAnalysisConfig(on)).toEqual({
      summary: true,
      sentiment: true,
      successCriteria: "The visitor was given their order status.",
      fields: ANALYSIS.fields
    });
    const off = parseStudio({ analysis: { ...ANALYSIS, enabled: false } }, "openai").value!;
    expect(off.analysis.fields).toEqual(ANALYSIS.fields);
    expect(studioAnalysisConfig(off)).toBeUndefined();
    // No rule: no pass or fail is asked for.
    const plain = parseStudio({ analysis: { enabled: true, successCriteria: "  " } }, "openai").value!;
    expect(studioAnalysisConfig(plain)).toEqual({ summary: true, sentiment: false, fields: [] });
    // A stored project from before there was analysis.
    expect(studioAnalysisConfig({} as never)).toBeUndefined();
  });

  it("are refused with the reason when they cannot be used", () => {
    const refused = (analysis: unknown) => parseStudio({ analysis }, "openai").error;
    expect(refused("yes")).toBe("The analysis settings must be an object.");
    expect(refused({ enabled: true, summary: false })).toMatch(/^Analysis is on with nothing to look for/);
    expect(refused({ enabled: true, fields: [{ name: "1st", type: "string", description: "x" }] })).toMatch(
      /^Analysis: fields\[0\]\.name must be letters/
    );
    expect(refused({ fields: [{ name: "topic", type: "enum", description: "x", options: ["one"] }] })).toBe(
      "Analysis: field topic: enum needs 2 to 20 options."
    );
    expect(refused({ successCriteria: "x".repeat(1001) })).toMatch(/successCriteria is longer than 1000/);
    expect(
      refused({ fields: Array.from({ length: 25 }, (_, n) => ({ name: `f${n}`, type: "string", description: "x" })) })
    ).toMatch(/more than 24 entries/);
    // No key of an object: it would vanish from every result.
    expect(refused({ fields: [{ name: "__proto__", type: "string", description: "x" }] })).toMatch(
      /^Analysis: fields\[0\]\.name must be letters/
    );
    // Off with nothing chosen is nothing to refuse.
    expect(refused({ enabled: false, summary: false })).toBeUndefined();
  });

  it("are saved with the project, and stay when something else is saved without them", async () => {
    const owner = await customer();
    const created = project(owner);
    expect(created.studio.analysis.enabled).toBe(false);
    expect(patch(owner, created.id, { studio: { analysis: ANALYSIS } }).studio.analysis).toEqual(ANALYSIS);
    // An older console, or a script that sets one thing.
    expect(patch(owner, created.id, { studio: { knowledge: "Open 9 to 5." } }).studio.analysis).toEqual(ANALYSIS);
    const off = patch(owner, created.id, { studio: { analysis: { ...ANALYSIS, enabled: false } } });
    expect(off.studio.analysis.enabled).toBe(false);
    const refused = patchProject(owner, created.id, { studio: { analysis: { enabled: true, summary: false } } });
    expect(refused.ok).toBe(false);
    expect(project(owner, { name: "Second", studio: { analysis: ANALYSIS } }).studio.analysis).toEqual(ANALYSIS);
  });
});

describe("the model that analyses a project's conversations", () => {
  it("is the project's own vendor's, with the project's own key", () => {
    expect(projectAnalysisModel("openai", "sk-own", {})).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-own",
      model: "gpt-4o-mini"
    });
    expect(projectAnalysisModel("gemini", "g-own", {})).toMatchObject({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "g-own"
    });
    expect(projectAnalysisModel("grok", "x-own", {})).toMatchObject({
      baseUrl: "https://api.x.ai/v1",
      apiKey: "x-own"
    });
    // The operator can name another model of a vendor's.
    expect(projectAnalysisModel("gemini", "g-own", { CLOUD_ANALYSIS_MODEL_GEMINI: " gemini-next " }).model).toBe(
      "gemini-next"
    );
    expect(projectAnalysisModel("openai", "sk-own", { CLOUD_ANALYSIS_MODEL_GEMINI: "gemini-next" }).model).toBe(
      "gpt-4o-mini"
    );
  });

  it("is the operator's own when one is named, and never gets a customer's key", () => {
    const env = { CLOUD_ANALYSIS_LLM_BASE_URL: "http://127.0.0.1:11434/v1/", CLOUD_ANALYSIS_LLM_MODEL: "qwen3:8b" };
    expect(projectAnalysisModel("grok", "x-own", env)).toEqual({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "",
      model: "qwen3:8b"
    });
    expect(projectAnalysisModel("openai", "sk-own", { ...env, CLOUD_ANALYSIS_LLM_API_KEY: "op" }).apiKey).toBe("op");
  });
});

const TURNS = [
  { at: START, speaker: "user" as const, text: "Where is order A-1042?" },
  { at: START + 2000, speaker: "tool" as const, text: "check_order", ok: true, ms: 310 },
  { at: START + 3000, speaker: "agent" as const, text: "It ships tomorrow." }
];

describe("analysing a project's conversation", () => {
  it("asks the vendor's chat model and gives back the checked result", async () => {
    const { asked, request } = model();
    const analysis = await analyseProjectConversation(
      {
        projectId: "p1",
        backend: "openai",
        modelKey: "sk-own",
        config: studioAnalysisConfig({ analysis: ANALYSIS } as never)!,
        turns: TURNS,
        language: "es"
      },
      { request, clock: () => START + 9000, env: {} }
    );
    expect(analysis).toEqual({ at: START + 9000, result: RESULT });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(asked[0]!.headers.authorization).toBe("Bearer sk-own");
    expect(asked[0]!.body.model).toBe("gpt-4o-mini");
    const messages = asked[0]!.body.messages as Array<{ role: string; content: string }>;
    // The transcript is data in the user message; the settings are the instructions.
    expect(messages[0]!.content).toContain("order_number");
    expect(messages[1]!.content).toContain("Where is order A-1042?");
  });

  it("says why there is no result, in words that quote nothing of the vendor's", async () => {
    const config = studioAnalysisConfig({ analysis: ANALYSIS } as never)!;
    const refused = model("Your key sk-own is not valid", 401);
    expect(
      await analyseProjectConversation(
        { projectId: "p1", backend: "openai", modelKey: "sk-own", config, turns: TURNS },
        { request: refused.request, clock: () => START, env: {} }
      )
    ).toEqual({ at: START, error: "analysis model answered HTTP 401" });
    const nonsense = model("I think it went well!");
    const outcome = await analyseProjectConversation(
      { projectId: "p1", backend: "openai", modelKey: "sk-own", config, turns: TURNS },
      { request: nonsense.request, clock: () => START, env: {} }
    );
    expect(outcome).toEqual({ at: START, error: "analysis model did not return valid JSON" });
    expect(JSON.stringify(outcome)).not.toContain("sk-own");
  });

  it("does not let analyses pile up without end", async () => {
    const config = studioAnalysisConfig({ analysis: ANALYSIS } as never)!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(RESULT) } }] }));
    }) as unknown as typeof fetch;
    const of = (projectId: string) => ({
      projectId,
      backend: "openai" as const,
      modelKey: "sk-own",
      config,
      turns: TURNS
    });
    const start = (projectId: string) => analyseProjectConversation(of(projectId), { request: slow, env: {} });
    // One busy project takes four places, and no more: the others still have theirs.
    const busy = Array.from({ length: 4 }, () => start("busy"));
    expect(await analyseProjectConversation(of("busy"), { request: slow, clock: () => START, env: {} })).toEqual({
      at: START,
      error: "not analysed: too many of this project's analyses were under way"
    });
    const others = Array.from({ length: 20 }, (_, n) => start(`p${n}`));
    // Twenty-four in all.
    expect(await analyseProjectConversation(of("late"), { request: slow, clock: () => START, env: {} })).toEqual({
      at: START,
      error: "not analysed: too many analyses were under way"
    });
    release();
    expect((await Promise.all([...busy, ...others])).every((analysis) => analysis.result)).toBe(true);
    // And there is room again, for the busy one too.
    expect((await start("busy")).result).toBeDefined();
    expect((await start("late")).result).toBeDefined();
  });

  it("takes an answer with nothing that was asked for as no analysis", async () => {
    const config = studioAnalysisConfig({ analysis: ANALYSIS } as never)!;
    const empty = model({ verdict: "fine", sentiment: "ecstatic" });
    expect(
      await analyseProjectConversation(
        { projectId: "p1", backend: "openai", modelKey: "sk-own", config: { ...config, fields: [] }, turns: TURNS },
        { request: empty.request, clock: () => START, env: {} }
      )
    ).toEqual({ at: START, error: "the analysis model answered with nothing that was asked for" });
  });

  it("gives up at once when it is told to stop", async () => {
    const config = studioAnalysisConfig({ analysis: ANALYSIS } as never)!;
    const stop = new AbortController();
    const hangs = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    ) as unknown as typeof fetch;
    const waiting = analyseProjectConversation(
      { projectId: "p1", backend: "openai", modelKey: "sk-own", config, turns: TURNS },
      { request: hangs, clock: () => START, env: {}, signal: stop.signal }
    );
    stop.abort();
    expect(await waiting).toEqual({ at: START, error: "analysis was cancelled" });
  });
});

describe("a project's conversation, when it ends", () => {
  async function shop(studio: Record<string, unknown>) {
    const owner = await customer();
    const created = project(owner, { name: "Shop", studio });
    patch(owner, created.id, { modelKey: "sk-own" });
    return { owner, id: created.id };
  }

  function finish(
    owner: string,
    projectId: string,
    options: { keep: boolean; lines?: Array<[string, string]>; analysis?: unknown } = { keep: true }
  ) {
    const recorder = conversationRecorder(() => clock);
    const lines = options.lines ?? [
      ["rider", "Where is order A-1042?"],
      ["agent", "It ships tomorrow."]
    ];
    lines.forEach(([speaker, text], index) =>
      recorder.event({ type: "transcript", speaker, text, final: true, turnId: `t${index}` })
    );
    const sent: Array<Record<string, unknown>> = [];
    const asked: Array<Record<string, unknown>> = [];
    cloudConversationEnded(
      {
        customerId: owner,
        projectId,
        source: "embed",
        sessionId: "sess-1",
        seconds: 12,
        endedAt: clock + 12_000,
        keep: options.keep,
        recorder
      },
      { ended: (input: Record<string, unknown>) => void sent.push(input) } as never,
      (async (input: Record<string, unknown>, given?: { signal?: AbortSignal }) => {
        asked.push({ ...input, signal: given?.signal });
        if (options.analysis instanceof Error) throw options.analysis;
        return options.analysis ?? { at: clock + 15_000, result: RESULT };
      }) as never
    );
    return { sent, asked };
  }

  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const first = (owner: string, projectId: string) => {
    const listed = listConversations(owner, projectId);
    if (!listed.ok) throw new Error(listed.error);
    return listed.value.conversations[0];
  };

  it("is analysed with the project's settings and key, kept with the result, and sent once with it", async () => {
    const { owner, id } = await shop({
      language: "es",
      analysis: ANALYSIS,
      conversationWebhook: "https://shop.example.com/hook"
    });
    const { sent, asked } = finish(owner, id);
    // Kept at once; the mark and the delivery wait for the analysis.
    expect(first(owner, id)).toMatchObject({ preview: "Where is order A-1042?" });
    expect(first(owner, id)!.success).toBeUndefined();
    expect(sent).toEqual([]);
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      backend: "openai",
      modelKey: "sk-own",
      language: "es",
      config: { summary: true, sentiment: true, successCriteria: ANALYSIS.successCriteria },
      turns: [{ speaker: "user", text: "Where is order A-1042?" }, { speaker: "agent" }]
    });
    expect(first(owner, id)).toMatchObject({ sentiment: "positive", success: true });
    const read = readConversation(owner, first(owner, id)!.id);
    expect(read.ok && read.value.conversation.analysis).toEqual({ at: clock + 15_000, result: RESULT });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      projectId: id,
      analysis: RESULT,
      turns: [{ speaker: "user" }, { speaker: "agent" }]
    });
    expect(sent[0]).not.toHaveProperty("analysisError");
  });

  it("is sent with the reason when the analysis failed, and still kept", async () => {
    const { owner, id } = await shop({ analysis: ANALYSIS, conversationWebhook: "https://shop.example.com/hook" });
    const failed = finish(owner, id, {
      keep: true,
      analysis: { at: clock, error: "analysis model answered HTTP 401" }
    });
    await settle();
    expect(failed.sent[0]).toMatchObject({ analysisError: "analysis model answered HTTP 401" });
    expect(failed.sent[0]).not.toHaveProperty("analysis");
    const read = readConversation(owner, first(owner, id)!.id);
    expect(read.ok && read.value.conversation.analysis).toEqual({
      at: clock,
      error: "analysis model answered HTTP 401"
    });
    // An analysis that throws is a failed one, not a lost conversation.
    const thrown = finish(owner, id, { keep: true, analysis: new Error("boom") });
    await settle();
    expect(thrown.sent[0]).toMatchObject({ analysisError: "boom" });
  });

  it("is not analysed when analysis is off, nobody spoke, or the result has nowhere to go", async () => {
    const off = await shop({ conversationWebhook: "https://shop.example.com/hook" });
    const plain = finish(off.owner, off.id);
    // No analysis: sent at once, as it always was.
    expect(plain.sent).toHaveLength(1);
    expect(plain.sent[0]).not.toHaveProperty("analysis");
    expect(plain.asked).toEqual([]);

    const on = await shop({ analysis: ANALYSIS, conversationWebhook: "https://shop.example.com/hook" });
    const silent = finish(on.owner, on.id, { keep: true, lines: [["agent", "Hello! How can I help?"]] });
    expect(silent.asked).toEqual([]);
    expect(silent.sent).toHaveLength(1);

    const nowhere = await shop({ analysis: ANALYSIS });
    const unseen = finish(nowhere.owner, nowhere.id, { keep: false });
    await settle();
    expect(unseen.asked).toEqual([]);
    expect(unseen.sent).toEqual([]);
    // Kept, and no server to send to: analysed for the history alone.
    const kept = finish(nowhere.owner, nowhere.id, { keep: true });
    await settle();
    expect(kept.asked).toHaveLength(1);
    expect(kept.sent).toEqual([]);
    expect(first(nowhere.owner, nowhere.id)).toMatchObject({ success: true });
  });

  it("is sent without its analysis when the relay stops before the analysis is done", async () => {
    const { owner, id } = await shop({ analysis: ANALYSIS, conversationWebhook: "https://shop.example.com/hook" });
    let answer!: (analysis: unknown) => void;
    const slow = new Promise((resolve) => (answer = resolve));
    const { sent, asked } = finish(owner, id, { keep: true, analysis: slow });
    await settle();
    expect(sent).toEqual([]);
    // The analysis is told to stop along with the relay.
    const signal = (asked[0] as unknown as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(false);
    await settleConversationAnalyses(20);
    expect(signal.aborted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ analysisError: "not analysed: the relay was stopping" });
    const kept = readConversation(owner, first(owner, id)!.id);
    expect(kept.ok && kept.value.conversation.analysis).toMatchObject({
      error: "not analysed: the relay was stopping"
    });
    // An answer that comes after all changes nothing: sent once, and the reason stays.
    answer({ at: clock, result: RESULT });
    await settle();
    expect(sent).toHaveLength(1);
    expect(first(owner, id)!.success).toBeUndefined();
    // Nothing is left to wait for.
    await settleConversationAnalyses(20);
    expect(sent).toHaveLength(1);
  });

  it("is given the time a stopping relay has, and is sent with its analysis when that is enough", async () => {
    const { owner, id } = await shop({ analysis: ANALYSIS, conversationWebhook: "https://shop.example.com/hook" });
    let answer!: (analysis: unknown) => void;
    const { sent } = finish(owner, id, { keep: true, analysis: new Promise((resolve) => (answer = resolve)) });
    const stopping = settleConversationAnalyses(5_000);
    answer({ at: clock, result: RESULT });
    await stopping;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ analysis: RESULT });
    expect(sent[0]).not.toHaveProperty("analysisError");
  });

  it("does not read the project's key for a model the operator named", async () => {
    const { owner, id } = await shop({ analysis: ANALYSIS, conversationWebhook: "https://shop.example.com/hook" });
    process.env.CLOUD_ANALYSIS_LLM_BASE_URL = "http://127.0.0.1:11434/v1";
    try {
      // The project says whose model it is, for the console to say so.
      const listed = listProjects(owner);
      expect(listed.find((item) => item.id === id)!.analysisOnOwnKey).toBe(false);
      // A key that cannot be read stands in nobody's way: it was never going to be used.
      process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("base64");
      const { asked } = finish(owner, id);
      await settle();
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({ projectId: id, modelKey: "" });
    } finally {
      delete process.env.CLOUD_ANALYSIS_LLM_BASE_URL;
    }
    expect(listProjects(owner).find((item) => item.id === id)!.analysisOnOwnKey).toBe(true);
  });

  it("says so when the project's model key cannot be read", async () => {
    const { owner, id } = await shop({ analysis: ANALYSIS, conversationWebhook: "https://shop.example.com/hook" });
    // The operator changed CLOUD_SECRET_KEY without keeping the old one.
    process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("base64");
    const { sent, asked } = finish(owner, id);
    await settle();
    expect(asked).toEqual([]);
    expect(read(owner, id)).toMatchObject({ error: "not analysed: the project's model key could not be read" });
    // The signing secret is as unreadable as the model key, which is the webhook's own matter.
    expect(sent.length).toBeLessThanOrEqual(1);

    function read(customerId: string, projectId: string) {
      const conversation = readConversation(customerId, first(customerId, projectId)!.id);
      return conversation.ok ? conversation.value.conversation.analysis : undefined;
    }
  });
});

describe("a database from before there was analysis", () => {
  it("gains the place for it, and its conversations read as not analysed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "max-cloud-analysis-"));
    const file = path.join(dir, "cloud.db");
    try {
      resetCloudDatabase(file);
      const owner = await customer();
      const created = project(owner);
      const recorder = conversationRecorder(() => clock);
      recorder.event({ type: "transcript", speaker: "rider", text: "Hello", final: true, turnId: "t1" });
      cloudConversationEnded(
        {
          customerId: owner,
          projectId: created.id,
          source: "test",
          sessionId: "s",
          seconds: 3,
          endedAt: clock,
          keep: true,
          recorder
        },
        { ended: () => undefined } as never
      );
      resetCloudDatabase();
      // As an older relay left it: no such column.
      const old = new DatabaseSync(file);
      old.exec("ALTER TABLE conversations DROP COLUMN analysis");
      old.exec("ALTER TABLE conversations DROP COLUMN answer_ms");
      old.close();
      resetCloudDatabase(file);
      const listed = listConversations(owner, created.id);
      expect(listed.ok && listed.value.conversations).toMatchObject([{ preview: "Hello" }]);
      const one = readConversation(owner, (listed.ok ? listed.value.conversations[0] : undefined)!.id);
      expect(one.ok && one.value.conversation.analysis).toBeUndefined();
      expect(one.ok && one.value.conversation).not.toHaveProperty("answerMs");
      // And a new conversation is kept with both.
      const next = conversationRecorder(() => clock);
      next.event({ type: "transcript", speaker: "rider", text: "Hi", final: true, turnId: "t1" });
      next.event({ type: "metric", latencyMs: 640 });
      next.event({ type: "transcript", speaker: "agent", text: "Hello!", final: true, turnId: "t2" });
      cloudConversationEnded(
        {
          customerId: owner,
          projectId: created.id,
          source: "test",
          sessionId: "s2",
          seconds: 3,
          endedAt: clock,
          keep: true,
          recorder: next
        },
        { ended: () => undefined } as never
      );
      const both = listConversations(owner, created.id);
      expect(both.ok && both.value.conversations.some((item) => item.answerMs === 640)).toBe(true);
    } finally {
      resetCloudDatabase();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
