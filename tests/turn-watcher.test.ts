/* eslint-disable @typescript-eslint/no-explicit-any -- upstream wire payloads are inspected structurally */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../server/logger";
import type { EngineConfig, EngineEvents } from "../server/providers/live/engine";
import { createGeminiLiveEngine } from "../server/providers/live/gemini-live";
import {
  createRealtimeEngine,
  grokDialect,
  localRealtimeDialect,
  openAiDialect
} from "../server/providers/live/openai-realtime";
import { turnSettingProblems } from "../server/providers/live/turn-settings";
import {
  createMaxSpeechTurnWatcher,
  createTurnTaking,
  turnDetectorSettings,
  type TurnTaking,
  type TurnTakingHooks,
  type TurnWatcher,
  type TurnWatcherEvents
} from "../server/providers/live/turn-watcher";

const log = createLogger("test");

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  terminated = false;
  pings = 0;
  /** A server that has stopped answering without closing. */
  deaf = false;
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  on(event: string, handler: (...args: unknown[]) => void) {
    (this.handlers[event] ??= []).push(handler);
    return this;
  }
  send(data: string | Buffer) {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  }
  close() {
    this.readyState = 3;
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
  ping() {
    this.pings += 1;
    if (!this.deaf) this.emit("pong");
  }
  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers[event] ?? []) handler(...args);
  }
  receive(payload: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(payload)), false);
  }
  json() {
    return this.sent.filter((item) => !Buffer.isBuffer(item));
  }
  ofType(type: string) {
    return this.json().filter((event) => event.type === type);
  }
}

const reader =
  (values: Record<string, string>) =>
  (...names: string[]) =>
    names.map((name) => values[name]).find((value) => value !== undefined);

/** `ms` of 16 kHz PCM16, every sample the same so pieces can be told apart. */
const audio = (ms: number, value = 1) => Buffer.alloc(ms * 32, value);

describe("turn detector settings", () => {
  it("is off unless asked for", () => {
    expect(turnDetectorSettings(reader({}))).toEqual({ problems: [] });
    expect(turnDetectorSettings(reader({ TURN_DETECTOR: "off" }))).toEqual({ problems: [] });
    // Max Speech being there for something else does not turn it on.
    expect(turnDetectorSettings(reader({ MAX_SPEECH_URL: "http://speech:8790" })).watcher).toBeUndefined();
  });

  it("uses the Max Speech server the relay already knows, or one of its own", () => {
    expect(turnDetectorSettings(reader({ TURN_DETECTOR: "max-speech" }))).toEqual({
      watcher: { url: "ws://localhost:8790/v1/speech/session", apiKey: "", eagerness: undefined },
      problems: []
    });
    expect(
      turnDetectorSettings(
        reader({
          TURN_DETECTOR: "Max_Speech",
          MAX_SPEECH_URL: "https://speech.example.com",
          MAX_SPEECH_API_KEY: "k1",
          TURN_DETECTOR_EAGERNESS: "HIGH"
        })
      ).watcher
    ).toEqual({ url: "wss://speech.example.com/v1/speech/session", apiKey: "k1", eagerness: "high" });
    expect(
      turnDetectorSettings(
        reader({
          TURN_DETECTOR: "max-speech",
          MAX_SPEECH_URL: "https://speech.example.com",
          MAX_SPEECH_API_KEY: "k1",
          TURN_DETECTOR_URL: "http://10.0.0.5:8790",
          TURN_DETECTOR_API_KEY: "k2"
        })
      ).watcher
    ).toMatchObject({ url: "ws://10.0.0.5:8790/v1/speech/session", apiKey: "k2" });
    // The key of the relay's Max Speech server is for that server: another address is not sent it.
    expect(
      turnDetectorSettings(
        reader({
          TURN_DETECTOR: "max-speech",
          MAX_SPEECH_URL: "https://speech.example.com",
          MAX_SPEECH_API_KEY: "k1",
          TURN_DETECTOR_URL: "http://10.0.0.5:8790"
        })
      ).watcher
    ).toMatchObject({ url: "ws://10.0.0.5:8790/v1/speech/session", apiKey: "" });
  });

  it("says what it could not use, at startup", () => {
    expect(turnDetectorSettings(reader({ TURN_DETECTOR: "magic" }))).toEqual({
      problems: ["TURN_DETECTOR=magic is not one of max-speech, off"]
    });
    const eager = turnDetectorSettings(reader({ TURN_DETECTOR: "max-speech", TURN_DETECTOR_EAGERNESS: "soon" }));
    expect(eager.watcher).toBeDefined();
    expect(eager.problems).toEqual(["TURN_DETECTOR_EAGERNESS=soon is not one of low, normal, high"]);
    const bad = turnDetectorSettings(reader({ TURN_DETECTOR: "max-speech", TURN_DETECTOR_URL: "not a url" }));
    expect(bad.watcher).toBeUndefined();
    expect(bad.problems[0]).toMatch(/^TURN_DETECTOR: /);
    expect(turnSettingProblems(reader({ TURN_DETECTOR: "magic" }))).toContain(
      "TURN_DETECTOR=magic is not one of max-speech, off"
    );
  });
});

