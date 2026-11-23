import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, patchProject, type Result } from "../server/cloud/customers";
import { runDraftReplay } from "../server/cloud/replay-runner";
import { saveStudioDraft, studioRelease } from "../server/cloud/revisions";
import { setCloudClock } from "../server/cloud/context";
import { monthOf } from "../server/cloud/billing";
import { insertCustomer, resetCloudDatabase, usageSummary } from "../server/cloud/store";
import { createLiveProvider } from "../server/providers/live/session";
import type { EngineEvents } from "../server/providers/live/engine";
import { LIVE_CAPABILITIES } from "../shared/agent";
import { createVoiceProvider } from "../server/providers/factory";
import type { ProviderSessionContext } from "../server/providers/types";
import type { ToolContext } from "../server/tools";
import type { ReplayCase } from "../shared/studio-replay";

vi.mock("../server/providers/factory", () => ({ createVoiceProvider: vi.fn() }));
let directory: string;
let project: string;
const owner = "owner";
const sample: ReplayCase = {
  id: "sample",
  version: 2,
  prompt: "Order status?",
  expected: "Delivered",
  fixtures: { lookup: "arrived" }
};
const tool = { name: "lookup", description: "Find an order", url: "https://example.com/production" };
function value<T>(result: Result<T>) {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function draft(patch: Record<string, unknown> = {}) {
  const state = value(studioRelease(owner, project));
  return value(
    saveStudioDraft(owner, project, {
      baseRevision: state.liveRevision,
      draftRevision: state.draft?.id ?? null,
      patch: { instructions: "Be specific", modelKey: "test-key", studio: { tools: [tool] }, ...patch }
    })
  ).draft!.id;
}
beforeEach(() => {
  vi.stubEnv("CLOUD_SECRET_KEY", "ac".repeat(32));
  directory = mkdtempSync(join(tmpdir(), "studio-runner-"));
  resetCloudDatabase(join(directory, "cloud.db"));
  insertCustomer({ id: owner, email: "owner@example.com", password_hash: "", password_salt: "", created_at: 1 });
  project = value(createProject(owner, { name: "Desk" })).project.id;
});
afterEach(() => {
  setCloudClock();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetCloudDatabase();
  rmSync(directory, { recursive: true, force: true });
});
function fake(answer: string, beforeAnswer?: () => void) {
  const close = vi.fn(async () => {});
  const input = vi.fn();
  const outputs: unknown[] = [];
  vi.mocked(createVoiceProvider).mockImplementation((_id, _socket, _log, telemetry, overrides) => {
    let context: ProviderSessionContext | undefined;
    return {
      close,
      upstreamUsable: () => true,
      start: async (_event, ctx) => {
        context = ctx;
        telemetry.serverEvent({ type: "status", state: "ready" }, 10);
      },
      startAudio: async () => {},
      sendAudio: async () => {},
      stopAudio: async () => {},
      textInput: async (text) => {
        input(text);
        try {
          outputs.push(await overrides!.serverTools!()[0]!.handler({}, {} as ToolContext));
        } catch {
          outputs.push("missing");
        }
        beforeAnswer?.();
        context?.onTurnAnswer?.(answer);
      }
    };
  });
  return { close, input, outputs };
}
it("answers the redacted prompt through the draft with simulated tools and no release proof", async () => {
  const revision = draft();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const agent = fake("It was DELIVERED.");
  expect(await runDraftReplay(owner, project, revision, sample)).toEqual({
    ok: true,
    value: {
      run: {
        caseId: "sample",
        caseVersion: 2,
        revision,
        answer: "It was DELIVERED.",
        passed: true,
        tools: [{ name: "lookup", mocked: true }]
      }
    }
  });
  expect(agent.input.mock.calls).toEqual([[sample.prompt]]);
  expect(agent.outputs).toEqual(["arrived"]);
  expect(agent.close).toHaveBeenCalledOnce();
  expect(vi.mocked(createVoiceProvider).mock.calls[0]![4]).toMatchObject({
    apiKey: "test-key",
    profile: { instructions: "Be specific" }
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(value(studioRelease(owner, project)).draft?.tested).toBe(false);
});
it("fails mismatches and flags absent fixtures even when the model guesses the expected answer", async () => {
  const revision = draft();
  fake("It is pending.");
  expect(await runDraftReplay(owner, project, revision, sample)).toMatchObject({
    value: { run: { passed: false, answer: "It is pending." } }
  });
  fake("Delivered");
  expect(await runDraftReplay(owner, project, revision, { ...sample, fixtures: {} })).toMatchObject({
    value: { run: { passed: false, answer: "", tools: [{ name: "lookup", mocked: false }] } }
  });
});
it("rejects stale revisions, absent keys and other owners before connecting", async () => {
  const missing = draft({ modelKey: "" });
  expect(await runDraftReplay(owner, project, missing, sample)).toMatchObject({
    status: 409,
    error: expect.stringContaining("model key")
  });
  const revision = draft();
  expect(await runDraftReplay(owner, project, missing, sample)).toMatchObject({ status: 409 });
  expect(await runDraftReplay("other", project, revision, sample)).toMatchObject({ status: 409 });
  expect(createVoiceProvider).not.toHaveBeenCalled();
});
it("discards a result if the draft changes while the model answers", async () => {
  const revision = draft();
  fake("Delivered", () => {
    draft({ instructions: "Updated" });
  });
  expect(await runDraftReplay(owner, project, revision, sample)).toMatchObject({ status: 409 });
});
it("closes and books a hanging upstream on cancellation or deadline", async () => {
  const revision = draft();
  vi.useFakeTimers();
  const close = vi.fn(async () => {});
  vi.mocked(createVoiceProvider).mockImplementation(() => ({
    start: () => new Promise<void>(() => {}),
    close,
    startAudio: async () => {},
    stopAudio: async () => {},
    sendAudio: async () => {}
  }));
  const abort = new AbortController();
  const first = runDraftReplay(owner, project, revision, sample, abort.signal);
  abort.abort();
  expect(await first).toMatchObject({ status: 499 });
  const second = runDraftReplay(owner, project, revision, sample);
  await vi.advanceTimersByTimeAsync(45_000);
  expect(await second).toMatchObject({ status: 504 });
  expect(close).toHaveBeenCalledTimes(2);
});
it("returns a bounded error without sending provider credentials or details to the client", async () => {
  const revision = draft();
  vi.mocked(createVoiceProvider).mockImplementation(() => {
    throw new Error("secret provider error");
  });
  expect(await runDraftReplay(owner, project, revision, sample)).toEqual({
    ok: false,
    status: 502,
    error: "The model could not complete this replay."
  });
});

it("meters connected time and applies the normal monthly cap to subsequent replays", async () => {
  let at = Date.now();
  setCloudClock(() => at);
  value(patchProject(owner, project, { monthlyMinutesCap: 1 }));
  const revision = draft();
  fake("Delivered", () => {
    at += 30_000;
  });
  expect((await runDraftReplay(owner, project, revision, sample)).ok).toBe(true);
  expect((await runDraftReplay(owner, project, revision, sample)).ok).toBe(true);
  expect(usageSummary(owner, monthOf(at))).toMatchObject({ seconds: 60, freeSecondsUsed: 60 });
  expect(await runDraftReplay(owner, project, revision, sample)).toMatchObject({ ok: false, status: 403 });
  expect(createVoiceProvider).toHaveBeenCalledTimes(2);
});

it.each(["missing fixture", "undeclared tool", "removed flow tool"])(
  "stops on a %s before a further model answer or upstream error",
  async (scenario) => {
    const flow =
      scenario === "removed flow tool"
        ? [
            { id: "main", instructions: "Assist.", onStart: { call: { tool: "lookup", arguments: {} } } },
            { id: "support", description: "Help", instructions: "Support the customer." }
          ]
        : [];
    const revision = draft({ studio: { tools: [tool], flow } });
    const name = scenario === "undeclared tool" ? "hallucinated" : "lookup";
    const connect = vi.fn();
    const close = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let events: EngineEvents;
    vi.mocked(createVoiceProvider).mockImplementation((id, socket, log, telemetry, overrides) =>
      createLiveProvider(
        socket,
        {
          id,
          label: "Replay",
          capabilities: LIVE_CAPABILITIES,
          createEngine: () => ({
            responseMode: "auto",
            async connect(_config, sink) {
              events = sink;
              connect();
            },
            close,
            sendAudio() {},
            respond() {},
            cancel() {},
            sendText() {
              events.onResponseStarted();
              events.onToolCall?.({ callId: "tool-1", name, arguments: "{}" });
              events.onError("Provider died before answering");
            }
          })
        },
        log,
        telemetry,
        { ...overrides, ...(scenario === "removed flow tool" ? { serverTools: () => [] } : {}) }
      )
    );
    const fixtures = scenario === "missing fixture" ? {} : { [name]: "fabricated output" };
    expect(await runDraftReplay(owner, project, revision, { ...sample, fixtures })).toMatchObject({
      ok: true,
      value: { run: { answer: "", passed: false, tools: [{ name, mocked: false }] } }
    });
    expect(fetch).not.toHaveBeenCalled();
    if (scenario === "removed flow tool") expect(connect).not.toHaveBeenCalled();
    else expect(close).toHaveBeenCalled();
  }
);
