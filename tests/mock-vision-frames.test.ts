import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockProvider } from "../server/providers/mock";

// Harness: same "fake client capturing sent JSON, construct the provider
// directly" idiom as tests/mock-camera-frame.test.ts's "mock provider
// camera.look" suite — no AgentSessionController, no real WebSocket, and
// provider.visionFrames() is called directly rather than routed through a
// controller (mirroring provider.cameraFrame() in that file).
//
// Driving a specific rider utterance through the mock provider has no public
// entry point (see mock-camera-frame.test.ts's harness comment for why), so
// this task adds two lines to the "commute" scenario's script
// (server/providers/mock.ts) — one video reference, one photo reference,
// both without a question — matching the existing camera.look demo lines
// already scripted there. advanceUntil() scans forward through the scripted
// turn cycle rather than hardcoding a turn index, so it stays correct if
// commute's turn list is reordered or extended later.
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
  if (!predicate()) throw new Error("condition not reached — scripted gallery.describe turn never fired");
}

function findGalleryDescribeCommand(
  messages: Array<Record<string, unknown>>,
  kind: "video" | "photo"
): Record<string, unknown> | undefined {
  return messages.find((message) => {
    if (message.type !== "device.command" || message.action !== "gallery.describe") return false;
    const args = message.args as { kind?: string } | undefined;
    return args?.kind === kind;
  });
}

function agentTranscript(messages: Array<Record<string, unknown>>, text: string): Record<string, unknown> | undefined {
  return messages.find(
    (message) =>
      message.type === "transcript" &&
      message.speaker === "agent" &&
      message.final === true &&
      message.useBrowserSpeech === true &&
      message.text === text
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("mock provider gallery.describe frame sets", () => {
  it("assembles three out-of-order chunks into a video set and speaks the multi-frame mock answer", async () => {
    vi.useFakeTimers();
    const { client, messages } = makeClient();
    const provider = createMockProvider(client);

    // gallery.describe is gated to the iOS platform by extractDeviceCommandForPlatform.
    await provider.start({ type: "session.start", sampleRate: 16000, channels: 1, platform: "ios" });
    await provider.startAudio();
    advanceUntil(() => findGalleryDescribeCommand(messages, "video") !== undefined);

    const command = findGalleryDescribeCommand(messages, "video");
    const commandId = command!.commandId as string;

    await provider.visionFrames!({
      type: "vision.frames",
      commandId,
      reason: "gallery",
      index: 2,
      total: 3,
      image: "F2"
    });
    await provider.visionFrames!({
      type: "vision.frames",
      commandId,
      reason: "gallery",
      index: 0,
      total: 3,
      image: "F0"
    });
    await provider.visionFrames!({
      type: "vision.frames",
      commandId,
      reason: "gallery",
      index: 1,
      total: 3,
      image: "F1"
    });

    expect(agentTranscript(messages, "这段视频里，前方道路畅通，一路顺利。")).toBeDefined();

    await provider.close();
  });

  it("speaks the single-frame mock answer for a one-chunk photo set", async () => {
    vi.useFakeTimers();
    const { client, messages } = makeClient();
    const provider = createMockProvider(client);

    await provider.start({ type: "session.start", sampleRate: 16000, channels: 1, platform: "ios" });
    await provider.startAudio();
    advanceUntil(() => findGalleryDescribeCommand(messages, "photo") !== undefined);

    const command = findGalleryDescribeCommand(messages, "photo");
    const commandId = command!.commandId as string;

    await provider.visionFrames!({
      type: "vision.frames",
      commandId,
      reason: "gallery",
      index: 0,
      total: 1,
      image: "F0"
    });

    expect(agentTranscript(messages, "前方道路畅通，天气晴朗。")).toBeDefined();

    await provider.close();
  });

  it("ignores vision.frames chunks for a commandId that was never issued", async () => {
    vi.useFakeTimers();
    const { client, messages } = makeClient();
    const provider = createMockProvider(client);

    await provider.start({ type: "session.start", sampleRate: 16000, channels: 1, platform: "ios" });

    await provider.visionFrames!({
      type: "vision.frames",
      commandId: "forged",
      reason: "gallery",
      index: 0,
      total: 1,
      image: "F0"
    });

    expect(messages.some((message) => message.type === "transcript" && message.speaker === "agent")).toBe(false);

    await provider.close();
  });

  it("speaks 我看不清。for an incomplete set once the assembler's 10 s timeout fires", async () => {
    vi.useFakeTimers();
    const { client, messages } = makeClient();
    const provider = createMockProvider(client);

    await provider.start({ type: "session.start", sampleRate: 16000, channels: 1, platform: "ios" });
    await provider.startAudio();
    advanceUntil(() => findGalleryDescribeCommand(messages, "video") !== undefined);

    const command = findGalleryDescribeCommand(messages, "video");
    const commandId = command!.commandId as string;

    // Only 1 of 2 declared frames ever arrives.
    await provider.visionFrames!({
      type: "vision.frames",
      commandId,
      reason: "gallery",
      index: 0,
      total: 2,
      image: "F0"
    });

    vi.advanceTimersByTime(10_000);

    expect(agentTranscript(messages, "我看不清。")).toBeDefined();

    await provider.close();
  });
});