describe("the Max Speech turn watcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function watch(settings: { apiKey?: string; eagerness?: "low" | "normal" | "high" } = {}) {
    const socket = new FakeSocket();
    const made: Array<{ url: string; headers: Record<string, string> }> = [];
    const watcher = createMaxSpeechTurnWatcher(
      log,
      { url: "ws://speech/v1/speech/session", apiKey: settings.apiKey ?? "", eagerness: settings.eagerness },
      (url, headers) => {
        made.push({ url, headers });
        return socket as never;
      }
    );
    const seen: string[] = [];
    const events: TurnWatcherEvents = {
      onSpeechStarted: () => seen.push("start"),
      onTurnEnded: (heard) => seen.push(heard ? "end" : "end without words"),
      onLost: (reason) => seen.push(`lost ${reason}`)
    };
    return { socket, made, watcher, seen, events };
  }

  async function ready(settings?: Parameters<typeof watch>[0], hello: Record<string, unknown> = {}) {
    const made = watch(settings);
    const connected = made.watcher.connect(["en", "zh"], made.events);
    made.socket.emit("open");
    made.socket.receive({ type: "ready", protocol: "max-speech.session.v1", ...hello });
    await connected;
    return made;
  }

  it("opens a session that only listens, and says where turns begin and end", async () => {
    const { socket, made, watcher, seen } = await ready({ apiKey: "secret", eagerness: "low" });
    expect(made).toEqual([{ url: "ws://speech/v1/speech/session", headers: { Authorization: "Bearer secret" } }]);
    expect(socket.json()).toEqual([{ type: "session.update", languages: ["en", "zh"], turn: { eagerness: "low" } }]);
    watcher.sendAudio(audio(20));
    expect(Buffer.isBuffer(socket.sent.at(-1))).toBe(true);
    socket.receive({ type: "speech.started" });
    // What the server heard is not what the relay is here for.
    socket.receive({ type: "transcript.partial", text: "hello" });
    socket.receive({ type: "transcript.final", text: "hello there", ms: { turn: 240 } });
    expect(seen).toEqual(["start", "end"]);
    // A turn in which the server made out no words is said to be one.
    socket.receive({ type: "speech.started" });
    socket.receive({ type: "transcript.final", text: " ", ms: { turn: 224 } });
    expect(seen.splice(2)).toEqual(["start", "end without words"]);
    // Nothing is ever said through it.
    expect(socket.ofType("speak")).toEqual([]);
    watcher.endInput();
    expect(socket.json().at(-1)).toEqual({ type: "turn.end" });
    watcher.close();
    expect(socket.readyState).toBe(3);
    // Closed by the relay: nothing was lost.
    socket.emit("close", 1000, Buffer.alloc(0));
    expect(seen).toEqual(["start", "end"]);
  });

  it("sends no key when there is none, and no eagerness when none was chosen", async () => {
    const { socket, made } = await ready();
    expect(made[0]!.headers).toEqual({});
    expect(socket.json()).toEqual([{ type: "session.update", languages: ["en", "zh"] }]);
  });

  it("ends the open turn when the server dropped audio and began again", async () => {
    const { socket, seen } = await ready();
    socket.receive({ type: "speech.started" });
    socket.receive({ type: "error", code: "overrun", message: "audio was dropped" });
    expect(seen).toEqual(["start", "end"]);
    // Other errors are the server's business.
    socket.receive({ type: "error", code: "bad_message", message: "?" });
    expect(seen).toEqual(["start", "end"]);
  });

  it("says so when the server goes away, once", async () => {
    const { socket, watcher, seen } = await ready();
    socket.emit("close", 1011, Buffer.from("restarting"));
    expect(seen).toEqual(["lost closed (1011 restarting)"]);
    // Nothing more goes to a server that is gone.
    const before = socket.sent.length;
    watcher.sendAudio(audio(20));
    watcher.endInput();
    expect(socket.sent).toHaveLength(before);
  });

  it("believes a server that says why a turn ended: only a blip was no speech", async () => {
    const { socket, seen } = await ready();
    const turn = (final: Record<string, unknown>) => {
      socket.receive({ type: "speech.started" });
      socket.receive({ type: "transcript.final", ...final });
      return seen.splice(0).at(-1);
    };
    expect(turn({ text: "", reason: "blip" })).toBe("end without words");
    // Somebody spoke, and the detector's own transcriber made nothing of it: another language, a short "yes".
    expect(turn({ text: "", reason: "turn" })).toBe("end");
    expect(turn({ text: "", reason: "max_wait" })).toBe("end");
    expect(turn({ text: "", reason: "dropped" })).toBe("end");
    expect(turn({ text: "ok", reason: "blip" })).toBe("end");
    // An older server gives no reason: its words are all there is to go by.
    expect(turn({ text: "" })).toBe("end without words");
    expect(turn({ text: "", reason: 7 })).toBe("end without words");
  });

  it("asks a quiet server whether it is still there, and lets go of one that is not", async () => {
    const { socket, seen } = await ready();
    await vi.advanceTimersByTimeAsync(60_000);
    // Answered every time: nothing is lost in a minute of silence.
    expect(socket.pings).toBe(12);
    expect(socket.terminated).toBe(false);
    // The machine it runs on went to sleep: the connection is still open, and nothing comes back.
    socket.deaf = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.terminated).toBe(true);
    // The close that follows is what the engine hears of it.
    socket.emit("close", 1006, Buffer.alloc(0));
    expect(seen).toEqual(["lost closed (1006)"]);
    const pings = socket.pings;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.pings).toBe(pings);
  });

  it("takes anything the server sends as a sign of life", async () => {
    const { socket } = await ready();
    socket.deaf = true;
    for (let second = 0; second < 40; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      socket.receive({ type: "transcript.partial", text: "…" });
    }
    expect(socket.terminated).toBe(false);
  });

  it("does not send audio to a server that is behind", async () => {
    const { socket, watcher } = await ready();
    socket.bufferedAmount = 2_000_000;
    const before = socket.sent.length;
    watcher.sendAudio(audio(20));
    expect(socket.sent).toHaveLength(before);
  });

  it("keeps a session alive on a server that closes quiet ones, while the microphone is off", async () => {
    const { socket, watcher } = await ready({}, { idle_timeout_s: 30 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.json().at(-1)).toEqual({ type: "session.update" });
    const sent = socket.json().length;
    // With audio flowing there is nothing to add.
    watcher.sendAudio(audio(20));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.json()).toHaveLength(sent);
    watcher.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.json()).toHaveLength(sent);
  });

  it("gives up on a server that is not there, does not answer, or refuses", async () => {
    const silent = watch();
    const waiting = silent.watcher.connect(["en"], silent.events);
    const refusal = expect(waiting).rejects.toThrow("no answer from ws://speech/v1/speech/session within 4 seconds");
    await vi.advanceTimersByTimeAsync(4_000);
    await refusal;
    expect(silent.socket.terminated).toBe(true);

    const down = watch();
    const failing = down.watcher.connect(["en"], down.events);
    down.socket.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:8790"));
    await expect(failing).rejects.toThrow("ECONNREFUSED");

    const busy = watch();
    const full = busy.watcher.connect(["en"], busy.events);
    busy.socket.emit("open");
    busy.socket.receive({ type: "error", code: "busy", message: "too many live sessions" });
    busy.socket.emit("close", 1013, Buffer.alloc(0));
    await expect(full).rejects.toThrow("closed (1013): busy: too many live sessions");
    // Never ready, so never lost.
    expect(busy.seen).toEqual([]);

    const locked = watch();
    const denied = locked.watcher.connect(["en"], locked.events);
    locked.socket.emit("unexpected-response", {}, { statusCode: 401 });
    await expect(denied).rejects.toThrow("answered HTTP 401");
  });
});

