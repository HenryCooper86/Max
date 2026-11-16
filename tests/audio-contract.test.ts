import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { SilenceFiller, normalizeDeviceAudio, planAudio } from "../server/audio-contract";
import { metrics } from "../server/metrics";
import { createMockProvider } from "../server/providers/mock";
import { AgentSessionController } from "../server/session-controller";

describe("what a device may declare", () => {
  it("keeps the well-formed fields and drops the rest", () => {
    expect(
      normalizeDeviceAudio({
        echoCancellation: true,
        noiseSuppression: "yes",
        autoGainControl: false,
        voiceGate: true,
        wakeWord: 1,
        microphones: 2,
        speaker: "open",
        somethingNewer: { nested: true }
      })
    ).toEqual({ echoCancellation: true, autoGainControl: false, voiceGate: true, microphones: 2, speaker: "open" });
  });

  it("rejects impossible values and treats an empty declaration as none", () => {
    expect(normalizeDeviceAudio({ microphones: 0, speaker: "megaphone" })).toBeUndefined();
    expect(normalizeDeviceAudio({ microphones: 2.5 })).toBeUndefined();
    expect(normalizeDeviceAudio({ microphones: 99 })).toBeUndefined();
    expect(normalizeDeviceAudio([true])).toBeUndefined();
    expect(normalizeDeviceAudio("aec")).toBeUndefined();
    expect(normalizeDeviceAudio(null)).toBeUndefined();
  });
});

describe("what the relay does about it", () => {
  it("changes nothing for a device that declares nothing", () => {
    expect(planAudio(undefined, true)).toEqual({ wakeGate: "relay", silenceFill: false, bargeIn: "relay" });
    expect(planAudio({}, true)).toEqual({ wakeGate: "relay", silenceFill: false, bargeIn: "relay" });
  });

  it("leaves the name check to a device that spots the wake word", () => {
    expect(planAudio({ wakeWord: true }, true).wakeGate).toBe("device");
    expect(planAudio({ wakeWord: false }, true).wakeGate).toBe("relay");
    // The relay's wake word is off altogether: nobody checks.
    expect(planAudio({ wakeWord: true }, false).wakeGate).toBe("off");
  });

  it("supplies silence only for a device that gates its own audio", () => {
    expect(planAudio({ voiceGate: true }, true).silenceFill).toBe(true);
    expect(planAudio({ voiceGate: false }, true).silenceFill).toBe(false);
  });

  it("asks for a confirmed interruption only when echo can reach the microphone uncancelled", () => {
    expect(planAudio({ echoCancellation: false, speaker: "open" }, true).bargeIn).toBe("confirm");
    expect(planAudio({ echoCancellation: false, speaker: "loudspeaker" }, true).bargeIn).toBe("confirm");
    // No echo canceller, speaker type unknown: assume the worse case.
    expect(planAudio({ echoCancellation: false }, true).bargeIn).toBe("confirm");
    // A sealed earpiece leaks too little to matter.
    expect(planAudio({ echoCancellation: false, speaker: "sealed" }, true).bargeIn).toBe("relay");
    expect(planAudio({ echoCancellation: true, speaker: "open" }, true).bargeIn).toBe("relay");
    // Unknown is not "no": a device that does not say keeps today's behaviour.
    expect(planAudio({ speaker: "open" }, true).bargeIn).toBe("relay");
  });
});

describe("silence for a voice-gated device", () => {
  afterEach(() => vi.useRealTimers());

  it("fills the quiet after the last frame, long enough to end a turn, then stops", () => {
    vi.useFakeTimers();
    const sent: Buffer[] = [];
    const filler = new SilenceFiller((frame) => sent.push(frame));
    filler.frame();
    vi.advanceTimersByTime(SilenceFiller.GAP_MS - 1);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(640);
    expect(sent[0]!.every((byte) => byte === 0)).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(SilenceFiller.FILL_MS / 20);
    // Idle between turns: nothing more is sent.
    vi.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(SilenceFiller.FILL_MS / 20);
  });

  it("sends nothing while frames keep arriving and stops the moment they resume", () => {
    vi.useFakeTimers();
    const sent: Buffer[] = [];
    const filler = new SilenceFiller((frame) => sent.push(frame));
    for (let index = 0; index < 100; index += 1) {
      filler.frame();
      vi.advanceTimersByTime(20);
    }
    expect(sent).toHaveLength(0);

    vi.advanceTimersByTime(SilenceFiller.GAP_MS + 200);
    const during = sent.length;
    expect(during).toBeGreaterThan(0);
    filler.frame();
    vi.advanceTimersByTime(60);
    expect(sent).toHaveLength(during);
  });

  it("stops when the microphone closes", () => {
    vi.useFakeTimers();
    const sent: Buffer[] = [];
    const filler = new SilenceFiller((frame) => sent.push(frame));
    filler.frame();
    filler.stop();
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(0);
  });
});

describe("the contract over a real connection", () => {
  let server: http.Server | undefined;
  let wss: WebSocketServer | undefined;

  afterEach(async () => {
    for (const client of wss?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => wss?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    wss = undefined;
    server = undefined;
    metrics.reset();
  });

  async function started(audio: unknown): Promise<Record<string, unknown>> {
    server = http.createServer();
    wss = new WebSocketServer({ server, path: "/agent" });
    wss.on("connection", (client) => {
      const session = new AgentSessionController(client, createMockProvider);
      client.on("message", (data, isBinary) => void session.handleMessage(data, isBinary));
      client.on("close", () => void session.close());
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server port");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/agent`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const event = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no session.started")), 5000);
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if (parsed.type !== "session.started") return;
        clearTimeout(timeout);
        resolve(parsed);
      });
    });
    socket.send(
      JSON.stringify({
        type: "session.start",
        sampleRate: 16000,
        channels: 1,
        ...(audio === undefined ? {} : { audio })
      })
    );
    const result = await event;
    socket.close();
    return result;
  }

  it("tells the device what it decided", async () => {
    const event = await started({ echoCancellation: false, speaker: "open", voiceGate: true, junk: 1 });
    expect(event.audio).toMatchObject({ silenceFill: true, bargeIn: "confirm" });
  });

  it("announces the unchanged plan to a device that declares nothing", async () => {
    const event = await started(undefined);
    expect(event.audio).toMatchObject({ silenceFill: false, bargeIn: "relay" });
  });

  it("still connects a device whose declaration is nonsense", async () => {
    const event = await started("everything");
    expect(event.audio).toMatchObject({ silenceFill: false, bargeIn: "relay" });
  });
});
