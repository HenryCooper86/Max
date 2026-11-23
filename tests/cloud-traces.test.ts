// Max Cloud: a project's conversations traced to its own collector.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STUDIO, DEFAULT_TRACES, STUDIO_LIMITS, parseStudio } from "../shared/cloud-studio";
import { projectRuntime } from "../server/cloud";
import { setCloudClock } from "../server/cloud/context";
import { createProject, listProjects, patchProject, signup, tracesHeadersScope } from "../server/cloud/customers";
import { checkStoredSecrets, reencryptStoredSecrets, resetCloudKeyCheck } from "../server/cloud/keyring";
import { decryptModelKey, encryptModelKey } from "../server/cloud/secrets";
import { liveProject, projectSecrets, resetCloudDatabase, updateProject } from "../server/cloud/store";
import { createProjectTraces, TRACES_HEADERS_MAX, tracesHeadersProblem } from "../server/cloud/traces";
import { parseHeaders } from "../server/tracing";

const START = Date.UTC(2026, 10, 23, 12, 0, 0);
const COLLECTOR = "https://cloud.langfuse.com/api/public/otel/v1/traces";
const KEY = "Authorization=Basic%20c2VjcmV0LWtleS1wYWlyOg%3D%3D,x-team=prod";
const saved = { key: process.env.CLOUD_SECRET_KEY, signup: process.env.CLOUD_SIGNUP };

beforeEach(() => {
  process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.CLOUD_SIGNUP = "open";
  resetCloudDatabase(":memory:");
  resetCloudKeyCheck();
  setCloudClock(() => START);
});