/** A detector the test drives by hand. */
function handWatcher(options: { fail?: string } = {}) {
  let events: TurnWatcherEvents | undefined;
  const heard: Buffer[] = [];
  const state = { closed: 0, endInputs: 0, connects: [] as string[][] };
  const watcher: TurnWatcher = {
    async connect(languages, watcherEvents) {
      state.connects.push(languages);
      if (options.fail) throw new Error(options.fail);
      events = watcherEvents;
    },
    sendAudio: (pcm) => void heard.push(pcm),
    endInput: () => void (state.endInputs += 1),
    close: () => void (state.closed += 1)
  };
  return {
    watcher,
    heard,
    state,
    start: () => events!.onSpeechStarted(),
    end: (heard = true) => events!.onTurnEnded(heard),
    lose: (reason = "closed (1006)") => events!.onLost(reason)
  };
}

describe("turn taking", () => {
  function taking(hand: ReturnType<typeof handWatcher> | undefined) {
    const seen: Array<string | Buffer> = [];
    const hooks: TurnTakingHooks = {
      forward: (pcm) => seen.push(pcm),
      onStart: () => seen.push("start"),
      onEnd: () => seen.push("end"),
      onAbandon: () => seen.push("abandon"),
      onLost: (reason) => seen.push(`lost ${reason}`)
    };
    const turns = createTurnTaking(log, hooks, () => hand?.watcher);
    return { turns, seen };
  }

  it("lets everything through when no detector is set up", async () => {
    const { turns, seen } = taking(undefined);
    expect(turns.wanted).toBe(false);
    expect(await turns.connect(["en"])).toBe(false);
    const piece = audio(20);
    turns.audio(piece);
    turns.endInput();
    expect(seen).toEqual([piece]);
    turns.close();
  });

  it("gives the backend a turn's audio, with the moment before it, and nothing else", async () => {
    const hand = handWatcher();
    const { turns, seen } = taking(hand);
    expect(turns.wanted).toBe(true);
    expect(await turns.connect(["en", "zh"])).toBe(true);
    expect(turns.on).toBe(true);
    expect(hand.state.connects).toEqual([["en", "zh"]]);
    // Two seconds of a quiet room: the detector hears all of it, the backend none.
    const quiet = Array.from({ length: 100 }, (_, index) => audio(20, index));
    for (const piece of quiet) turns.audio(piece);
    expect(hand.heard).toHaveLength(100);
    expect(seen).toEqual([]);
    hand.start();
    // The turn opens, then the last 600 ms from before the detector noticed.
    expect(seen[0]).toBe("start");
    expect(seen.slice(1)).toEqual(quiet.slice(-30));
    const word = audio(20, 200);
    turns.audio(word);
    expect(seen.at(-1)).toBe(word);
    hand.end();
    expect(seen.at(-1)).toBe("end");
    const after = seen.length;
    turns.audio(audio(20, 201));
    expect(seen).toHaveLength(after);
    // The next turn does not bring the last one's audio back.
    hand.start();
    expect(seen.slice(after)).toEqual(["start", audio(20, 201)]);
    turns.close();
    expect(hand.state.closed).toBe(1);
  });

  it("is not confused by a start or an end said twice", async () => {
    const hand = handWatcher();
    const { turns, seen } = taking(hand);
    await turns.connect(["en"]);
    hand.end();
    hand.start();
    hand.start();
    hand.end();
    hand.end();
    expect(seen).toEqual(["start", "end"]);
    turns.endInput();
    expect(hand.state.endInputs).toBe(1);
  });

  describe("a turn in which no words were heard", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("goes on when speech follows at once: it was the first sound of what the user says", async () => {
      const hand = handWatcher();
      const { turns, seen } = taking(hand);
      await turns.connect(["en"]);
      hand.start();
      hand.end(false);
      const during = audio(20, 7);
      turns.audio(during);
      // Still the same turn: the backend goes on getting its audio.
      expect(seen).toEqual(["start", during]);
      await vi.advanceTimersByTimeAsync(1_000);
      hand.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(seen).toEqual(["start", during]);
      hand.end();
      expect(seen).toEqual(["start", during, "end"]);
    });

    it("is given up when nothing follows: there is nothing to answer", async () => {
      const hand = handWatcher();
      const { turns, seen } = taking(hand);
      await turns.connect(["en"]);
      hand.start();
      hand.end(false);
      hand.end(false);
      await vi.advanceTimersByTimeAsync(1_199);
      expect(seen).toEqual(["start"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toEqual(["start", "abandon"]);
      const after = audio(20, 9);
      turns.audio(after);
      expect(seen).toEqual(["start", "abandon"]);
      // The next turn is a new one, with the moment before it.
      hand.start();
      expect(seen.slice(2)).toEqual(["start", after]);
      turns.close();
    });

    it("is not given up after the engine closed or the detector went", async () => {
      const closing = handWatcher();
      const first = taking(closing);
      await first.turns.connect(["en"]);
      closing.start();
      closing.end(false);
      first.turns.close();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(first.seen).toEqual(["start"]);

      const leaving = handWatcher();
      const second = taking(leaving);
      await second.turns.connect(["en"]);
      leaving.start();
      leaving.end(false);
      leaving.lose();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(second.seen).toEqual(["start", "end", "lost closed (1006)"]);
    });
  });

  it("uses the backend's own detection when the detector is not there", async () => {
    const hand = handWatcher({ fail: "connect ECONNREFUSED" });
    const { turns, seen } = taking(hand);
    expect(await turns.connect(["en"])).toBe(false);
    expect(turns.on).toBe(false);
    expect(hand.state.closed).toBe(1);
    const piece = audio(20);
    turns.audio(piece);
    expect(seen).toEqual([piece]);
    expect(hand.heard).toEqual([]);
  });

  it("says whether a turn is open", async () => {
    const hand = handWatcher();
    const { turns } = taking(hand);
    expect(turns.open).toBe(false);
    await turns.connect(["en"]);
    expect(turns.open).toBe(false);
    hand.start();
    expect(turns.open).toBe(true);
    hand.end();
    expect(turns.open).toBe(false);
    hand.start();
    turns.close();
    expect(turns.open).toBe(false);
  });

  it("ends a turn itself when the detector never says it is over", async () => {
    vi.useFakeTimers();
    try {
      const hand = handWatcher();
      const { turns, seen } = taking(hand);
      await turns.connect(["en"]);
      hand.start();
      vi.advanceTimersByTime(35_000);
      expect(seen).toEqual(["start"]);
      vi.advanceTimersByTime(1_000);
      expect(seen).toEqual(["start", "end"]);
      expect(turns.open).toBe(false);
      // What the detector says of that turn afterwards is about nothing.
      hand.end();
      hand.end(false);
      vi.advanceTimersByTime(5_000);
      expect(seen).toEqual(["start", "end"]);
      // A turn that ended in time leaves no clock running into the next.
      hand.start();
      vi.advanceTimersByTime(20_000);
      hand.end();
      hand.start();
      vi.advanceTimersByTime(20_000);
      expect(seen.slice(2)).toEqual(["start", "end", "start"]);
      turns.close();
      vi.advanceTimersByTime(60_000);
      expect(seen.slice(2)).toEqual(["start", "end", "start"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the open turn and says so when the detector goes away", async () => {
    const hand = handWatcher();
    const { turns, seen } = taking(hand);
    await turns.connect(["en"]);
    hand.start();
    hand.lose("closed (1011)");
    expect(seen).toEqual(["start", "end", "lost closed (1011)"]);
    expect(turns.on).toBe(false);
    // Said once.
    hand.lose();
    expect(seen).toHaveLength(3);
  });

  it("lets go of a detector that answered after the engine was closed", async () => {
    let answer!: () => void;
    const hand = handWatcher();
    const connect = hand.watcher.connect;
    hand.watcher.connect = async (languages, events) => {
      await new Promise<void>((resolve) => (answer = resolve));
      return connect(languages, events);
    };
    const { turns } = taking(hand);
    const connecting = turns.connect(["en"]);
    turns.close();
    answer();
    expect(await connecting).toBe(false);
    expect(turns.on).toBe(false);
    expect(hand.state.closed).toBeGreaterThanOrEqual(1);
  });
});

const CONFIG: EngineConfig = {
  instructions: "You are Max.",
  voiceGender: "female",
  manualResponse: false,
  languages: ["en"],
  keyterms: [],
  tools: []
};

function engineEvents() {
  const seen: Array<[string, ...unknown[]]> = [];
  const handlers: EngineEvents = {
    onSpeechStarted: () => seen.push(["speech"]),
    onRiderTranscript: (text, final) => seen.push(["rider", text, final]),
    onResponseStarted: () => seen.push(["response"]),
    onAgentText: (delta) => seen.push(["text", delta]),
    onAgentAudio: (pcm) => seen.push(["audio", pcm.length]),
    onResponseDone: (info) => seen.push(["done", info.cancelled]),
    onError: (message) => seen.push(["error", message]),
    onClosed: (reason) => seen.push(["closed", reason])
  };
  return { seen, handlers };
}

/** Turn taking over a hand-driven detector, as an engine is given it. */
function withDetector(hand: ReturnType<typeof handWatcher>) {
  let made: TurnTaking | undefined;
  const factory = (engineLog: typeof log, hooks: TurnTakingHooks) =>
    (made = createTurnTaking(engineLog, hooks, () => hand.watcher));
  return { factory, turns: () => made! };
}

const ENV_KEYS = ["OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "TURN_DETECTOR", "GEMINI_VAD_SILENCE_MS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("Gemini Live with the relay's turn detector", () => {
  async function gemini(hand: ReturnType<typeof handWatcher>, config: EngineConfig = CONFIG) {
    process.env.GEMINI_API_KEY = "k";
    const socket = new FakeSocket();
    const { seen, handlers } = engineEvents();
    const engine = createGeminiLiveEngine(log, () => socket as never, undefined, undefined, withDetector(hand).factory);
    const connected = engine.connect(config, handlers);
    // The detector answers first; then Gemini is opened.
    await vi.waitFor(() => expect(hand.state.connects).toHaveLength(1));
    await Promise.resolve();
    await Promise.resolve();
    socket.emit("open");
    socket.receive({ setupComplete: {} });
    await connected;
    return { socket, engine, seen };
  }

  const audioOf = (socket: FakeSocket) => socket.sent.filter((message) => message.realtimeInput?.audio);

  it("tells Gemini to detect nothing, and where each turn begins and ends", async () => {
    process.env.GEMINI_VAD_SILENCE_MS = "900";
    const hand = handWatcher();
    const { socket, engine, seen } = await gemini(hand);
    // Gemini's own settings for detection do not apply to a connection that has none.
    expect(socket.sent[0].setup.realtimeInputConfig).toEqual({ automaticActivityDetection: { disabled: true } });
    for (let index = 0; index < 50; index += 1) engine.sendAudio(audio(20, index));
    expect(hand.heard).toHaveLength(50);
    expect(audioOf(socket)).toEqual([]);
    hand.start();
    const sent = socket.sent.slice(1);
    expect(sent[0]).toEqual({ realtimeInput: { activityStart: {} } });
    // 600 ms from before, in order, after the start.
    expect(sent.slice(1)).toHaveLength(30);
    expect(sent[1].realtimeInput.audio).toEqual({
      data: audio(20, 20).toString("base64"),
      mimeType: "audio/pcm;rate=16000"
    });
    expect(seen).toEqual([["speech"]]);
    engine.sendAudio(audio(20, 99));
    expect(audioOf(socket)).toHaveLength(31);
    socket.receive({ serverContent: { inputTranscription: { text: "what time " } } });
    socket.receive({ serverContent: { inputTranscription: { text: "is it" } } });
    hand.end();
    expect(socket.sent.at(-1)).toEqual({ realtimeInput: { activityEnd: {} } });
    engine.sendAudio(audio(20, 100));
    expect(audioOf(socket)).toHaveLength(31);
    socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] } } });
    socket.receive({ serverContent: { turnComplete: true } });
    expect(seen).toEqual([
      ["speech"],
      ["rider", "what time ", false],
      ["rider", "what time is it", false],
      ["rider", "what time is it", true],
      ["response"],
      ["audio", 3],
      ["done", false]
    ]);
    engine.close();
    expect(hand.state.closed).toBe(1);
  });

  it("stops a reply the user speaks over, and takes nothing more of it for a new one", async () => {
    const hand = handWatcher();
    const { socket, seen } = await gemini(hand);
    hand.start();
    hand.end();
    socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] } } });
    hand.start();
    expect(seen.slice(-2)).toEqual([["speech"], ["done", true]]);
    // Still on its way from before Gemini heard of the new turn.
    socket.receive({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: "BBBB" } }] }, outputTranscription: { text: "…" } }
    });
    expect(seen.at(-1)).toEqual(["done", true]);
    // Gemini confirms: no second speech start, no second end of the reply.
    socket.receive({ serverContent: { interrupted: true } });
    expect(seen.filter(([kind]) => kind === "speech")).toHaveLength(2);
    expect(seen.filter(([kind]) => kind === "done")).toHaveLength(1);
    hand.end();
    socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "CCCC" } }] } } });
    expect(seen.slice(-2)).toEqual([["response"], ["audio", 3]]);
  });

  it("takes the next reply even when Gemini never confirmed the interruption", async () => {
    const hand = handWatcher();
    const { socket, seen } = await gemini(hand);
    hand.start();
    hand.end();
    socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] } } });
    hand.start();
    hand.end();
    socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "CCCC" } }] } } });
    expect(seen.slice(-2)).toEqual([["response"], ["audio", 3]]);
  });

  it("ends a turn that was only a noise, and tells the session nothing was said", async () => {
    const hand = handWatcher();
    const { socket, seen } = await gemini(hand);
    vi.useFakeTimers();
    try {
      hand.start();
      hand.end(false);
      expect(socket.sent.at(-1)).not.toEqual({ realtimeInput: { activityEnd: {} } });
      vi.advanceTimersByTime(1_200);
      expect(socket.sent.at(-1)).toEqual({ realtimeInput: { activityEnd: {} } });
      expect(seen).toEqual([["speech"], ["rider", "", true]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the turn when the microphone is let go", async () => {
    const hand = handWatcher();
    const { engine } = await gemini(hand);
    engine.endInput!();
    expect(hand.state.endInputs).toBe(1);
  });

  it("asks for a new connection when the detector goes away", async () => {
    const hand = handWatcher();
    const { socket, engine, seen } = await gemini(hand);
    hand.start();
    hand.lose("closed (1011)");
    // The open turn is ended for Gemini, then the session is told.
    expect(socket.sent.at(-1)).toEqual({ realtimeInput: { activityEnd: {} } });
    expect(seen.at(-1)).toEqual(["closed", "the turn detector went away (closed (1011))"]);
    expect(socket.readyState).toBe(3);
    // The socket's own close is not a second loss.
    socket.emit("close", 1000, Buffer.alloc(0));
    expect(seen.filter(([kind]) => kind === "closed")).toHaveLength(1);
    engine.close();
  });

  it("gives the detector back when Gemini drops the connection, and says so once", async () => {
    const hand = handWatcher();
    const { socket, engine, seen } = await gemini(hand);
    // Gemini ends a session every ten minutes or so.
    socket.emit("close", 1011, Buffer.from("deadline exceeded"));
    expect(seen).toEqual([["closed", "closed (1011 deadline exceeded)"]]);
    // Its place on the speech server is free at once, for the connection that takes over.
    expect(hand.state.closed).toBe(1);
    // An engine that is gone hears nothing and reports nothing more.
    const before = socket.sent.length;
    engine.sendAudio(audio(20));
    engine.sendText("hello?");
    expect(socket.sent).toHaveLength(before);
    engine.close();
    expect(seen).toHaveLength(1);
  });

  it("makes a turn of something typed, or of a line to say, which Gemini would otherwise never answer", async () => {
    const hand = handWatcher();
    const { socket, engine } = await gemini(hand);
    const since = (from: number) => socket.sent.slice(from);
    let from = socket.sent.length;
    engine.sendText("Where is my order?");
    expect(since(from)).toEqual([
      { realtimeInput: { activityStart: {} } },
      { realtimeInput: { text: "Where is my order?" } },
      { realtimeInput: { activityEnd: {} } }
    ]);
    from = socket.sent.length;
    engine.say!("Goodbye!");
    expect(since(from).map((message) => Object.keys(message.realtimeInput)[0])).toEqual([
      "activityStart",
      "text",
      "activityEnd"
    ]);
    // A picture with words: the picture is inside the turn its words make.
    from = socket.sent.length;
    engine.sendImage!({ data: "AAAA", mimeType: "image/jpeg" }, "What is this?");
    expect(since(from).map((message) => Object.keys(message.realtimeInput)[0])).toEqual([
      "activityStart",
      "video",
      "text",
      "activityEnd"
    ]);
    // A picture alone is no turn.
    from = socket.sent.length;
    engine.sendImage!({ data: "AAAA", mimeType: "image/jpeg" });
    expect(since(from)).toEqual([{ realtimeInput: { video: { data: "AAAA", mimeType: "image/jpeg" } } }]);
    // Typed while the user is speaking: it goes with the turn that is open, which ends when they stop.
    hand.start();
    from = socket.sent.length;
    engine.sendText("and gift wrap it");
    expect(since(from)).toEqual([{ realtimeInput: { text: "and gift wrap it" } }]);
    hand.end();
    expect(socket.sent.at(-1)).toEqual({ realtimeInput: { activityEnd: {} } });
  });

  it("sends typed text bare when Gemini detects turns itself", async () => {
    const hand = handWatcher({ fail: "connect ECONNREFUSED" });
    const { socket, engine } = await gemini(hand);
    const from = socket.sent.length;
    engine.sendText("Where is my order?");
    engine.say!("Goodbye!");
    expect(socket.sent.slice(from).every((message) => "text" in message.realtimeInput)).toBe(true);
    expect(socket.sent.slice(from)).toHaveLength(2);
  });

  it("does not run a tool the interrupted reply asked for", async () => {
    const hand = handWatcher();
    const { socket, seen } = await gemini(hand);
    hand.start();
    hand.end();
    socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] } } });
    hand.start();
    const before = seen.length;
    // Sent before Gemini heard of the new turn.
    socket.receive({ toolCall: { functionCalls: [{ id: "c1", name: "check_order", args: {} }] } });
    expect(seen).toHaveLength(before);
    expect(socket.sent.filter((message) => message.toolResponse)).toEqual([]);
    // The reply to the new turn may call tools as ever.
    hand.end();
    socket.receive({ toolCall: { functionCalls: [{ id: "c2", name: "check_order", args: {} }] } });
    expect(seen.at(-1)).toEqual(["response"]);
    expect(socket.sent.filter((message) => message.toolResponse)).toHaveLength(1);
  });

  it("asks for a new connection when the detector went away while Gemini was still connecting", async () => {
    process.env.GEMINI_API_KEY = "k";
    const hand = handWatcher();
    const socket = new FakeSocket();
    const { seen, handlers } = engineEvents();
    const engine = createGeminiLiveEngine(log, () => socket as never, undefined, undefined, withDetector(hand).factory);
    const connected = engine.connect(CONFIG, handlers);
    await vi.waitFor(() => expect(hand.state.connects).toHaveLength(1));
    await Promise.resolve();
    await Promise.resolve();
    socket.emit("open");
    // Gemini has been told to detect nothing, and now there is nobody to do it.
    expect(socket.sent[0].setup.realtimeInputConfig.automaticActivityDetection).toEqual({ disabled: true });
    hand.lose("closed (1012)");
    expect(seen).toEqual([]);
    socket.receive({ setupComplete: {} });
    await connected;
    // Once the session has this connection, it is told to make another.
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([["closed", "the turn detector went away (closed (1012))"]]);
    expect(socket.readyState).toBe(3);
  });

  it("says when the user's turn ended, for the clock", async () => {
    process.env.GEMINI_API_KEY = "k";
    const hand = handWatcher();
    const socket = new FakeSocket();
    const ended: string[] = [];
    const engine = createGeminiLiveEngine(log, () => socket as never, undefined, undefined, withDetector(hand).factory);
    const connected = engine.connect(CONFIG, { ...engineEvents().handlers, onSpeechEnded: () => ended.push("ended") });
    await vi.waitFor(() => expect(hand.state.connects).toHaveLength(1));
    await Promise.resolve();
    await Promise.resolve();
    socket.emit("open");
    socket.receive({ setupComplete: {} });
    await connected;
    hand.start();
    expect(ended).toEqual([]);
    hand.end();
    expect(ended).toEqual(["ended"]);
  });

  it("is Gemini as before when the detector is not there", async () => {
    process.env.GEMINI_VAD_SILENCE_MS = "900";
    const hand = handWatcher({ fail: "connect ECONNREFUSED" });
    const { socket, engine, seen } = await gemini(hand);
    expect(socket.sent[0].setup.realtimeInputConfig).toEqual({
      automaticActivityDetection: { silenceDurationMs: 900 }
    });
    engine.sendAudio(audio(20));
    expect(audioOf(socket)).toHaveLength(1);
    socket.receive({ serverContent: { inputTranscription: { text: "hello" } } });
    socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] } } });
    socket.receive({ serverContent: { interrupted: true } });
    expect(seen).toEqual([
      ["speech"],
      ["rider", "hello", false],
      ["rider", "hello", true],
      ["response"],
      ["audio", 3],
      ["speech"],
      ["done", true]
    ]);
  });

  it("waits for nothing when no detector is set up", async () => {
    process.env.GEMINI_API_KEY = "k";
    const socket = new FakeSocket();
    const engine = createGeminiLiveEngine(log, () => socket as never);
    const connected = engine.connect(CONFIG, engineEvents().handlers);
    // At once: no detector to ask first.
    socket.emit("open");
    expect(socket.sent[0].setup.realtimeInputConfig).toBeUndefined();
    socket.receive({ setupComplete: {} });
    await connected;
    engine.sendAudio(audio(20));
    expect(audioOf(socket)).toHaveLength(1);
  });
});

