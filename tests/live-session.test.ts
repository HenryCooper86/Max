import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_CAPABILITIES } from "../shared/agent";
import { createLogger } from "../server/logger";
import type { EngineConfig, EngineEvents, EngineResponseMode, VoiceEngine } from "../server/providers/live/engine";
import { buildLiveInstructions, createLiveProvider } from "../server/providers/live/session";
import { assistantProfileFrom, setAssistantProfileForTests } from "../server/assistant";
import type { SessionStartEvent } from "../server/providers/types";
import { createSessionMemory } from "../shared/session";

// Drives the vendor-neutral half of every live backend with a scripted engine:
// what reaches the wearer must not depend on which upstream is plugged in.

class FakeClient {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  json: Array<Record<string, unknown>> = [];
  audio: Buffer[] = [];
  closed?: { code: number; reason: string };
  send(data: string | Buffer) {
    if (typeof data === "string") this.json.push(JSON.parse(data) as Record<string, unknown>);
    else this.audio.push(data);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  of(type: string) {
    return this.json.filter((event) => event.type === type);
  }
  statuses() {
    return this.of("status").map((event) => event.state);
  }
}

class FakeEngine implements VoiceEngine {
  events!: EngineEvents;
  config!: EngineConfig;
  responded = 0;
  cancelled = 0;
  said: string[] = [];
  context: string[] = [];
  instructions: string[] = [];
  audioIn = 0;
  closedCount = 0;
  connectError?: Error;
  constructor(readonly responseMode: EngineResponseMode) {}
  async connect(config: EngineConfig, events: EngineEvents) {
    if (this.connectError) throw this.connectError;
    this.config = config;
    this.events = events;
  }
  sendAudio(pcm: Buffer) {
    this.audioIn += pcm.length;
  }
  respond() {
    this.responded += 1;
  }
  cancel() {
    this.cancelled += 1;
  }
  say(text: string) {
    this.said.push(text);
  }
  updateInstructions(text: string) {
    this.instructions.push(text);
  }
  addContext(text: string) {
    this.context.push(text);
  }
  close() {
    this.closedCount += 1;
  }
}

const START: SessionStartEvent = { type: "session.start", sampleRate: 16000, channels: 1 };

async function open(
  mode: EngineResponseMode,
  overrides: {
    wakeWord?: boolean;
    start?: Partial<SessionStartEvent>;
    engine?: FakeEngine;
    outage?: { down: boolean };
  } = {}
) {
  const client = new FakeClient();
  const engines: FakeEngine[] = [];
  const ttsFallback = vi.fn();
  const provider = createLiveProvider(
    client as never,
    {
      id: "openai",
      label: "Test Voice",
      capabilities: LIVE_CAPABILITIES,
      createEngine: () => {
        const engine = engines.length === 0 && overrides.engine ? overrides.engine : new FakeEngine(mode);
        if (overrides.outage?.down) engine.connectError = new Error("upstream down");
        engines.push(engine);
        return engine;
      }
    },
    createLogger("test"),
    { serverEvent: vi.fn(), serverAudio: vi.fn(), ttsFallback },
    {
      wakeWord: overrides.wakeWord ?? true,
      wakeDecisionMs: 500,
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
  await provider.start({ ...START, ...overrides.start });
  await provider.startAudio();
  return { client, provider, engines, engine: () => engines[engines.length - 1]!, ttsFallback };
}

function reply(engine: FakeEngine, text: string, audioBytes = 2000) {
  engine.events.onResponseStarted();
  engine.events.onAgentText(text);
  if (audioBytes) engine.events.onAgentAudio(Buffer.alloc(audioBytes, 1));
  engine.events.onResponseDone({ cancelled: false });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  setAssistantProfileForTests();
});

describe("live voice session", () => {
  it("announces the backend and forwards microphone audio once listening", async () => {
    const { client, provider, engine } = await open("manual-capable");
    expect(client.of("session.started")[0]).toMatchObject({ provider: "openai", mode: "live" });
    expect(engine().config.manualResponse).toBe(true);
    expect(engine().config.instructions).toContain("你是 Max");
    expect(client.statuses()).toContain("listening");
    await provider.sendAudio(Buffer.alloc(640));
    expect(engine().audioIn).toBe(640);
    await provider.stopAudio();
    await provider.sendAudio(Buffer.alloc(640));
    expect(engine().audioIn).toBe(640);
  });

  it("answers only when addressed, then keeps a follow-up window open", async () => {
    const { client, engine } = await open("manual-capable");
    engine().events.onSpeechStarted();
    engine().events.onRiderTranscript("今天吃什么", true);
    expect(engine().responded).toBe(0);

    engine().events.onSpeechStarted();
    engine().events.onRiderTranscript("Max，今天天气怎么样", true);
    expect(engine().responded).toBe(1);
    reply(engine(), "今天晴，二十度。");

    // No name this time, but inside the follow-up window.
    engine().events.onSpeechStarted();
    engine().events.onRiderTranscript("那明天呢", true);
    expect(engine().responded).toBe(2);

    const transcripts = client.of("transcript");
    expect(transcripts.filter((event) => event.speaker === "rider" && event.final)).toHaveLength(3);
    expect(transcripts.find((event) => event.speaker === "agent" && event.final)).toMatchObject({
      text: "今天晴，二十度。",
      useBrowserSpeech: false
    });
  });

  it("sends reply audio in board-sized chunks without splitting a sample", async () => {
    const { client, engine } = await open("manual-capable", { wakeWord: false });
    engine().events.onSpeechStarted();
    engine().events.onRiderTranscript("hello", true);
    engine().events.onResponseStarted();
    engine().events.onAgentAudio(Buffer.alloc(2001, 1));
    engine().events.onAgentAudio(Buffer.alloc(959, 1));
    expect(client.audio.every((chunk) => chunk.length <= 960 && chunk.length % 2 === 0)).toBe(true);
    expect(client.audio.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(2960);
    expect(client.statuses()).toContain("speaking");
    expect(client.of("telemetry")).toHaveLength(1);
  });

  it("withholds a reply from a self-answering backend until the wearer's words settle", async () => {
    const { client, engine } = await open("auto");
    expect(engine().config.manualResponse).toBe(false);

    // The upstream starts answering before its transcript of the wearer arrives.
    engine().events.onSpeechStarted();
    engine().events.onResponseStarted();
    engine().events.onAgentText("好的");
    engine().events.onAgentAudio(Buffer.alloc(1920, 1));
    expect(client.audio).toHaveLength(0);
    engine().events.onRiderTranscript("我们晚上去哪吃饭", true);
    engine().events.onAgentAudio(Buffer.alloc(1920, 1));
    engine().events.onResponseDone({ cancelled: false });
    expect(client.audio).toHaveLength(0);
    expect(engine().cancelled).toBe(1);
    expect(client.of("transcript").filter((event) => event.speaker === "agent")).toHaveLength(0);

    engine().events.onSpeechStarted();
    engine().events.onResponseStarted();
    engine().events.onAgentText("现在三点。");
    engine().events.onAgentAudio(Buffer.alloc(1920, 1));
    expect(client.audio).toHaveLength(0);
    engine().events.onRiderTranscript("Max 现在几点", true);
    expect(client.audio.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(1920);
    engine().events.onResponseDone({ cancelled: false });
    expect(client.of("transcript").at(-1)).toMatchObject({ speaker: "agent", text: "现在三点。", final: true });
  });

  it("decides on what it has when the transcript never settles", async () => {
    const { client, engine } = await open("auto");
    engine().events.onSpeechStarted();
    engine().events.onRiderTranscript("Max 帮我", false);
    engine().events.onResponseStarted();
    engine().events.onAgentAudio(Buffer.alloc(960, 1));
    expect(client.audio).toHaveLength(0);
    vi.advanceTimersByTime(500);
    expect(client.audio).toHaveLength(1);
  });

  it("stops talking when the wearer barges in", async () => {
    const { client, engine } = await open("manual-capable", { wakeWord: false });
    engine().events.onSpeechStarted();
    engine().events.onRiderTranscript("讲个故事", true);
    engine().events.onResponseStarted();
    engine().events.onAgentAudio(Buffer.alloc(960, 1));
    engine().events.onSpeechStarted();
    expect(engine().cancelled).toBe(1);
    expect(client.statuses().at(-1)).toBe("hearing");
    engine().events.onAgentAudio(Buffer.alloc(960, 1));
    expect(client.audio).toHaveLength(1);
  });

  it("lets the client speak a reply that arrived as text only", async () => {
    const { client, engine, ttsFallback } = await open("manual-only", { wakeWord: false });
    engine().events.onRiderTranscript("hello", true);
    expect(engine().responded).toBe(1);
    reply(engine(), "Hi there.", 0);
    expect(client.of("transcript").at(-1)).toMatchObject({ text: "Hi there.", final: true, useBrowserSpeech: true });
    expect(ttsFallback).toHaveBeenCalledOnce();
  });

  it("dispatches device actions and corrects the reply when one fails", async () => {
    const { client, provider, engine } = await open("manual-capable");
    engine().events.onSpeechStarted();
    engine().events.onRiderTranscript("Max，打开手电筒", true);
    const command = client.of("device.command")[0]!;
    expect(command).toMatchObject({ action: "torch.set", tier: "low" });

    engine().events.onResponseStarted();
    engine().events.onAgentAudio(Buffer.alloc(960, 1));
    await provider.deviceResult?.({
      type: "device.result",
      commandId: command.commandId as string,
      status: "failed",
      reason: "torch.unavailable"
    });
    expect(engine().cancelled).toBe(1);
    expect(engine().context[0]).toContain("torch.set: failed");
    const correction = client.of("transcript").at(-1)!;
    expect(correction).toMatchObject({ speaker: "agent", final: true, useBrowserSpeech: true });
    expect(String(correction.text)).not.toMatch(/已经打开/);
    // The interrupted reply's remaining audio is not played over the correction.
    engine().events.onAgentAudio(Buffer.alloc(960, 1));
    expect(client.audio).toHaveLength(1);
  });

  it("voices relay lines through the engine on the embedded board", async () => {
    const { client, provider, engine } = await open("manual-capable", { start: { platform: "embedded" } });
    provider.speakNavLine?.("前方 200 米右转");
    expect(engine().said).toEqual(["前方 200 米右转"]);
    expect(client.of("transcript").at(-1)).toMatchObject({ text: "前方 200 米右转", useBrowserSpeech: false });

    // The forced reply is audible even though nobody said the wake word, and
    // is not captioned a second time.
    engine().events.onResponseStarted();
    engine().events.onAgentText("前方 200 米右转");
    engine().events.onAgentAudio(Buffer.alloc(960, 1));
    engine().events.onResponseDone({ cancelled: false });
    expect(client.audio).toHaveLength(1);
    expect(client.of("transcript").filter((event) => event.text === "前方 200 米右转")).toHaveLength(1);

    provider.speakNavPrompt?.({ text: "过期提示", expiresAt: Date.now() - 1 } as never);
    expect(engine().said).toHaveLength(1);
  });

  it("surfaces the upstream's own message when the backend cannot connect", async () => {
    const engine = new FakeEngine("auto");
    engine.connectError = new Error("OpenAI Realtime: HTTP 401 — check the API key");
    await expect(open("auto", { engine })).rejects.toThrow(/check the API key/);
    expect(engine.closedCount).toBe(1);
  });

  it("reconnects in place when the upstream drops, then gives up loudly", async () => {
    const outage = { down: false };
    const { client, engines, engine } = await open("auto", { outage });
    engine().events.onClosed("closed (1006)");
    expect(client.statuses().at(-1)).toBe("connecting");
    await vi.advanceTimersByTimeAsync(400);
    expect(engines).toHaveLength(2);
    expect(client.statuses().at(-1)).toBe("listening");

    // From here on the upstream stays down: three attempts, then the client is told.
    outage.down = true;
    engine().events.onClosed("closed (1006)");
    await vi.advanceTimersByTimeAsync(400 + 800 + 1600);
    expect(engines).toHaveLength(5);
    expect(client.of("error")).toHaveLength(1);
    expect(client.closed?.code).toBe(1011);
  });

  it("folds weather into the instructions once it arrives", async () => {
    const { client, engine } = await open("manual-capable");
    await vi.advanceTimersByTimeAsync(0);
    expect(client.of("weather")).toHaveLength(1);
    expect(engine().instructions.at(-1)).toContain("实时骑行情报");
  });
});

describe("live instructions", () => {
  const base = {
    event: START,
    rideContext: { mode: "ride", scenario: "commute" } as const,
    memory: createSessionMemory("ride"),
    weatherRole: "",
    locationRole: "",
    wakeWord: true
  };

  it("keeps Max's stock language rule by default", () => {
    const text = buildLiveInstructions(base);
    expect(text).toContain("你是 Max");
    expect(text).toContain("[语言与交互规则]");
    expect(text).toContain("[真实能力边界]");
    expect(text).toContain("“Max”");
  });

  it("drops the stock language rule for a customised assistant", () => {
    setAssistantProfileForTests(assistantProfileFrom({ name: "Nova", device: "glasses", languages: ["en"] }));
    const text = buildLiveInstructions({ ...base, wakeWord: false });
    expect(text).toContain("You are Nova");
    expect(text).toContain("written in Chinese");
    expect(text).not.toContain("[语言与交互规则]");
    expect(text).not.toContain("[唤醒规则]");
  });
});
