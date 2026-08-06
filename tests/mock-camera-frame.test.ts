import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockProvider } from "../server/providers/mock";

// Harness: the same "fake client capturing sent JSON, construct the provider
// directly" idiom tests/adas.test.ts and tests/crash-escalation.test.ts
// already use for the mock provider (their "mock provider ADAS/crash
// injection" suites) — no AgentSessionController, no real WebSocket.
//
// Driving a specific rider utterance through the mock provider has no public
// entry point: the mock has no ASR, so dispatchDeviceCommand only ever sees
// the fixed scripted lines in SCENARIOS (server/providers/mock.ts), and that
// function is private to the closure. The only way to observe a camera.look
// device.command from the mock the way the brief prescribes is for a
// scenario to actually say the utterance — so this task adds two lines to
// the "commute" scenario's script (one bare, one with a question), matching
// the existing "// Exercises the device-action path..." torch/photo lines
// already scripted there. advanceUntil() below scans forward through the
// scripted turn cycle rather than hardcoding a turn index, so it stays
// correct if commute's turn list is reordered or extended later.
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
  if (!predicate()) throw new Error("condition not reached — scripted camera.look turn never fired");
}

function findCameraLookCommand(
  messages: Array<Record<string, unknown>>,
  withQuestion: boolean
): Record<string, unknown> | undefined {
  return messages.find((message) => {
    if (message.type !== "device.command" || message.action !== "camera.look") return false;
    const args = message.args as { question?: string } | undefined;
    return withQuestion ? Boolean(args?.question) : !args?.question;
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("mock provider camera.look", () => {
  it("describes a frame for an issued camera.look and speaks via transcript", async () => {
    vi.useFakeTimers();
    const { client, messages } = makeClient();
    const provider = createMockProvider(client);

    // camera.look is gated to the embedded platform by
    // extractDeviceCommandForPlatform — see device-actions.ts.
    await provider.start({ type: "session.start", sampleRate: 16000, channels: 1, platform: "embedded" });
    await provider.startAudio();
    advanceUntil(() => findCameraLookCommand(messages, false) !== undefined);

    const command = findCameraLookCommand(messages, false);
    const commandId = command!.commandId as string;

    await provider.cameraFrame!({ commandId, image: "aGVsbG8=" });

    const transcript = messages.find(
      (message) =>
        message.type === "transcript" &&
        message.speaker === "agent" &&
        message.final === true &&
        message.useBrowserSpeech === true &&
        message.text === "前方道路畅通，天气晴朗。"
    );
    expect(transcript).toBeDefined();

    await provider.close();
  });

  it("ignores a camera.frame whose commandId was never issued", async () => {
    vi.useFakeTimers();
    const { client, messages } = makeClient();
    const provider = createMockProvider(client);

    await provider.start({ type: "session.start", sampleRate: 16000, channels: 1, platform: "embedded" });

    await provider.cameraFrame!({ commandId: "forged", image: "x" });

    expect(messages.some((message) => message.type === "transcript" && message.speaker === "agent")).toBe(false);

    await provider.close();
  });

  it("answers the rider's question with the question-form mock string", async () => {
    vi.useFakeTimers();
    const { client, messages } = makeClient();
    const provider = createMockProvider(client);

    await provider.start({ type: "session.start", sampleRate: 16000, channels: 1, platform: "embedded" });
    await provider.startAudio();
    advanceUntil(() => findCameraLookCommand(messages, true) !== undefined);

    const command = findCameraLookCommand(messages, true);
    const commandId = command!.commandId as string;

    await provider.cameraFrame!({ commandId, image: "aGVsbG8=" });

    const transcript = messages.find(
      (message) =>
        message.type === "transcript" &&
        message.speaker === "agent" &&
        message.final === true &&
        message.useBrowserSpeech === true &&
        message.text === "关于“前面那个路牌写的什么”：我看到前方道路畅通。"
    );
    expect(transcript).toBeDefined();

    await provider.close();
  });
});