afterEach(() => {
  vi.useRealTimers();
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

describe("a project's traces settings", () => {
  it("are off, and without words, until set", () => {
    expect(DEFAULT_STUDIO.traces).toEqual({ endpoint: "", content: false });
    expect(parseStudio({}, "openai").value!.traces).toEqual(DEFAULT_TRACES);
    expect(parseStudio({ traces: { endpoint: ` ${COLLECTOR} `, content: true } }, "openai").value!.traces).toEqual({
      endpoint: COLLECTOR,
      content: true
    });
    // Only an explicit yes puts words on spans.
    expect(parseStudio({ traces: { endpoint: COLLECTOR, content: "yes" } }, "openai").value!.traces.content).toBe(
      false
    );
    // A stored studio from before there were traces reads as the default.
    const old = { ...structuredClone(DEFAULT_STUDIO) } as Record<string, unknown>;
    delete old.traces;
    expect(parseStudio(old, "openai").value!.traces).toEqual(DEFAULT_TRACES);
  });

  it("are refused with the reason when the address cannot be used", () => {
    const refused = (endpoint: unknown) => parseStudio({ traces: { endpoint } }, "openai").error;
    expect(refused("http://collector.example.com/v1/traces")).toBe(
      "The traces endpoint's address must start with https://."
    );
    expect(refused("https://127.0.0.1/v1/traces")).toBe(
      "The traces endpoint's address must be a public address, not a private one."
    );
    expect(refused("https://10.1.2.3/v1/traces")).toMatch(/^The traces endpoint's address must be a public/);
    expect(refused("https://collector.internal/v1/traces")).toMatch(/^The traces endpoint's address must be a public/);
    expect(refused("https://user:pass@collector.example.com/v1/traces")).toBe(
      "The traces endpoint's address cannot contain a user name or password."
    );
    expect(refused("collector")).toMatch(/^The traces endpoint's address must be a full https/);
    expect(refused(`https://collector.example.com/${"a".repeat(STUDIO_LIMITS.url)}`)).toMatch(/at most 500 characters/);
    expect(refused(7)).toMatch(/must be text/);
    expect(parseStudio({ traces: "on" }, "openai").error).toBe("The traces settings must be an object.");
  });

  it("are kept when a save says nothing of them, and replaced when it does", async () => {
    const owner = await customer();
    const created = project(owner);
    patch(owner, created.id, { studio: { traces: { endpoint: COLLECTOR, content: true } } });
    // A client that does not know of traces (an older console) saves something else.
    const other = patch(owner, created.id, { studio: { knowledge: "Open 9 to 5." } });
    expect(other.studio.traces).toEqual({ endpoint: COLLECTOR, content: true });
    expect(other.studio.knowledge).toBe("Open 9 to 5.");
    // So does a save that sets only the name, or the backend.
    expect(patch(owner, created.id, { name: "Shop 2" }).studio.traces.endpoint).toBe(COLLECTOR);
    expect(patch(owner, created.id, { backend: "gemini" }).studio.traces.endpoint).toBe(COLLECTOR);
    // Saying it turns it off.
    const off = patch(owner, created.id, { studio: { traces: { endpoint: "", content: false } } });
    expect(off.studio.traces).toEqual(DEFAULT_TRACES);
    const refused = patchProject(owner, created.id, { studio: { traces: { endpoint: "http://x.example.com/" } } });
    expect(refused).toMatchObject({ ok: false, status: 400 });
  });
});

describe("a project's traces headers", () => {
  it("are stored encrypted, never returned, and removed by an empty value", async () => {
    const owner = await customer();
    const created = project(owner);
    expect(created.hasTracesHeaders).toBe(false);
    const after = patch(owner, created.id, { tracesHeaders: ` ${KEY} ` });
    expect(after.hasTracesHeaders).toBe(true);
    // Nowhere in what the API returns...
    expect(JSON.stringify(after)).not.toContain("c2VjcmV0");
    expect(JSON.stringify(listProjects(owner))).not.toContain("c2VjcmV0");
    expect(JSON.stringify(listProjects(owner))).not.toContain("x-team");
    // ...nor in the row: only a ciphertext, bound to the project and to its own scope.
    const row = liveProject(created.id)!;
    expect(JSON.stringify(row)).not.toContain("c2VjcmV0");
    expect(JSON.stringify(row)).not.toContain("x-team");
    expect(row.traces_headers_enc).toMatch(/^v2:/);
    const keys = [Buffer.from(process.env.CLOUD_SECRET_KEY!, "base64")];
    expect(decryptModelKey(row.traces_headers_enc!, keys, tracesHeadersScope(created.id))).toBe(KEY);
    expect(decryptModelKey(row.traces_headers_enc!, keys, created.id)).toBeUndefined();
    expect(decryptModelKey(row.traces_headers_enc!, keys, `${created.id}#webhook-secret`)).toBeUndefined();
    // A save of something else leaves them.
    expect(patch(owner, created.id, { name: "Shop 2" }).hasTracesHeaders).toBe(true);
    expect(liveProject(created.id)!.traces_headers_enc).toBe(row.traces_headers_enc);
    // Replaced.
    patch(owner, created.id, { tracesHeaders: "x-api-key=other" });
    expect(liveProject(created.id)!.traces_headers_enc).not.toBe(row.traces_headers_enc);
    // Removed.
    const removed = patch(owner, created.id, { tracesHeaders: "" });
    expect(removed.hasTracesHeaders).toBe(false);
    expect(liveProject(created.id)!.traces_headers_enc).toBeNull();
  });

  it("do not follow the traces to another host", async () => {
    const owner = await customer();
    const created = project(owner);
    const traces = (endpoint: string) => ({ studio: { traces: { endpoint, content: false } } });
    patch(owner, created.id, { ...traces("https://otel.example.com/v1/traces"), tracesHeaders: KEY });
    const saved = liveProject(created.id)!.traces_headers_enc;
    expect(saved).toMatch(/^v2:/);
    // Another path on the same host, or a save of something else in the Studio: they stay.
    patch(owner, created.id, traces("https://otel.example.com/api/v1/traces"));
    patch(owner, created.id, { studio: { keepConversations: true } });
    expect(liveProject(created.id)!.traces_headers_enc).toBe(saved);
    // Another host: one collector's key is not sent to the next.
    expect(patch(owner, created.id, traces("https://otel.example.org/v1/traces")).hasTracesHeaders).toBe(false);
    expect(liveProject(created.id)!.traces_headers_enc).toBeNull();
    // Given with the new address in the same save, they are the new collector's and are kept.
    patch(owner, created.id, { ...traces("https://collector.example.net/v1/traces"), tracesHeaders: "x-api-key=new" });
    expect(liveProject(created.id)!.traces_headers_enc).toMatch(/^v2:/);
    // Switched off, they go too: a later address would otherwise be sent them.
    expect(patch(owner, created.id, traces("")).hasTracesHeaders).toBe(false);
  });

  it("are refused, with the reason, when they cannot be sent", async () => {
    const owner = await customer();
    const created = project(owner);
    const refused = (value: unknown) => {
      const result = patchProject(owner, created.id, { tracesHeaders: value });
      return result.ok ? undefined : result.error;
    };
    expect(refused(5)).toBe("Traces headers must be text.");
    expect(refused(`a=${"b".repeat(TRACES_HEADERS_MAX)}`)).toMatch(/at most 2000 characters/);
    expect(refused("a=b\nc=d")).toMatch(/characters they cannot have/);
    expect(refused("a=b\r\n")).toMatch(/characters they cannot have/);
    expect(refused("a=b\u0000")).toMatch(/characters they cannot have/);
    expect(refused("a=%0D%0Ax-injected: 1")).toMatch(/plain printable characters/);
    expect(refused("a=caf%C3%A9")).toMatch(/plain printable characters/);
    expect(refused(Array.from({ length: 11 }, (_, index) => `h${index}=v`).join(","))).toMatch(/at most 10 headers/);
    expect(refused("bad name=v")).toBe("bad name is not a valid header name.");
    expect(refused("no-equals-sign")).toMatch(/must look like name=value/);
    expect(refused("=value")).toMatch(/must look like name=value/);
    for (const name of ["host", "Content-Length", "CONTENT-TYPE", "transfer-encoding", "Connection"]) {
      expect(refused(`${name}=x`)).toBe(`The ${name.toLowerCase()} header cannot be set here.`);
    }
    // Nor one that changes how the request is made, or has the relay speak for somebody it is not.
    for (const name of ["Upgrade", "expect", "te", "trailer", "keep-alive", "Cookie", "Forwarded"]) {
      expect(refused(`${name}=x`)).toBe(`The ${name.toLowerCase()} header cannot be set here.`);
    }
    for (const name of ["Proxy-Authorization", "proxy-connection", "X-Forwarded-For", "x-forwarded-host"]) {
      expect(refused(`${name}=x`)).toBe(`The ${name.toLowerCase()} header cannot be set here.`);
    }
    // None of those was saved; ten is allowed, as are an empty value, empty parts and encoded characters.
    expect(liveProject(created.id)!.traces_headers_enc).toBeNull();
    expect(refused(Array.from({ length: 10 }, (_, index) => `h${index}=v`).join(","))).toBeUndefined();
    expect(tracesHeadersProblem("authorization=Bearer%20abc,x-empty=,")).toBeUndefined();
    expect(tracesHeadersProblem("")).toBeUndefined();
    expect(parseHeaders("authorization=Bearer%20abc")).toEqual({ authorization: "Bearer abc" });
  });

  it("fail without CLOUD_SECRET_KEY as a model key does", async () => {
    const owner = await customer();
    const created = project(owner);
    delete process.env.CLOUD_SECRET_KEY;
    expect(patchProject(owner, created.id, { tracesHeaders: KEY })).toMatchObject({
      ok: false,
      status: 503,
      error: "Max Cloud is not configured"
    });
    expect(patchProject(owner, created.id, { modelKey: "sk-test" })).toMatchObject({ ok: false, status: 503 });
    // Removing them needs no key.
    expect(patchProject(owner, created.id, { tracesHeaders: "" })).toMatchObject({ ok: true });
  });

  it("are moved onto a new CLOUD_SECRET_KEY with the other secrets", async () => {
    const owner = await customer();
    const created = project(owner);
    patch(owner, created.id, { tracesHeaders: KEY });
    expect(checkStoredSecrets()).toMatchObject({ total: 1, current: 1, unreadable: [] });
    const old = Buffer.from(process.env.CLOUD_SECRET_KEY!, "base64");
    process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("base64");
    process.env.CLOUD_SECRET_KEY_PREVIOUS = old.toString("hex");
    try {
      resetCloudKeyCheck();
      expect(checkStoredSecrets()).toMatchObject({ previous: 1 });
      expect(reencryptStoredSecrets()).toMatchObject({ reencrypted: 1, unreadable: [] });
      expect(projectSecrets()).toHaveLength(1);
      delete process.env.CLOUD_SECRET_KEY_PREVIOUS;
      expect(checkStoredSecrets()).toMatchObject({ current: 1, unreadable: [] });
      const row = liveProject(created.id)!;
      expect(
        decryptModelKey(
          row.traces_headers_enc!,
          [Buffer.from(process.env.CLOUD_SECRET_KEY!, "base64")],
          tracesHeadersScope(created.id)
        )
      ).toBe(KEY);
    } finally {
      delete process.env.CLOUD_SECRET_KEY_PREVIOUS;
    }
  });

  it("are added to a database made before the column existed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "max-traces-"));
    const file = path.join(dir, "cloud.sqlite");
    try {
      resetCloudDatabase(file);
      const owner = await customer();
      const created = project(owner);
      resetCloudDatabase();
      // As an older relay left it: no such column.
      const old = new DatabaseSync(file);
      old.exec("ALTER TABLE projects DROP COLUMN traces_headers_enc");
      old.close();
      resetCloudDatabase(file);
      const listed = listProjects(owner);
      expect(listed).toMatchObject([{ id: created.id, hasTracesHeaders: false }]);
      expect(listed[0]!.studio.traces).toEqual(DEFAULT_TRACES);
      expect(patch(owner, created.id, { tracesHeaders: KEY }).hasTracesHeaders).toBe(true);
      // And a new project is made with it.
      expect(project(owner, { name: "Second" }).hasTracesHeaders).toBe(false);
    } finally {
      resetCloudDatabase();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reach a session as the headers, or as unreadable when they cannot be decrypted", async () => {
    const owner = await customer();
    const created = project(owner);
    patch(owner, created.id, {
      modelKey: "sk-test",
      tracesHeaders: KEY,
      studio: { traces: { endpoint: COLLECTOR, content: false } }
    });
    expect(projectRuntime(created.id)).toMatchObject({ name: "Shop", tracesHeaders: KEY });
    expect(projectRuntime(created.id)).not.toHaveProperty("tracesHeadersUnreadable");
    // Sealed under another key.
    updateProject(created.id, owner, {
      traces_headers_enc: encryptModelKey(KEY, randomBytes(32), tracesHeadersScope(created.id))
    });
    const runtime = projectRuntime(created.id)!;
    expect(runtime.tracesHeadersUnreadable).toBe(true);
    expect(runtime.tracesHeaders).toBeUndefined();
    // A project without a collector reads none of it.
    patch(owner, created.id, { studio: { traces: DEFAULT_TRACES } });
    expect(projectRuntime(created.id)).not.toHaveProperty("tracesHeadersUnreadable");
  });
});

// --- exporting --------------------------------------------------------------------

type Sent = {
  url: string;
  headers: Record<string, string>;
  spans: Record<string, unknown>[];
  service: string;
  raw: string;
};

/** A collector that answers with `answer` and remembers what it was sent. */
function collector(answer: () => Response | Promise<Response> = () => new Response(null, { status: 200 })) {
  const sent: Sent[] = [];
  const request = vi.fn(async (url: unknown, init?: RequestInit) => {
    const raw = String(init?.body);
    const body = JSON.parse(raw) as {
      resourceSpans: {
        resource: { attributes: { key: string; value: { stringValue: string } }[] };
        scopeSpans: { spans: Record<string, unknown>[] }[];
      }[];
    };
    sent.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      spans: body.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
      service: body.resourceSpans[0]!.resource.attributes.find((attribute) => attribute.key === "service.name")!.value
        .stringValue,
      raw
    });
    return answer();
  });
  return { sent, request: request as unknown as typeof fetch, calls: request };
}

const SESSION = {
  projectId: "prj_1",
  name: "Shop",
  backend: "openai",
  traces: { endpoint: COLLECTOR, content: false }
};

/** A conversation as the relay sends it to the client: a question, a tool, an answer. */
function converse(tracer: { event(payload: unknown): void }) {
  tracer.event({ type: "session.started", provider: "openai" });
  tracer.event({ type: "transcript", speaker: "rider", final: true, text: "Where is my order A-1042?", turnId: "t1" });
  tracer.event({ type: "status", state: "speaking" });
  tracer.event({ type: "tool.activity", callId: "c1", name: "check_order", state: "started", where: "server" });
  tracer.event({ type: "tool.activity", callId: "c1", name: "check_order", state: "succeeded", durationMs: 412 });
  tracer.event({ type: "transcript", speaker: "agent", final: true, text: "It arrives on Friday.", turnId: "t1" });
  tracer.event({ type: "telemetry", asrMs: 100, thinkMs: 300, firstAudioMs: 500, totalMs: 900 });
  tracer.event({ type: "status", state: "listening" });
}

const names = (sent: Sent) => sent.spans.map((span) => span.name);

describe("exporting a project's conversations", () => {
  it("sends a conversation as spans to the project's endpoint with the project's headers", async () => {
    const found = collector();
    const traces = createProjectTraces({ request: found.request });
    const tracer = traces.open({ ...SESSION, sessionId: "s1", headers: KEY })!;
    expect(tracer).toBeDefined();
    converse(tracer);
    tracer.end("client");
    await traces.drain(2000);
    expect(found.sent).toHaveLength(1);
    const [one] = found.sent;
    expect(one!.url).toBe(COLLECTOR);
    expect(one!.headers).toMatchObject({
      authorization: "Basic c2VjcmV0LWtleS1wYWlyOg==",
      "x-team": "prod",
      "content-type": "application/json"
    });
    expect(one!.service).toBe("Shop");
    expect(names(one!).sort()).toEqual(["voice.session", "voice.tool", "voice.turn"]);
    const session = one!.spans.find((span) => span.name === "voice.session")!;
    const attributes = Object.fromEntries(
      (session.attributes as { key: string; value: Record<string, unknown> }[]).map((attribute) => [
        attribute.key,
        Object.values(attribute.value)[0]
      ])
    );
    expect(attributes).toMatchObject({
      "session.id": "s1",
      "voice.channel": "web",
      "voice.backend": "openai",
      "voice.end_reason": "client",
      "gen_ai.agent.name": "Shop",
      "voice.turns": "1",
      "voice.tool_calls": "1"
    });
    // Tool arguments are never sent, whatever the setting.
    expect(one!.raw).not.toContain("arguments");
  });

  it("sends no words unless the project asked for them", async () => {
    const off = collector();
    const traces = createProjectTraces({ request: off.request });
    const quiet = traces.open({ ...SESSION, sessionId: "s1" })!;
    converse(quiet);
    quiet.end("client");
    await traces.drain(2000);
    expect(off.sent[0]!.raw).not.toContain("Where is my order");
    expect(off.sent[0]!.raw).not.toContain("Friday");
    expect(off.sent[0]!.raw).toContain("check_order");

    const on = collector();
    const wordy = createProjectTraces({ request: on.request });
    const loud = wordy.open({ ...SESSION, sessionId: "s2", traces: { endpoint: COLLECTOR, content: true } })!;
    converse(loud);
    loud.end("client");
    await wordy.drain(2000);
    expect(on.sent[0]!.raw).toContain("Where is my order A-1042?");
    expect(on.sent[0]!.raw).toContain("It arrives on Friday.");
  });

  it("makes no tracer and no request for a project without an endpoint, or whose headers cannot be read", async () => {
    const found = collector();
    const traces = createProjectTraces({ request: found.request });
    expect(traces.open({ ...SESSION, sessionId: "s1", traces: DEFAULT_TRACES })).toBeUndefined();
    expect(traces.open({ ...SESSION, sessionId: "s2", headersUnreadable: true })).toBeUndefined();
    expect(traces.open({ ...SESSION, sessionId: "s3", headersUnreadable: true, headers: KEY })).toBeUndefined();
    await traces.drain(100);
    expect(found.calls).not.toHaveBeenCalled();
  });

  it("warns once of headers that cannot be read, and never says what they were", async () => {
    const lines: string[] = [];
    for (const method of ["warn", "error", "log", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    }
    const traces = createProjectTraces({ request: collector().request });
    for (let index = 0; index < 3; index += 1) {
      traces.open({ ...SESSION, sessionId: `s${index}`, headersUnreadable: true });
    }
    const warnings = lines.filter((line) => line.includes("trace headers"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("Authorization");
  });

  it("shares one exporter between a project's concurrent conversations and closes it after the last", async () => {
    const found = collector();
    const traces = createProjectTraces({ request: found.request });
    const first = traces.open({ ...SESSION, sessionId: "s1", headers: KEY })!;
    const second = traces.open({ ...SESSION, sessionId: "s2", headers: KEY })!;
    converse(first);
    converse(second);
    first.end("client");
    // The exporter is still open for the second: nothing has been sent.
    await traces.drain(100);
    expect(found.calls).not.toHaveBeenCalled();
    // Ending twice is no second release.
    first.end("client");
    second.end("client");
    await traces.drain(2000);
    expect(found.calls).toHaveBeenCalledTimes(1);
    expect(new Set(found.sent[0]!.spans.map((span) => span.traceId)).size).toBe(2);
    expect(found.sent[0]!.spans).toHaveLength(6);
    // Nothing lives on: the next conversation gets an exporter of its own.
    const third = traces.open({ ...SESSION, sessionId: "s3", headers: KEY })!;
    third.end("client");
    await traces.drain(2000);
    expect(found.calls).toHaveBeenCalledTimes(2);
  });

  it("gives conversations that start after a change the new endpoint, and the old exporter closes with its own", async () => {
    const found = collector();
    const traces = createProjectTraces({ request: found.request });
    const before = traces.open({ ...SESSION, sessionId: "s1", headers: "x-api-key=old" })!;
    const other = "https://api.honeycomb.io/v1/traces";
    const after = traces.open({
      ...SESSION,
      sessionId: "s2",
      traces: { endpoint: other, content: false },
      headers: "x-honeycomb-team=new"
    })!;
    after.end("client");
    await traces.drain(2000);
    expect(found.sent.map((sent) => sent.url)).toEqual([other]);
    expect(found.sent[0]!.headers["x-honeycomb-team"]).toBe("new");
    expect(found.sent[0]!.headers["x-api-key"]).toBeUndefined();
    before.end("client");
    await traces.drain(2000);
    expect(found.sent.map((sent) => sent.url)).toEqual([other, COLLECTOR]);
    expect(found.sent[1]!.headers["x-api-key"]).toBe("old");
    // Changed headers alone are a change too, and so is the project's name.
    const a = traces.open({ ...SESSION, sessionId: "s3", headers: "x-api-key=1" })!;
    const b = traces.open({ ...SESSION, sessionId: "s4", headers: "x-api-key=2" })!;
    const c = traces.open({ ...SESSION, sessionId: "s5", name: "Renamed", headers: "x-api-key=2" })!;
    for (const tracer of [a, b, c]) tracer.end("client");
    await traces.drain(2000);
    expect(found.sent.slice(2).map((sent) => [sent.service, sent.headers["x-api-key"]])).toEqual(
      expect.arrayContaining([
        ["Shop", "1"],
        ["Shop", "2"],
        ["Renamed", "2"]
      ])
    );
    expect(found.sent).toHaveLength(5);
  });

  it("does not throw or stop the next conversation when the collector is down", async () => {
    vi.useFakeTimers();
    let up = false;
    const found = collector(() => (up ? new Response(null, { status: 200 }) : new Response("no", { status: 503 })));
    const traces = createProjectTraces({ request: found.request });
    const down = traces.open({ ...SESSION, sessionId: "s1" })!;
    converse(down);
    expect(() => down.end("client")).not.toThrow();
    const draining = traces.drain(10_000);
    await vi.advanceTimersByTimeAsync(2000);
    await draining;
    // One try and one retry, then the spans are dropped.
    expect(found.calls).toHaveBeenCalledTimes(2);
    up = true;
    const next = traces.open({ ...SESSION, sessionId: "s2" })!;
    converse(next);
    next.end("client");
    await traces.drain(2000);
    expect(found.calls).toHaveBeenCalledTimes(3);
    expect(found.sent[2]!.spans).toHaveLength(3);

    // A request that cannot even be made (a name that does not resolve) is no different.
    const refused = createProjectTraces({
      request: (async () => {
        throw new Error("collector.example.com could not be found: check the address");
      }) as unknown as typeof fetch
    });
    const lost = refused.open({ ...SESSION, sessionId: "s3" })!;
    converse(lost);
    expect(() => lost.end("client")).not.toThrow();
    const waiting = refused.drain(10_000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("never throws into a session, whatever the events are", () => {
    const traces = createProjectTraces({ request: collector().request });
    const tracer = traces.open({ ...SESSION, sessionId: "s1" })!;
    for (const junk of [null, undefined, 5, "x", [], { type: 5 }, { type: "tool.activity" }]) {
      expect(() => tracer.event(junk)).not.toThrow();
    }
    expect(() => tracer.end()).not.toThrow();
    expect(() => tracer.event({ type: "transcript" })).not.toThrow();
  });

  it("drains: waits for what is being sent, and gives up when the time is up", async () => {
    let finish: (() => void) | undefined;
    const slow = collector(
      () =>
        new Promise<Response>((resolve) => {
          finish = () => resolve(new Response(null, { status: 200 }));
        })
    );
    const traces = createProjectTraces({ request: slow.request });
    // Nothing pending: at once.
    await traces.drain(10);
    const tracer = traces.open({ ...SESSION, sessionId: "s1" })!;
    converse(tracer);
    tracer.end("client");
    let done = false;
    const started = Date.now();
    await traces.drain(50);
    expect(Date.now() - started).toBeLessThan(1500);
    // Time was up before the collector answered.
    expect(slow.calls).toHaveBeenCalledTimes(1);
    expect(finish).toBeDefined();
    const waiting = traces.drain(5000).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    finish!();
    await waiting;
    expect(done).toBe(true);
  });
});

// --- the console's test -----------------------------------------------------------

describe("a project's traces test", () => {
  const target = { name: "Shop", endpoint: COLLECTOR, headers: KEY };

  it("sends one small sample trace, marked as a test, with the saved headers", async () => {
    const found = collector();
    const traces = createProjectTraces({ request: found.request });
    expect(await traces.test(target)).toEqual({ ok: true });
    expect(found.calls).toHaveBeenCalledTimes(1);
    const [one] = found.sent;
    expect(one!.url).toBe(COLLECTOR);
    expect(one!.headers.authorization).toBe("Basic c2VjcmV0LWtleS1wYWlyOg==");
    expect(names(one!).sort()).toEqual(["voice.session", "voice.turn"]);
    expect(one!.service).toBe("Shop");
    expect(one!.raw).toContain('"key":"max.test","value":{"boolValue":true}');
    expect(one!.raw).toContain("Shop (test)");
    // No test leaves anything behind for the exporter of a real conversation.
    await traces.drain(10);
    expect(found.calls).toHaveBeenCalledTimes(1);
  });

  it("says in words why the collector did not take it, and does not try again", async () => {
    const unauthorised = collector(() => new Response("no", { status: 401 }));
    expect(await createProjectTraces({ request: unauthorised.request }).test(target)).toEqual({
      ok: false,
      error: "HTTP 401 from the collector: it did not accept the headers (check the API key)"
    });
    expect(unauthorised.calls).toHaveBeenCalledTimes(1);
    const missing = collector(() => new Response("no", { status: 404 }));
    expect(await createProjectTraces({ request: missing.request }).test(target)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^HTTP 404 from the collector/)
    });
    // A server error is not tried twice either: a test is one request.
    const broken = collector(() => new Response("no", { status: 502 }));
    expect(await createProjectTraces({ request: broken.request }).test(target)).toEqual({
      ok: false,
      error: "HTTP 502 from the collector"
    });
    expect(broken.calls).toHaveBeenCalledTimes(1);
  });

  it("says when the collector cannot be reached", async () => {
    const lost = vi.fn(async () => {
      throw new Error("tool address must be public, not a private one");
    }) as unknown as typeof fetch;
    expect(await createProjectTraces({ request: lost }).test(target)).toEqual({
      ok: false,
      error: "the address must be public, not a private one"
    });
    expect(lost).toHaveBeenCalledTimes(1);
    const timeout = vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch;
    expect(await createProjectTraces({ request: timeout }).test(target)).toEqual({
      ok: false,
      error: "the collector did not answer within 10 seconds"
    });
  });
});
