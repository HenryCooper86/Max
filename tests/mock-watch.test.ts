import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockProvider } from "../server/providers/mock";
import { metrics } from "../server/metrics";

// Harness: same "fake client capturing sent JSON, construct the provider
// directly" idiom as tests/mock-camera-frame.test.ts's "mock provider
// camera.look" suite — no AgentSessionController, no real WebSocket, and
// provider.visionFrames()/deviceResult()/hazardReport() are called directly
// rather than routed through a controller. vision.watch is gated to the
// "embedded" platform (device-actions.ts's PLATFORM_RESTRICTED_ACTIONS), so
// sessions here start with that platform, like mock-camera-frame.test.ts's
// camera.look coverage.
//
// Driving "开启环境观察" through dispatchDeviceCommand has no public entry
// point (see mock-camera-frame.test.ts's harness comment for why: the mock
// has no ASR, dispatchDeviceCommand only ever sees SCENARIOS' fixed scripted
// lines, and that function is private to the closure), so this task adds one
// line to the "commute" scenario's script (server/providers/mock.ts),
// matching the existing device-action demo lines already scripted there.
// advanceUntil() scans forward through the scripted turn cycle rather than
// hardcoding a turn index, so it stays correct if commute's turn list is
// reordered or extended later.
function makeClient() {
  const messages: Array<Record<string, unknown>> = [];
  const client = {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => messages.push(JSON.parse(raw))
  } as unknown as Parameters<typeof createMockProvider>[0];
  return { client, messages };
}

/** Advances the mock's 6 s scripted-turn interval until `predicate` holds. */
function advanceUntil(predicate: () => boolean, stepMs = 6000, maxSteps = 20): void {
  for (let step = 0; step < maxSteps && !predicate(); step += 1) {
    vi.advanceTimersByTime(stepMs);
  }
  if (!predicate()) throw new Error("condition not reached — scripted vision.watch turn never fired");
}

function findWatchCommand(messages: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return messages.find((message) => message.type === "device.command" && message.action === "vision.watch");
}

function agentTranscripts(messages: Array<Record<string, unknown>>, text: string): Record<string, unknown>[] {
  return messages.filter(
    (message) =>
      message.type === "transcript" &&
      message.speaker === "agent" &&
      message.final === true &&
      message.useBrowserSpeech === true &&
      message.text === text
  );
}

const WATCH_ANSWER = "前方有施工路段，注意慢行。";

/** Drives the scripted "开启环境观察" turn, then delivers the ok device.result
 *  for it — the same "issue then resolve" shape as a real session's
 *  vision.watch dispatch (server/device-actions.ts's IssuedDeviceCommand).
 *  Advances past the scripted turn's own 650 ms + 1500 ms reply cycle
 *  (thinking → speaking → listening) so replyPending settles back to false —
 *  otherwise the toggle turn's own in-flight reply would still hold the
 *  speech gate open for the caller's very next watch frame. */
async function toggleWatchOn(
  provider: ReturnType<typeof createMockProvider>,
  messages: Array<Record<string, unknown>>
): Promise<void> {
  await provider.startAudio();
  advanceUntil(() => findWatchCommand(messages) !== undefined);
  const commandId = findWatchCommand(messages)!.commandId as string;
  await provider.deviceResult!({ type: "device.result", commandId, status: "ok" });
  vi.advanceTimersByTime(2200);
}

afterEach(() => {
  vi.useRealTimers();
  metrics.reset();
});

describe("mock provider watch frames", () => {
  it("speaks the watch observation once vision.watch is toggled on", async () => {
    vi.useFakeTimers();
    const { client, messages } = makeClient();
    const provider = createMockProvider(client);

    await provider.start({ type: "session.start", sampleRate: 16000, channels: 1, platform: "embedded" });
    await toggleWatchOn(provider, messages);

    await provider.visionFrames!({ type: "vision.frames", reason: "watch", index: 0, total: 1, image: "F" });

    expect(agentTranscripts(messages, WATCH_ANSWER)).toHaveLength(1);

    await provider.close();
  });

  it("drops a watch frame when vision.watch was never toggled on", async () => {
    vi.useFakeTimers();
    const { client, messages } = makeClient();
    const provider = createMockProvider(client);

    await provider.start({ type: "session.start", sampleRate: 16000, channels: 1, platform: "embedded" });

    await provider.visionFrames!({ type: "vision.frames", reason: "watch", index: 0, total: 1, image: "F" });

    expect(agentTranscripts(messages, WATCH_ANSWER)).toHaveLength(0);
    expect(metrics.watchDrops.disabled).toBe(1);

    await provider.close();
  });

  it("drops a repeat observation inside the 2 min cooldown, then speaks again once it elapses", async () => {
    vi.useFakeTimers();
    const { client, messages } = makeClient();
    let clock = 0;
    const provider = createMockProvider(client, undefined, () => clock);

    await provider.start({ type: "session.start", sampleRate: 16000, channels: 1, platform: "embedded" });
    await toggleWatchOn(provider, messages);

    await provider.visionFrames!({ type: "vision.frames", reason: "watch", index: 0, total: 1, image: "F" });
    expect(agentTranscripts(messages, WATCH_ANSWER)).toHaveLength(1);

    clock += 60_000; // 1 min later — still inside the 2 min cooldown
    await provider.visionFrames!({ type: "vision.frames", reason: "watch", index: 0, total: 1, image: "F" });
    expect(agentTranscripts(messages, WATCH_ANSWER)).toHaveLength(1);
    expect(metrics.watchDrops.cooldown).toBe(1);

    clock += 60_001; // past 2 min since the FIRST observation
    await provider.visionFrames!({ type: "vision.frames", reason: "watch", index: 0, total: 1, image: "F" });
    expect(agentTranscripts(messages, WATCH_ANSWER)).toHaveLength(2);
    // The successful re-speak must not itself register as a drop.
    expect(metrics.watchDrops.cooldown).toBe(1);

    await provider.close();
  });

  it("drops a watch frame inside the ADAS window after a hazard.report", async () => {
    vi.useFakeTimers();
    const { client, messages } = makeClient();
    const provider = createMockProvider(client);

    await provider.start({ type: "session.start", sampleRate: 16000, channels: 1, platform: "embedded" });
    await toggleWatchOn(provider, messages);

    await provider.hazardReport!({
      type: "hazard.report",
      threat: "tailgating",
      direction: "rear",
      severity: "caution",
      label: "追尾预警",
      message: "后方车辆距离过近。",
      advice: "适当加速或变道。"
    });

    await provider.visionFrames!({ type: "vision.frames", reason: "watch", index: 0, total: 1, image: "F" });

    expect(agentTranscripts(messages, WATCH_ANSWER)).toHaveLength(0);
    expect(metrics.watchDrops["adas-window"]).toBe(1);

    await provider.close();
  });
});
