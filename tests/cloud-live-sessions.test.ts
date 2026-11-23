// Max Cloud sessions while they run: what is billed (only the time the voice
// model could talk), how often they are checkpointed and checked, and the
// limits that keep a public embed from draining its owner's balance.
import { randomBytes } from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_CAPABILITIES } from "../shared/agent";
import {
  chargeSession,
  cloudSessionEnded,
  projectRuntime,
  recoverCloudSessions,
  remainingSeconds
} from "../server/cloud";
import { setCloudClock, setCloudInstanceId } from "../server/cloud/context";
import { cloudCounters } from "../server/cloud/counters";
import { createProject, listProjects, patchProject, rotateProjectKey, signup } from "../server/cloud/customers";
import {
  CLOUD_CHECK_INTERVAL_MS,
  admitCloudSession,
  openCloudSession,
  projectLimitRefusal,
  resetLiveCloudSessions
} from "../server/cloud/live";
import { saveStudioDraft, studioRelease } from "../server/cloud/revisions";
import { mintEmbedSession, mintTestSession, resetCloudSessionLimits, spendEmbedTokens } from "../server/cloud/sessions";
import { adjustBalance, liveSessionRows, resetCloudDatabase } from "../server/cloud/store";
import { createLogger } from "../server/logger";
import type { EngineConfig, EngineEvents, VoiceEngine } from "../server/providers/live/engine";
import { createLiveProvider } from "../server/providers/live/session";
import { cloudSessionTokens } from "../server/session-tokens";

const START = Date.UTC(2026, 10, 18, 12, 0, 0);
const SITE = "https://shop.example.com";
const USAGE_LIMIT = 4003;
let clock = START;
const saved = { key: process.env.CLOUD_SECRET_KEY, signup: process.env.CLOUD_SIGNUP };

beforeEach(() => {
  process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.CLOUD_SIGNUP = "open";
  resetCloudDatabase(":memory:");
  resetCloudSessionLimits();
  resetLiveCloudSessions();
  setCloudInstanceId("relay-a");
  clock = START;
  setCloudClock(() => clock);
});

