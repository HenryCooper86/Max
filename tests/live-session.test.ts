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
  inputEnded = 0;
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
  endInput() {
    this.inputEnded += 1;
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

  it("tells the engine the input ended when the microphone stops, once", async () => {
    // An upstream that times turns by audio would otherwise hold a half-spoken turn open forever.
    const { provider, engine } = await open("manual-only");
    await provider.sendAudio(Buffer.alloc(640));
    await provider.stopAudio();
    expect(engine().inputEnded).toBe(1);
    await provider.stopAudio();
    expect(engine().inputEnded).toBe(1);
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

  it("skips its own name check for a device that spots the wake word itself", async () => {
    const { engine } = await open("manual-capable", { start: { audio: { wakeWord: true } } });
    // The device only sends speech meant for the assistant, so a turn without
    // the name is answered and the instructions no longer mention the rule.
    expect(engine().config.instructions).not.toContain("唤醒规则");
    // With no name check to wait for, the backend answers on its own.
    expect(engine().config.manualResponse).toBe(false);
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

  it("counts the wait for an answer from when the turn was over, not from when its words were written down", async () => {
    const { client, engine } = await open("auto", { wakeWord: false });
    const waited = () => client.of("metric").at(-1)?.latencyMs;
    // A speech-to-speech backend: it says the user stopped, answers, and writes their words down last.
    engine().events.onSpeechStarted();
    await vi.advanceTimersByTimeAsync(2_000);
    engine().events.onSpeechEnded!();
    await vi.advanceTimersByTimeAsync(600);
    engine().events.onResponseStarted();
    engine().events.onAgentAudio(Buffer.alloc(1920, 1));
    await vi.advanceTimersByTimeAsync(300);
    expect(client.of("metric")).toHaveLength(0);
    engine().events.onRiderTranscript("what time is it", true);
    // Heard 900 ms after the turn ended, although the words and the first sound came at the same moment.
    expect(waited()).toBe(900);
    expect(client.of("telemetry").at(-1)).toMatchObject({ asrMs: 2_900, totalMs: 2_900 });
    engine().events.onResponseDone({ cancelled: false });

    // A second reply to the same turn (it follows a tool call) tells no wait of its own.
    await vi.advanceTimersByTimeAsync(4_000);
    engine().events.onResponseStarted();
    engine().events.onAgentAudio(Buffer.alloc(1920, 1));
    expect(client.of("metric")).toHaveLength(1);
    engine().events.onResponseDone({ cancelled: false });

    // An engine that does not say when the turn ended: the words are all there is to go by.
    engine().events.onSpeechStarted();
    await vi.advanceTimersByTimeAsync(1_000);
    engine().events.onRiderTranscript("and tomorrow", true);
    await vi.advanceTimersByTimeAsync(450);
    engine().events.onResponseStarted();
    engine().events.onAgentAudio(Buffer.alloc(1920, 1));
    expect(waited()).toBe(450);
    engine().events.onResponseDone({ cancelled: false });

    // Said after the words were final, the end is not news, and an end from the turn before is not carried over.
    engine().events.onSpeechStarted();
    await vi.advanceTimersByTimeAsync(1_000);
    engine().events.onRiderTranscript("thanks", true);
    await vi.advanceTimersByTimeAsync(200);
    engine().events.onSpeechEnded!();
    await vi.advanceTimersByTimeAsync(100);
    engine().events.onResponseStarted();
    engine().events.onAgentAudio(Buffer.alloc(1920, 1));
    expect(waited()).toBe(300);
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

  it("marks a hearing status of a reply it cut itself with cause relay, and the wearer's voice without it", async () => {
    const engine = Object.assign(new FakeEngine("manual-capable"), { sendText: vi.fn() });
    const { client, provider } = await open("manual-capable", { wakeWord: false, engine });
    engine.events.onSpeechStarted();
    engine.events.onRiderTranscript("讲个故事", true);
    engine.events.onResponseStarted();
    engine.events.onAgentAudio(Buffer.alloc(960, 1));
    // A typed turn cuts the reply under way: the relay's doing, not the wearer's voice.
    await provider.textInput!("别讲了");
    const hearing = client.of("status").filter((event) => event.state === "hearing");
    expect(hearing).toHaveLength(2);
    expect(hearing[0]).not.toHaveProperty("cause");
    expect(hearing[1]).toMatchObject({ cause: "relay" });
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

  it("hands the assistant's chosen voice id to the engine", async () => {
    setAssistantProfileForTests(assistantProfileFrom({ voice: { id: "v_0123456789" } }));
    const withVoice = await open("auto");
    expect(withVoice.engine().config.voiceId).toBe("v_0123456789");
    setAssistantProfileForTests();
    const without = await open("auto");
    expect(without.engine().config).not.toHaveProperty("voiceId");
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
    // The connection that dropped is closed, so it lets go of what it held besides its upstream
    // (a place on the turn detector's server); the one that took over is not.
    expect(engines.map((made) => made.closedCount)).toEqual([1, 0]);

    // The new connection held, so its loss is the first of a new run of tries.
    await vi.advanceTimersByTimeAsync(2_000);
    // From here on the upstream stays down: three attempts, then the client is told.
    outage.down = true;
    engine().events.onClosed("closed (1006)");
    await vi.advanceTimersByTimeAsync(400 + 800 + 1600);
    expect(engines).toHaveLength(5);
    // Each closed once: the one that dropped when it was replaced, the ones that never connected at once.
    expect(engines.map((made) => made.closedCount)).toEqual([1, 1, 1, 1, 1]);
    expect(client.of("error")).toHaveLength(1);
    expect(client.closed?.code).toBe(1011);
  });

  it("gives up on an upstream that comes up and goes at once, time after time", async () => {
    const { client, engines, engine } = await open("auto");
    // Up, and gone within the moment: a turn detector that is lost as soon as it is there does this.
    engine().events.onClosed("closed (1006)");
    await vi.advanceTimersByTimeAsync(400);
    engine().events.onClosed("closed (1006)");
    await vi.advanceTimersByTimeAsync(800);
    engine().events.onClosed("closed (1006)");
    await vi.advanceTimersByTimeAsync(1_600);
    expect(engines).toHaveLength(4);
    expect(client.closed).toBeUndefined();
    // The fourth loss in a row with no connection that held: no fifth connection is made.
    engine().events.onClosed("closed (1006)");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engines).toHaveLength(4);
    expect(client.of("error")).toHaveLength(1);
    expect(client.closed?.code).toBe(1011);
  });

  it("says the backend is unusable while it reconnects, whatever status a mute reports", async () => {
    const { client, provider, engine } = await open("auto");
    expect(provider.upstreamUsable!()).toBe(true);
    engine().events.onClosed("closed (1006)");
    expect(provider.upstreamUsable!()).toBe(false);
    await provider.stopAudio();
    // The mute still reports "ready"; Max Cloud's billed clock goes by upstreamUsable.
    expect(client.statuses().at(-1)).toBe("ready");
    expect(provider.upstreamUsable!()).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(provider.upstreamUsable!()).toBe(true);
    await provider.close();
    expect(provider.upstreamUsable!()).toBe(false);
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

describe("speed from the phone", () => {
  // No backend measures speed: the phone's GPS, sent with its position, is the only source.
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reaches the client's ride context and the model's safety rule", async () => {
    const { client, provider, engine } = await open("manual-capable");
    expect(client.of("ride.context").at(-1)).not.toHaveProperty("speedKmh");
    await provider.updateLocation!(31.23, 121.47, 72.4);
    expect(client.of("ride.context").at(-1)).toMatchObject({ speedKmh: 72 });
    expect(engine().instructions.at(-1)).toContain("估计速度：72 km/h");
    expect(engine().instructions.at(-1)).toContain("高速/较快移动");
  });

  it("is unknown again when a position arrives without it", async () => {
    const { client, provider, engine } = await open("manual-capable");
    await provider.updateLocation!(31.23, 121.47, 72);
    await provider.updateLocation!(31.24, 121.48);
    expect(client.of("ride.context").at(-1)).not.toHaveProperty("speedKmh");
    expect(engine().instructions.at(-1)).not.toContain("估计速度");
  });

  it("does not repeat the ride context while the speed holds", async () => {
    const { client, provider } = await open("manual-capable");
    await provider.updateLocation!(31.23, 121.47, 40.2);
    const sent = client.of("ride.context").length;
    await provider.updateLocation!(31.231, 121.471, 39.8);
    expect(client.of("ride.context")).toHaveLength(sent);
  });
});