describe("OpenAI Realtime and Grok with the relay's turn detector", () => {
  async function realtime(
    dialect: ReturnType<typeof openAiDialect>,
    hand: ReturnType<typeof handWatcher>,
    config: EngineConfig = CONFIG
  ) {
    const socket = new FakeSocket();
    const { seen, handlers } = engineEvents();
    const engine = createRealtimeEngine(dialect, log, () => socket as never, withDetector(hand).factory);
    const connected = engine.connect(config, handlers);
    if (hand.state.connects.length || dialect.manualTurns) {
      await vi.waitFor(() => expect(hand.state.connects).toHaveLength(1));
      await Promise.resolve();
      await Promise.resolve();
    }
    socket.emit("open");
    socket.receive({ type: "session.updated" });
    await connected;
    return { socket, engine, seen };
  }

  it("switches OpenAI's detection off, and commits and answers each turn itself", async () => {
    process.env.OPENAI_API_KEY = "k";
    const hand = handWatcher();
    const { socket, engine, seen } = await realtime(openAiDialect(), hand);
    const session = socket.ofType("session.update")[0].session;
    expect(session.audio.input.turn_detection).toBeNull();
    // The rest of the session is what it always is.
    expect(session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24_000 });
    expect(session.audio.input.transcription.model).toBeTruthy();
    for (let index = 0; index < 50; index += 1) engine.sendAudio(audio(20, index));
    expect(socket.ofType("input_audio_buffer.append")).toEqual([]);
    hand.start();
    const sent = socket.json().slice(1);
    expect(sent[0]).toEqual({ type: "input_audio_buffer.clear" });
    expect(sent.slice(1).map((event) => event.type)).toEqual(Array(30).fill("input_audio_buffer.append"));
    expect(seen).toEqual([["speech"]]);
    // OpenAI's own notice of the same speech, were it to come, opens no second turn.
    socket.receive({ type: "input_audio_buffer.speech_started" });
    expect(seen).toEqual([["speech"]]);
    hand.end();
    expect(socket.json().slice(-2)).toEqual([{ type: "input_audio_buffer.commit" }, { type: "response.create" }]);
    engine.sendAudio(audio(20));
    expect(socket.ofType("input_audio_buffer.append")).toHaveLength(30);
  });

  it("stops the reply under way when the user speaks, once", async () => {
    process.env.OPENAI_API_KEY = "k";
    const hand = handWatcher();
    const { socket, engine } = await realtime(openAiDialect(), hand);
    hand.start();
    hand.end();
    socket.receive({ type: "response.created" });
    hand.start();
    // The session stops it too when the user was already hearing it.
    engine.cancel();
    expect(socket.ofType("response.cancel")).toHaveLength(1);
    // The turn that ends before the old reply is gone waits for it.
    hand.end();
    expect(socket.ofType("response.create")).toHaveLength(1);
    socket.receive({ type: "response.done", response: { status: "cancelled" } });
    expect(socket.ofType("response.create")).toHaveLength(2);
    // A later reply can be stopped again.
    socket.receive({ type: "response.created" });
    engine.cancel();
    expect(socket.ofType("response.cancel")).toHaveLength(2);
  });

  it("forgets a turn that was only a noise: nothing is committed and nothing answered", async () => {
    process.env.OPENAI_API_KEY = "k";
    const hand = handWatcher();
    const { socket, seen } = await realtime(openAiDialect(), hand);
    vi.useFakeTimers();
    try {
      hand.start();
      hand.end(false);
      vi.advanceTimersByTime(1_200);
      expect(socket.json().at(-1)).toEqual({ type: "input_audio_buffer.clear" });
      expect(socket.ofType("input_audio_buffer.commit")).toEqual([]);
      expect(socket.ofType("response.create")).toEqual([]);
      expect(seen).toEqual([["speech"], ["rider", "", true]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the answer to the session when replies wait for the wake word", async () => {
    process.env.OPENAI_API_KEY = "k";
    const hand = handWatcher();
    const { socket, engine } = await realtime(openAiDialect(), hand, { ...CONFIG, manualResponse: true });
    hand.start();
    hand.end();
    expect(socket.json().at(-1)).toEqual({ type: "input_audio_buffer.commit" });
    expect(socket.ofType("response.create")).toEqual([]);
    engine.respond();
    expect(socket.ofType("response.create")).toHaveLength(1);
  });

  it("does the same for Grok, in xAI's words", async () => {
    process.env.XAI_API_KEY = "k";
    const hand = handWatcher();
    const { socket } = await realtime(grokDialect(), hand);
    expect(socket.ofType("session.update")[0].session.turn_detection).toEqual({ type: null });
    hand.start();
    hand.end();
    expect(socket.json().slice(-2)).toEqual([{ type: "input_audio_buffer.commit" }, { type: "response.create" }]);
  });

  it("asks for a new connection when the detector goes away", async () => {
    process.env.OPENAI_API_KEY = "k";
    const hand = handWatcher();
    const { socket, seen } = await realtime(openAiDialect(), hand);
    hand.start();
    hand.lose();
    expect(socket.ofType("input_audio_buffer.commit")).toHaveLength(1);
    expect(seen.at(-1)).toEqual(["closed", "the turn detector went away (closed (1006))"]);
    expect(socket.readyState).toBe(3);
  });

  it("stops a reply that was asked for a moment before the user spoke again", async () => {
    process.env.OPENAI_API_KEY = "k";
    const hand = handWatcher();
    const { socket } = await realtime(openAiDialect(), hand);
    hand.start();
    hand.end();
    expect(socket.ofType("response.create")).toHaveLength(1);
    // "…and also": before OpenAI has said the reply began, so there is nothing to cancel yet.
    hand.start();
    expect(socket.ofType("response.cancel")).toEqual([]);
    socket.receive({ type: "response.created" });
    expect(socket.ofType("response.cancel")).toHaveLength(1);
    // The session stopping it too is not a second cancel.
    socket.receive({ type: "response.done", response: { status: "cancelled" } });
    expect(socket.ofType("response.create")).toHaveLength(1);
    hand.end();
    expect(socket.ofType("response.create")).toHaveLength(2);
    // The next reply is not cancelled for what happened to the last.
    socket.receive({ type: "response.created" });
    expect(socket.ofType("response.cancel")).toHaveLength(1);
  });

  it("forgets that cancel when the reply it was for was refused", async () => {
    process.env.OPENAI_API_KEY = "k";
    const hand = handWatcher();
    const { socket } = await realtime(openAiDialect(), hand);
    hand.start();
    hand.end();
    hand.start();
    socket.receive({ type: "error", error: { message: "conversation already has an active response" } });
    hand.end();
    socket.receive({ type: "response.created" });
    expect(socket.ofType("response.cancel")).toEqual([]);
  });

  it("still answers a turn that ended behind a reply the session cancelled", async () => {
    process.env.OPENAI_API_KEY = "k";
    const hand = handWatcher();
    const { socket, engine } = await realtime(openAiDialect(), hand);
    hand.start();
    hand.end();
    socket.receive({ type: "response.created" });
    // The user speaks and stops again while the first reply is still being cancelled.
    hand.start();
    hand.end();
    expect(socket.ofType("response.create")).toHaveLength(1);
    // The session, settling the first reply, cancels: that is about the reply, not the turn that waits.
    engine.cancel();
    socket.receive({ type: "response.done", response: { status: "cancelled" } });
    expect(socket.ofType("response.create")).toHaveLength(2);
    // With no turn waiting, a cancel still takes a queued reply with it.
    socket.receive({ type: "response.created" });
    engine.respond!();
    engine.cancel();
    socket.receive({ type: "response.done", response: { status: "cancelled" } });
    expect(socket.ofType("response.create")).toHaveLength(2);
  });

  it("gives the detector back when the upstream drops the connection", async () => {
    process.env.OPENAI_API_KEY = "k";
    const hand = handWatcher();
    const { socket, engine, seen } = await realtime(openAiDialect(), hand);
    socket.emit("close", 1001, Buffer.from("session expired"));
    expect(seen).toEqual([["closed", "closed (1001 session expired)"]]);
    expect(hand.state.closed).toBe(1);
    const before = socket.sent.length;
    engine.sendAudio(audio(20));
    expect(socket.sent).toHaveLength(before);
    engine.close();
    expect(seen).toHaveLength(1);
  });

  it("asks for a new connection when the detector went away while the upstream was still connecting", async () => {
    process.env.OPENAI_API_KEY = "k";
    const hand = handWatcher();
    const socket = new FakeSocket();
    const { seen, handlers } = engineEvents();
    const engine = createRealtimeEngine(openAiDialect(), log, () => socket as never, withDetector(hand).factory);
    const connected = engine.connect(CONFIG, handlers);
    await vi.waitFor(() => expect(hand.state.connects).toHaveLength(1));
    await Promise.resolve();
    await Promise.resolve();
    socket.emit("open");
    expect(socket.ofType("session.update")[0].session.audio.input.turn_detection).toBeNull();
    hand.lose("closed (1012)");
    expect(seen).toEqual([]);
    socket.receive({ type: "session.updated" });
    await connected;
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([["closed", "the turn detector went away (closed (1012))"]]);
    expect(socket.readyState).toBe(3);
  });

  it("says when the user's turn ended, for the clock: its own detector's word, or the upstream's", async () => {
    process.env.OPENAI_API_KEY = "k";
    const connect = async (hand: ReturnType<typeof handWatcher>) => {
      const socket = new FakeSocket();
      const ended: string[] = [];
      const engine = createRealtimeEngine(openAiDialect(), log, () => socket as never, withDetector(hand).factory);
      const connected = engine.connect(CONFIG, {
        ...engineEvents().handlers,
        onSpeechEnded: () => ended.push("ended")
      });
      await vi.waitFor(() => expect(hand.state.connects).toHaveLength(1));
      await Promise.resolve();
      await Promise.resolve();
      socket.emit("open");
      socket.receive({ type: "session.updated" });
      await connected;
      return { socket, ended };
    };
    // The relay takes the turns: the end is its detector's, and what the upstream thinks is not asked.
    const hand = handWatcher();
    const relay = await connect(hand);
    hand.start();
    relay.socket.receive({ type: "input_audio_buffer.speech_stopped" });
    expect(relay.ended).toEqual([]);
    hand.end();
    expect(relay.ended).toEqual(["ended"]);
    // A noise is no turn, and has no end to tell.
    vi.useFakeTimers();
    try {
      hand.start();
      hand.end(false);
      vi.advanceTimersByTime(1_200);
    } finally {
      vi.useRealTimers();
    }
    expect(relay.ended).toEqual(["ended"]);
    // The upstream takes the turns: it says so itself.
    const vendor = await connect(handWatcher({ fail: "connect ECONNREFUSED" }));
    vendor.socket.receive({ type: "input_audio_buffer.speech_started" });
    vendor.socket.receive({ type: "input_audio_buffer.speech_stopped" });
    expect(vendor.ended).toEqual(["ended"]);
  });

  it("is the backend as before when the detector is not there", async () => {
    process.env.OPENAI_API_KEY = "k";
    const hand = handWatcher({ fail: "connect ECONNREFUSED" });
    const { socket, engine, seen } = await realtime(openAiDialect(), hand);
    expect(socket.ofType("session.update")[0].session.audio.input.turn_detection).toMatchObject({
      type: "server_vad",
      create_response: true
    });
    engine.sendAudio(audio(20));
    expect(socket.ofType("input_audio_buffer.append")).toHaveLength(1);
    socket.receive({ type: "input_audio_buffer.speech_started" });
    expect(seen).toEqual([["speech"]]);
  });

  it("never asks a detector for a server that has no manual turns", async () => {
    const hand = handWatcher();
    const { socket, engine } = await realtime(localRealtimeDialect(), hand);
    expect(hand.state.connects).toEqual([]);
    expect(socket.ofType("session.update")[0].session.turn_detection).toMatchObject({ type: "server_vad" });
    engine.sendAudio(audio(20));
    expect(socket.ofType("input_audio_buffer.append")).toHaveLength(1);
  });
});