afterEach(() => {
  resetCloudDatabase();
  resetLiveCloudSessions();
  setCloudClock();
  setCloudInstanceId();
  vi.useRealTimers();
  for (const [name, value] of [
    ["CLOUD_SECRET_KEY", saved.key],
    ["CLOUD_SIGNUP", saved.signup]
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function setup(options: { embed?: boolean } = {}) {
  const account = await signup(`c${randomBytes(4).toString("hex")}@example.com`, "correct horse battery");
  if (!account.ok) throw new Error(account.error);
  const customerId = account.value.customer.id;
  const created = createProject(customerId, { name: "Shop" });
  if (!created.ok) throw new Error(created.error);
  const project = created.value.project;
  const patched = patchProject(customerId, project.id, {
    modelKey: "sk-test",
    ...(options.embed ? { studio: { ...project.studio, publicEmbed: { enabled: true, origins: [SITE] } } } : {})
  });
  if (!patched.ok) throw new Error(patched.error);
  const minted = mintTestSession(customerId, project.id);
  if (!minted.ok) throw new Error(minted.error);
  const grant = cloudSessionTokens.grant(minted.value.token)!.project!;
  return {
    customerId,
    projectId: project.id,
    publicId: project.publicId,
    apiKey: created.value.apiKey,
    grant,
    embedGrant: { ...grant, source: "embed" as const }
  };
}

function draft(customerId: string, projectId: string, greeting: string) {
  const release = studioRelease(customerId, projectId);
  if (!release.ok) throw new Error(release.error);
  const result = saveStudioDraft(customerId, projectId, {
    baseRevision: release.value.liveRevision,
    draftRevision: release.value.draft?.id ?? null,
    patch: { greeting }
  });
  if (!result.ok) throw new Error(result.error);
  return result.value.draft!;
}

it("resolves the draft only for its test token and refuses that token after replacement", async () => {
  const { customerId, projectId } = await setup();
  const initial = draft(customerId, projectId, "First draft greeting");
  const minted = mintTestSession(customerId, projectId, initial.id);
  if (!minted.ok) throw new Error(minted.error);
  const grant = cloudSessionTokens.grant(minted.value.token)!.project!;
  expect(projectRuntime(projectId, grant)?.greeting).toBe("First draft greeting");
  expect(projectRuntime(projectId)?.greeting).toBeUndefined();

  draft(customerId, projectId, "Replacement draft");
  expect(projectRuntime(projectId, grant)).toBeUndefined();
});

it("records a draft test when the connected upstream is ready", async () => {
  const { customerId, projectId } = await setup();
  const initial = draft(customerId, projectId, "Draft greeting");
  const minted = mintTestSession(customerId, projectId, initial.id);
  if (!minted.ok) throw new Error(minted.error);
  const grant = cloudSessionTokens.grant(minted.value.token)!.project!;
  const tested = () => {
    const result = studioRelease(customerId, projectId);
    if (!result.ok) throw new Error(result.error);
    return result.value.draft?.tested;
  };

  expect(tested()).toBe(false);
  const session = openCloudSession("draft", grant, "console");
  session.observe({ type: "session.started" }, false);
  session.observe({ type: "status", state: "ready" }, false);
  expect(tested()).toBe(false);
  session.observe({ type: "status", state: "ready" }, true);
  expect(tested()).toBe(true);
  clock += 2_000;
  expect(session.close()).toBe(2);
});

it("refuses readiness for a revision grant if the project's key rotated during startup", async () => {
  const { customerId, projectId } = await setup();
  const initial = draft(customerId, projectId, "Draft greeting");
  const minted = mintTestSession(customerId, projectId, initial.id);
  if (!minted.ok) throw new Error(minted.error);
  const grant = cloudSessionTokens.grant(minted.value.token)!.project!;
  const session = openCloudSession("draft", grant, "console");
  expect(rotateProjectKey(customerId, projectId).ok).toBe(true);
  expect(projectRuntime(projectId, grant)).toBeUndefined();
  expect(session.observe({ type: "status", state: "ready" }, true)).toMatchObject({ code: 1008 });
  clock += 2_000;
  expect(session.close()).toBe(0);
});

it("stops a draft test whose revision is replaced while its upstream reconnects", async () => {
  const { customerId, projectId } = await setup();
  const initial = draft(customerId, projectId, "Draft greeting");
  const minted = mintTestSession(customerId, projectId, initial.id);
  if (!minted.ok) throw new Error(minted.error);
  const grant = cloudSessionTokens.grant(minted.value.token)!.project!;
  const session = openCloudSession("draft", grant, "console");
  session.observe({ type: "status", state: "ready" }, true);
  clock += 2_000;
  session.observe({ type: "status", state: "connecting" }, false);
  draft(customerId, projectId, "Replacement draft");
  expect(session.observe({ type: "status", state: "listening" }, true)).toMatchObject({ code: 1008 });
  clock += 2_000;
  expect(session.close()).toBe(2);
});

it("pins a no-draft preview to the live revision confirmed by Studio", async () => {
  const { customerId, projectId } = await setup();
  const release = studioRelease(customerId, projectId);
  if (!release.ok) throw new Error(release.error);
  const revision = release.value.liveRevision;
  const mint = (expected: string) => mintTestSession(customerId, projectId, undefined, expected);
  expect(mint("other-revision")).toMatchObject({ ok: false, status: 409 });
  const minted = mint(revision);
  if (!minted.ok) throw new Error(minted.error);
  const grant = cloudSessionTokens.grant(minted.value.token)!.project!;
  expect(projectRuntime(projectId, grant)?.modelKey).toBe("sk-test");
  const session = openCloudSession("live-preview", grant, "console");
  expect(patchProject(customerId, projectId, { greeting: "Changed while connecting" }).ok).toBe(true);
  expect(projectRuntime(projectId, grant)).toBeUndefined();
  expect(session.observe({ type: "status", state: "ready" }, true)).toMatchObject({ code: 1008 });
});

it("refuses a no-draft preview if a draft already exists", async () => {
  const { customerId, projectId } = await setup();
  draft(customerId, projectId, "Draft greeting");
  const release = studioRelease(customerId, projectId);
  if (!release.ok) throw new Error(release.error);
  expect(mintTestSession(customerId, projectId, undefined, release.value.liveRevision)).toMatchObject({
    ok: false,
    status: 409
  });
});

it("marks only the first answered website turn, even with transcript storage off", async () => {
  const { customerId, projectId, grant, embedGrant } = await setup({ embed: true });
  const project = () => listProjects(customerId)[0]!;
  patchProject(customerId, projectId, { studio: { ...project().studio, keepConversations: false } });
  const utterance = (speaker: "rider" | "agent", final = true, text = "hello") => ({
    type: "transcript",
    speaker,
    final,
    text
  });
  for (const [source, origin] of [
    ["test", SITE],
    ["api", undefined],
    ["api", "null"]
  ] as const) {
    const session = openCloudSession("excluded", { ...grant, source }, "visitor", origin);
    session.observe(utterance("rider"));
    session.observe(utterance("agent"));
    session.close();
  }
  expect(project().firstWebsiteConversationAt).toBeNull();
  const website = openCloudSession("website", embedGrant, "visitor", SITE);
  website.observe({ type: "status", state: "ready" });
  website.observe(utterance("agent")); // Greeting.
  website.observe(utterance("rider", false));
  website.observe(utterance("agent"));
  website.observe(utterance("rider"));
  website.observe(utterance("agent", false));
  website.observe(utterance("agent", true, "  "));
  website.observe(utterance("agent"), false);
  expect(project().firstWebsiteConversationAt).toBeNull();
  website.observe(utterance("agent"));
  expect(project().firstWebsiteConversationAt).toBe(START);
  clock += 1000;
  const other = openCloudSession("another", embedGrant, "another visitor", SITE);
  other.observe(utterance("rider"));
  other.observe(utterance("agent"));
  expect(project().firstWebsiteConversationAt).toBe(START);
  const sdk = await setup();
  const browser = openCloudSession("sdk", { ...sdk.grant, source: "api" }, "visitor", SITE);
  browser.observe(utterance("rider"));
  browser.observe(utterance("agent"));
  expect(listProjects(sdk.customerId)[0]!.firstWebsiteConversationAt).toBe(clock);
});

it("recognizes a website audio answer before the transcript arrives", async () => {
  const { customerId, embedGrant } = await setup();
  const live = openCloudSession("audio", embedGrant, "visitor", SITE);
  live.observe({ type: "metric", latencyMs: -1 });
  expect(listProjects(customerId)[0]!.firstWebsiteConversationAt).toBeNull();
  live.observe({ type: "metric", latencyMs: 250 });
  expect(listProjects(customerId)[0]!.firstWebsiteConversationAt).toBe(START);
});

it("recovers only confirmed website conversations from an older database and survives transcript deletion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "max-website-"));
  const file = path.join(dir, "cloud.sqlite");
  try {
    resetCloudDatabase(file);
    const { customerId, projectId } = await setup();
    resetCloudDatabase(file);
    const old = new DatabaseSync(file);
    try {
      old.exec("ALTER TABLE projects DROP COLUMN first_website_conversation_at");
      const insert = old.prepare(
        "INSERT INTO conversations (id, customer_id, project_id, started_at, ended_at, seconds, source, turns) VALUES (?, ?, ?, 0, ?, 1, ?, ?)"
      );
      const exchanges = [
        ["test", ["user", "agent"]],
        ["api", ["user", "agent"]],
        ["embed", ["agent", "user"]],
        ["embed", ["user", "tool"]],
        ["embed", ["user", "agent"]],
        ["embed", ["user", "agent"]]
      ] as const;
      exchanges.forEach(([source, speakers], i) =>
        insert.run(
          String(i),
          customerId,
          projectId,
          i + 1,
          source,
          JSON.stringify(speakers.map((speaker) => ({ speaker, text: "hello" })))
        )
      );
    } finally {
      old.close();
    }
    expect(listProjects(customerId)[0]!.firstWebsiteConversationAt).toBe(5);
    resetCloudDatabase(file);
    const db = new DatabaseSync(file);
    try {
      db.exec("DELETE FROM conversations");
    } finally {
      db.close();
    }
    expect(listProjects(customerId)[0]!.firstWebsiteConversationAt).toBe(5);
  } finally {
    resetCloudDatabase(":memory:");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Credits balance by hand, as scripts/cloud-credit.ts does: 1 fen buys 4 seconds. */
function creditSeconds(customerId: string, seconds: number): void {
  adjustBalance({
    customerId,
    amountFen: Math.ceil(seconds / 4),
    ref: `test-${randomBytes(4).toString("hex")}`,
    at: clock
  });
}

/** Uses up the month's free seconds, so the balance alone pays, then leaves the customer `seconds`. */
function leaveSeconds(customerId: string, projectId: string, seconds: number): void {
  chargeSession({ customerId, projectId, sessionId: "free-month", seconds: 60_000, endedAt: clock });
  expect(remainingSeconds(customerId)).toBe(0);
  creditSeconds(customerId, seconds);
}

const status = (state: string) => ({ type: "status", state, detail: "" });
const counter = (name: string) => cloudCounters()[name] ?? 0;

describe("the billed time", () => {
  it("starts when the voice model is ready, not when the socket connects", async () => {
    const { grant } = await setup();
    const session = openCloudSession("s-1", grant, "203.0.113.5");
    clock += 1_000; // session.start arrives
    session.observe({ type: "session.started", provider: "openai" });
    session.observe(status("connecting"));
    clock += 4_000; // the upstream takes its time
    session.observe(status("ready"));
    clock += 60_000;
    session.observe(status("listening"));
    clock += 30_000;
    expect(session.close()).toBe(90);
  });

  it("pauses while the relay reconnects to the voice model", async () => {
    const { grant } = await setup();
    const session = openCloudSession("s-2", grant, "203.0.113.5");
    session.observe(status("ready"));
    clock += 30_000;
    session.observe(status("connecting"));
    clock += 10_000;
    session.observe(status("listening"));
    clock += 20_000;
    session.observe(status("degraded")); // still connected, still talking
    clock += 5_000;
    session.observe(status("closed"));
    clock += 7_000;
    expect(session.close()).toBe(55);
  });

  it("stays paused when the user mutes or types while the voice model reconnects", async () => {
    const { grant } = await setup();
    const session = openCloudSession("s-2b", grant, "203.0.113.5");
    session.observe(status("ready"), true);
    clock += 30_000;
    session.observe(status("connecting"), false);
    clock += 2_000;
    // Mute, unmute and a typed turn each report a status of their own.
    session.observe(status("ready"), false);
    clock += 3_000;
    session.observe(status("listening"), false);
    clock += 3_000;
    session.observe(status("hearing"), false);
    clock += 2_000;
    session.observe(status("listening"), true); // reconnected
    clock += 20_000;
    expect(session.close()).toBe(50);
  });

  it("is nothing for a session whose voice model never connected", async () => {
    const { customerId, projectId, grant } = await setup();
    const before = remainingSeconds(customerId);
    const session = openCloudSession("s-3", grant, "203.0.113.5");
    session.observe(status("connecting"));
    clock += 12_000;
    const seconds = session.close();
    expect(seconds).toBe(0);
    expect(cloudSessionEnded({ customerId, projectId, sessionId: "s-3", seconds, endedAt: clock })).toBe(
      "not-billable"
    );
    expect(remainingSeconds(customerId)).toBe(before);
    expect(liveSessionRows({ projectId })).toEqual([]);
  });

  it("follows what a live voice backend reports", async () => {
    vi.useFakeTimers({ now: START });
    setCloudClock(() => Date.now());
    const { grant } = await setup();
    const session = openCloudSession("s-4", grant, "203.0.113.5");
    let engines = 0;
    let down = false;
    let events: EngineEvents | undefined;
    const client = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: () => undefined, close: () => undefined };
    const provider = createLiveProvider(
      client as never,
      {
        id: "openai",
        label: "Test Voice",
        capabilities: LIVE_CAPABILITIES,
        createEngine: () => {
          engines += 1;
          const engine: VoiceEngine = {
            responseMode: "auto",
            connect: async (_config: EngineConfig, engineEvents: EngineEvents) => {
              await new Promise((resolve) => setTimeout(resolve, 2_000)); // a slow upstream
              if (down) throw new Error("upstream down");
              events = engineEvents;
            },
            sendAudio: () => undefined,
            respond: () => undefined,
            cancel: () => undefined,
            close: () => undefined
          } as VoiceEngine;
          return engine;
        }
      },
      createLogger("test"),
      {
        serverEvent: (payload) => session.observe(payload),
        serverAudio: () => undefined,
        ttsFallback: () => undefined
      },
      {
        wakeWord: false,
        fetchWeather: async () => ({
          description: "晴",
          temperatureC: 20,
          windSpeedKmh: 5,
          isDay: true,
          riskLevel: "normal",
          riderAdvice: "",
          summary: "晴，20°C。"
        })
      }
    );
    const started = provider.start({ type: "session.start", sampleRate: 16000, channels: 1 });
    await vi.advanceTimersByTimeAsync(2_000);
    await started;
    await provider.startAudio();
    expect(session.seconds()).toBe(0); // the two seconds of connecting are not billed
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.seconds()).toBe(60);

    // The upstream drops and comes back after a 400 ms backoff and a 2 s connect.
    events!.onClosed("closed (1006)");
    await vi.advanceTimersByTimeAsync(2_400);
    expect(engines).toBe(2);
    expect(session.seconds()).toBe(60);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.seconds()).toBe(70);

    // Then it stays down: three failed attempts, and none of that time is billed.
    down = true;
    events!.onClosed("closed (1006)");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(session.seconds()).toBe(70);
    await provider.close();
  });
});

describe("checkpoints and checks", () => {
  it("run every 5 seconds, recording the billed time so far", async () => {
    expect(CLOUD_CHECK_INTERVAL_MS).toBe(5_000);
    const { projectId, grant } = await setup();
    const session = openCloudSession("s-cp", grant, "203.0.113.5");
    session.observe(status("ready"));
    clock += 5_000;
    expect(session.check()).toBeUndefined();
    expect(liveSessionRows({ projectId })).toMatchObject([{ session_id: "s-cp", seconds: 5, last_seen: clock }]);
  });

  it("let a session start only with at least one check interval of balance, counting open sessions", async () => {
    const { customerId, projectId, grant } = await setup();
    leaveSeconds(customerId, projectId, 4);
    expect(admitCloudSession(grant, "203.0.113.5")).toMatchObject({ code: USAGE_LIMIT, reason: "balance used up" });
    creditSeconds(customerId, 20);
    expect(admitCloudSession(grant, "203.0.113.5")).toBeUndefined();
    const running = openCloudSession("s-a", grant, "203.0.113.5");
    running.observe(status("ready"));
    clock += 20_000;
    expect(admitCloudSession(grant, "203.0.113.5")).toMatchObject({ code: USAGE_LIMIT });
  });

  it("close a session within one interval of the balance running out", async () => {
    const { customerId, projectId, grant } = await setup();
    leaveSeconds(customerId, projectId, 12);
    const session = openCloudSession("s-b", grant, "203.0.113.5");
    session.observe(status("ready"));
    clock += 5_000;
    expect(session.check()).toBeUndefined();
    clock += 5_000;
    expect(session.check()).toBeUndefined();
    clock += 5_000;
    expect(session.check()).toMatchObject({ code: USAGE_LIMIT, reason: "balance used up" });
    expect(session.check()).toBeUndefined(); // reported once
  });

  it("do not count twice what another relay already booked of a session that is still running", async () => {
    const { customerId, projectId, grant } = await setup();
    leaveSeconds(customerId, projectId, 100);
    const session = openCloudSession("s-early", grant, "203.0.113.5");
    session.observe(status("ready"));
    clock += 40_000;
    expect(session.check()).toBeUndefined();
    // The relay stalls for over a minute (the voice model is reconnecting, so nothing is billed meanwhile)
    // and another relay takes the session for abandoned: 40 s go into the ledger, 60 s of balance are left.
    session.observe(status("connecting"));
    clock += 61_000;
    setCloudInstanceId("relay-b");
    expect(recoverCloudSessions()).toBe(1);
    expect(remainingSeconds(customerId)).toBe(60);

    setCloudInstanceId("relay-a");
    session.observe(status("ready"));
    clock += 5_000;
    expect(session.check()).toBeUndefined(); // writes the row again
    clock += 20_000; // 65 s on the session's clock, 25 s of them not in the ledger: 35 s left, not -5
    expect(session.check()).toBeUndefined();
    expect(admitCloudSession(grant, "203.0.113.6")).toBeUndefined();
    // The other relay's view counts the row the same way.
    setCloudInstanceId("relay-b");
    expect(remainingSeconds(customerId)).toBe(35);
    setCloudInstanceId("relay-a");
    clock += 35_000;
    expect(session.check()).toMatchObject({ code: USAGE_LIMIT, reason: "balance used up" });
    expect(session.close()).toBe(100);
    expect(remainingSeconds(customerId)).toBe(0);
  });

  it("close a session whose project key was rotated, and count it", async () => {
    const { customerId, projectId, grant } = await setup();
    const killed = counter("max_cloud_sessions_killed_key_rotation_total");
    const session = openCloudSession("s-k", grant, "203.0.113.5");
    rotateProjectKey(customerId, projectId);
    clock += 5_000;
    expect(session.check()).toMatchObject({ code: 1008, reason: "project revoked" });
    expect(counter("max_cloud_sessions_killed_key_rotation_total")).toBe(killed + 1);
  });

  it("refuse a new session, but never cut off a running one, when the store cannot be read", async () => {
    const { grant } = await setup();
    const session = openCloudSession("s-db", grant, "203.0.113.5");
    session.observe(status("ready"));
    resetCloudDatabase(os.tmpdir()); // a directory: every query now fails
    clock += 5_000;
    expect(() => session.check()).not.toThrow();
    expect(session.check()).toBeUndefined();
    expect(admitCloudSession(grant, "203.0.113.6")).toMatchObject({ code: 1013, reason: "cloud store unavailable" });
  });

  it("keep a customer to 5 sessions at once", async () => {
    const { grant } = await setup();
    for (let index = 0; index < 5; index += 1) openCloudSession(`s-${index}`, grant, `203.0.113.${index}`);
    expect(admitCloudSession(grant, "203.0.113.99")).toMatchObject({ code: 1013, reason: "too many sessions" });
  });
});

describe("a project's monthly minutes limit", () => {
  it("is set by the owner, whole minutes or none", async () => {
    const { customerId, projectId } = await setup();
    expect(patchProject(customerId, projectId, { monthlyMinutesCap: 300 })).toMatchObject({
      ok: true,
      value: { project: { monthlyMinutesCap: 300 } }
    });
    for (const bad of [0, -5, 1.5, "300", 250_001, true]) {
      expect(patchProject(customerId, projectId, { monthlyMinutesCap: bad })).toMatchObject({ ok: false, status: 400 });
    }
    expect(patchProject(customerId, projectId, { name: "Still capped" })).toMatchObject({
      value: { project: { monthlyMinutesCap: 300 } }
    });
    expect(patchProject(customerId, projectId, { monthlyMinutesCap: null })).toMatchObject({
      value: { project: { monthlyMinutesCap: null } }
    });
  });

  it("refuses new tokens and sessions once this month's minutes reach it", async () => {
    const { customerId, projectId, publicId, grant } = await setup({ embed: true });
    patchProject(customerId, projectId, { monthlyMinutesCap: 10 });
    const refusals = counter("max_cloud_spend_cap_refusals_total");
    chargeSession({ customerId, projectId, sessionId: "earlier", seconds: 590, endedAt: clock });
    expect(projectLimitRefusal(projectId)).toBeUndefined();
    expect(mintEmbedSession({ publicId, origin: SITE, address: "203.0.113.5" }).ok).toBe(true);

    chargeSession({ customerId, projectId, sessionId: "more", seconds: 10, endedAt: clock });
    expect(projectLimitRefusal(projectId)).toMatchObject({ code: USAGE_LIMIT });
    expect(mintEmbedSession({ publicId, origin: SITE, address: "203.0.113.5" })).toMatchObject({
      ok: false,
      status: 403,
      error: expect.stringMatching(/minutes/)
    });
    expect(mintTestSession(customerId, projectId)).toMatchObject({ ok: false, status: 403 });
    expect(admitCloudSession(grant, "203.0.113.5")).toMatchObject({
      code: USAGE_LIMIT,
      reason: "project monthly limit"
    });
    expect(counter("max_cloud_spend_cap_refusals_total")).toBe(refusals + 4);

    // A new month starts it again; raising the limit or removing it works at once.
    patchProject(customerId, projectId, { monthlyMinutesCap: 11 });
    expect(projectLimitRefusal(projectId)).toBeUndefined();
    patchProject(customerId, projectId, { monthlyMinutesCap: 10 });
    clock = Date.UTC(2026, 11, 1, 0, 0, 1);
    expect(projectLimitRefusal(projectId)).toBeUndefined();
  });

  it("closes running sessions when they reach it, counting every one of them", async () => {
    const { customerId, projectId, grant } = await setup();
    patchProject(customerId, projectId, { monthlyMinutesCap: 1 });
    const first = openCloudSession("s-1", grant, "203.0.113.5");
    const second = openCloudSession("s-2", grant, "203.0.113.6");
    first.observe(status("ready"));
    second.observe(status("ready"));
    clock += 25_000;
    expect(first.check()).toBeUndefined();
    clock += 5_000; // 2 x 30 s = the minute
    expect(first.check()).toMatchObject({ code: USAGE_LIMIT, reason: "project monthly limit" });
    expect(second.check()).toMatchObject({ code: USAGE_LIMIT, reason: "project monthly limit" });
  });

  it("counts sessions running on another relay", async () => {
    const { customerId, projectId } = await setup();
    patchProject(customerId, projectId, { monthlyMinutesCap: 1 });
    // Another relay sharing the database has a session at 25 s.
    setCloudInstanceId("relay-b");
    const elsewhere = openCloudSession("s-b", { projectId, customerId, keyHash: "x", source: "api" }, "198.51.100.1");
    elsewhere.observe(status("ready"));
    clock += 25_000;
    elsewhere.check();
    resetLiveCloudSessions(); // relay-b's memory is not this relay's
    setCloudInstanceId("relay-a");
    expect(projectLimitRefusal(projectId)).toBeUndefined();
    clock += 5_000;
    cloudSessionEnded({ customerId, projectId, sessionId: "s-earlier", seconds: 40, endedAt: clock });
    expect(projectLimitRefusal(projectId)).toMatchObject({ code: USAGE_LIMIT });
  });

  it("is off by default", async () => {
    const { customerId, projectId } = await setup();
    chargeSession({ customerId, projectId, sessionId: "long", seconds: 50_000, endedAt: clock });
    expect(projectLimitRefusal(projectId)).toBeUndefined();
  });
});

describe("public embed sessions", () => {
  it("are limited per visitor address as well as per customer", async () => {
    const { embedGrant, grant } = await setup({ embed: true });
    openCloudSession("e-1", embedGrant, "203.0.113.5");
    openCloudSession("e-2", embedGrant, "203.0.113.5");
    expect(admitCloudSession(embedGrant, "203.0.113.5")).toMatchObject({
      code: 1013,
      reason: "too many embed sessions from one address"
    });
    // The customer's own sessions from that address are not embed sessions.
    expect(admitCloudSession(grant, "203.0.113.5")).toBeUndefined();
    expect(admitCloudSession(embedGrant, "198.51.100.7")).toBeUndefined();
    openCloudSession("e-3", embedGrant, "198.51.100.7");
    expect(admitCloudSession(embedGrant, "192.0.2.1")).toMatchObject({ code: 1013, reason: "too many embed sessions" });
  });

  it("free their slot when they close", async () => {
    const { embedGrant } = await setup({ embed: true });
    const first = openCloudSession("e-1", embedGrant, "203.0.113.5");
    openCloudSession("e-2", embedGrant, "203.0.113.5");
    first.close();
    expect(admitCloudSession(embedGrant, "203.0.113.5")).toBeUndefined();
  });

  it("open one session per token", async () => {
    const { customerId, projectId, publicId } = await setup({ embed: true });
    const embed = mintEmbedSession({ publicId, origin: SITE, address: "203.0.113.5" });
    const test = mintTestSession(customerId, projectId);
    if (!embed.ok || !test.ok) throw new Error("not minted");
    expect(spendEmbedTokens([embed.value.token])).toBe(true);
    expect(cloudSessionTokens.grant(embed.value.token)).toBeUndefined();
    expect(spendEmbedTokens([embed.value.token])).toBe(false);
    // The console's test tokens and project-key tokens keep their reconnects.
    expect(spendEmbedTokens([test.value.token])).toBe(true);
    expect(spendEmbedTokens([test.value.token])).toBe(true);
    expect(cloudSessionTokens.grant(test.value.token)).toBeDefined();
    expect(spendEmbedTokens(["vst_unknown", "relay-token"])).toBe(true);
  });
});
