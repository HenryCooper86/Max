import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioIO } from "../sdk/src/audio";
import type { ImageEncoder } from "../sdk/src/image";
import {
  VoiceAgent,
  VoiceAgentError,
  defineClientTool,
  type SocketEventMap,
  type VoiceAgentOptions,
  type WebSocketLike
} from "../sdk/src/client";
import { PROTOCOL_VERSION, SDK_VERSION } from "../sdk/src/version";
import type { WebRtcSocketOptions } from "../sdk/src/webrtc";

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "blob";
  sent: Array<string | ArrayBuffer> = [];
  closed: { code?: number } | undefined;
  private handlers: { [K in keyof SocketEventMap]?: Array<(event: SocketEventMap[K]) => void> } = {};

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void {
    (this.handlers[type] ??= []).push(listener);
  }
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.readyState = 3;
    this.closed = code === undefined ? {} : { code };
  }

  private fire<K extends keyof SocketEventMap>(type: K, event: SocketEventMap[K]) {
    for (const handler of this.handlers[type] ?? []) handler(event);
  }
  open() {
    this.readyState = 1;
    this.fire("open", {});
  }
  serverSends(message: object | ArrayBuffer) {
    this.fire("message", { data: message instanceof ArrayBuffer ? message : JSON.stringify(message) });
  }
  serverCloses(code: number, reason = "") {
    this.readyState = 3;
    this.fire("close", { code, reason });
  }
  /** Parsed JSON messages sent by the client. */
  json(): Array<Record<string, unknown>> {
    return this.sent
      .filter((m): m is string => typeof m === "string")
      .map((m) => JSON.parse(m) as Record<string, unknown>);
  }
  ofType(type: string) {
    return this.json().filter((m) => m.type === type);
  }
}

function fakeAudio() {
  let onFrame: ((pcm: ArrayBuffer) => void) | undefined;
  let setPlaying: (playing: boolean) => void = () => undefined;
  let setBlocked: (blocked: boolean) => void = () => undefined;
  let canResume = true;
  let micError: Error | undefined;
  const calls: string[] = [];
  const audio: AudioIO = {
    prepare: () => Promise.resolve(),
    startMic: (cb) => {
      calls.push("startMic");
      onFrame = cb;
      return micError ? Promise.reject(micError) : Promise.resolve();
    },
    setMicEnabled: (enabled) => void calls.push(`mic:${enabled}`),
    releaseMic: () => void calls.push("releaseMic"),
    playPcm16: () => void calls.push("play"),
    speak: (text) => void calls.push(`speak:${text}`),
    clearPlayback: () => void calls.push("clear"),
    levels: () => ({ mic: 0, output: 0 }),
    resume: () => {
      calls.push("resume");
      return Promise.resolve(canResume);
    },
    close: () => void calls.push("close")
  };
  const factory = (onPlayingChange: (playing: boolean) => void, onBlockedChange: (blocked: boolean) => void) => {
    setPlaying = onPlayingChange;
    setBlocked = onBlockedChange;
    return audio;
  };
  return {
    audio: factory,
    calls,
    frame: (pcm: ArrayBuffer) => onFrame?.(pcm),
    setPlaying: (p: boolean) => setPlaying(p),
    setBlocked: (b: boolean) => setBlocked(b),
    allowResume: (allowed: boolean) => (canResume = allowed),
    failMic: (error: Error) => (micError = error)
  };
}

const STARTED = { type: "session.started", provider: "mock", mode: "mock", capabilities: { tools: true } };

async function started(options: Partial<VoiceAgentOptions> = {}, startOptions?: { microphone?: boolean }) {
  const a = fakeAudio();
  const agent = new VoiceAgent({
    url: "https://relay.example.com",
    ...options,
    internals: { WebSocket: FakeSocket, audio: a.audio, toolTimeoutMs: 50, ...options.internals }
  });
  const promise = agent.start(startOptions);
  await vi.advanceTimersByTimeAsync(0);
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  socket.serverSends(STARTED);
  await promise;
  return { agent, socket, ...a };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceAgent session", () => {
  it("connects, sends session.start with serialized tools, then audio.start after session.started", async () => {
    const tool = defineClientTool({
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object" },
      handler: () => 1
    });
    const a = fakeAudio();
    const agent = new VoiceAgent({
      url: "https://relay.example.com",
      token: "vst_1",
      language: "en",
      context: "pricing page",
      tools: [tool],
      internals: { WebSocket: FakeSocket, audio: a.audio }
    });
    const start = agent.start();
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe("wss://relay.example.com/agent?token=vst_1");
    expect(socket.binaryType).toBe("arraybuffer");
    socket.open();
    expect(socket.json()).toHaveLength(1);
    expect(socket.json()[0]).toEqual({
      type: "session.start",
      sampleRate: 16000,
      channels: 1,
      platform: "web",
      protocol: PROTOCOL_VERSION,
      appVersion: `max-voice-agent@${SDK_VERSION}`,
      language: "en",
      tools: [{ name: "lookup", description: "Look something up", parameters: { type: "object" } }],
      context: "pricing page"
    });
    expect(socket.ofType("audio.start")).toHaveLength(0);
    socket.serverSends(STARTED);
    await start;
    expect(socket.ofType("audio.start")).toHaveLength(1);
    expect(agent.status).toBe("listening");
    expect(agent.backend).toBe("mock");
    expect(agent.capabilities).toEqual({ tools: true });
  });

  it("streams mic frames only while unmuted and ready", async () => {
    const { socket, frame, agent } = await started();
    frame(new ArrayBuffer(640));
    expect(socket.sent.filter((m) => m instanceof ArrayBuffer)).toHaveLength(1);
    agent.mute();
    expect(socket.ofType("audio.stop")).toHaveLength(1);
    frame(new ArrayBuffer(640));
    expect(socket.sent.filter((m) => m instanceof ArrayBuffer)).toHaveLength(1);
    agent.unmute();
    expect(socket.ofType("audio.start")).toHaveLength(2);
  });

  it("does not open the mic for a text-only session and sends typed text", async () => {
    const { agent, socket, calls } = await started({}, { microphone: false });
    expect(calls).not.toContain("startMic");
    expect(socket.ofType("audio.start")).toHaveLength(0);
    expect(agent.status).toBe("ready");
    expect(agent.sendText("  hello  ")).toBe(true);
    expect(agent.sendText("   ")).toBe(false);
    expect(socket.ofType("text.input")).toEqual([{ type: "text.input", text: "hello" }]);
  });

  it("refreshes a token function before every connect", async () => {
    const token = vi.fn().mockResolvedValueOnce("one").mockResolvedValueOnce("two");
    const { socket } = await started({ token });
    expect(socket.url).toContain("token=one");
    socket.serverCloses(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(token).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances[1]!.url).toContain("token=two");
  });

  it("rejects start() and reports an error when the token function fails", async () => {
    const a = fakeAudio();
    const agent = new VoiceAgent({
      url: "https://relay.example.com",
      token: () => Promise.reject(new Error("nope")),
      internals: { WebSocket: FakeSocket, audio: a.audio }
    });
    const errors: VoiceAgentError[] = [];
    agent.on("error", (e) => errors.push(e));
    await expect(agent.start()).rejects.toMatchObject({ code: "token" });
    expect(errors[0]?.code).toBe("token");
    expect(agent.status).toBe("error");
    expect(a.calls).toContain("releaseMic");
  });

  it("rejects invalid tool names at construction", () => {
    expect(
      () => new VoiceAgent({ url: "x", tools: [{ name: "bad name", description: "", handler: () => 0 }] })
    ).toThrow(TypeError);
    const dup = { name: "a", description: "", handler: () => 0 };
    expect(() => new VoiceAgent({ url: "x", tools: [dup, dup] })).toThrow(/Duplicate/);
  });
});

describe("status and barge-in", () => {
  it("tracks hearing and thinking, and clears playback when the user starts speaking", async () => {
    const { agent, socket, calls } = await started();
    const seen: string[] = [];
    agent.on("status", (s) => seen.push(s));
    socket.serverSends({ type: "status", state: "hearing", detail: "" });
    expect(agent.status).toBe("hearing");
    expect(calls).toContain("clear");
    socket.serverSends({ type: "status", state: "thinking", detail: "" });
    socket.serverSends({ type: "status", state: "listening", detail: "" });
    expect(seen).toEqual(["hearing", "thinking", "listening"]);
  });

  it("derives speaking from playback, not the server", async () => {
    const { agent, setPlaying, socket } = await started();
    socket.serverSends(new Uint8Array(480).buffer);
    setPlaying(true);
    expect(agent.status).toBe("speaking");
    socket.serverSends({ type: "status", state: "listening" });
    expect(agent.status).toBe("speaking");
    setPlaying(false);
    expect(agent.status).toBe("listening");
  });
});

describe("transcript", () => {
  it("merges by turn, emits message once when final, and namespaces turn ids per session", async () => {
    const { agent, socket } = await started();
    const messages: string[] = [];
    agent.on("message", (m) => messages.push(m.text));
    const turn = (text: string, final: boolean) =>
      socket.serverSends({ type: "transcript", turnId: "t1", deliveryId: "d1", speaker: "rider", text, final });
    turn("turn on", false);
    turn("turn on the lights", true);
    turn("turn on the lights", true);
    expect(agent.transcript).toHaveLength(1);
    expect(agent.transcript[0]).toMatchObject({ role: "user", text: "turn on the lights", final: true });
    expect(messages).toEqual(["turn on the lights"]);

    socket.serverCloses(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.instances[1]!;
    second.open();
    second.serverSends(STARTED);
    second.serverSends({
      type: "transcript",
      turnId: "t1",
      deliveryId: "d9",
      speaker: "agent",
      text: "again",
      final: true
    });
    expect(agent.transcript.map((i) => i.text)).toEqual(["turn on the lights", "again"]);
  });

  it("speaks final agent text only when the relay asks for browser speech, once per delivery", async () => {
    const { socket, calls } = await started();
    const say = (deliveryId: string, extra: object) =>
      socket.serverSends({
        type: "transcript",
        turnId: deliveryId,
        deliveryId,
        speaker: "agent",
        text: "hi",
        final: true,
        ...extra
      });
    say("a", {});
    say("b", { useBrowserSpeech: true });
    say("b", { useBrowserSpeech: true });
    expect(calls.filter((c) => c.startsWith("speak:"))).toEqual(["speak:hi"]);
  });

  it("honours speakFallback: false", async () => {
    const { socket, calls } = await started({ speakFallback: false });
    socket.serverSends({
      type: "transcript",
      turnId: "a",
      deliveryId: "a",
      speaker: "agent",
      text: "hi",
      useBrowserSpeech: true
    });
    expect(calls.some((c) => c.startsWith("speak:"))).toBe(false);
  });
});

describe("tool calls", () => {
  const call = (name: string, args: Record<string, unknown> = {}) => ({
    type: "tool.call",
    callId: "c1",
    name,
    arguments: args
  });

  it("runs a known tool and returns its output", async () => {
    const handler = vi.fn((args: Record<string, unknown>) => ({ got: args.x }));
    const { agent, socket } = await started({ tools: [{ name: "echo", description: "d", handler }] });
    const calls: string[] = [];
    agent.on("toolcall", (c) => calls.push(c.name));
    socket.serverSends(call("echo", { x: 7 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledWith({ x: 7 });
    expect(socket.ofType("tool.result")).toEqual([{ type: "tool.result", callId: "c1", output: { got: 7 } }]);
    expect(calls).toEqual(["echo"]);
  });

  it("declares a background tool as one, and gives its handler longer", async () => {
    const slow = () => new Promise((resolve) => setTimeout(() => resolve("made"), 60_000));
    const { socket } = await started({
      tools: [
        { name: "export_page", description: "d", background: true, handler: slow },
        { name: "quick", description: "d", handler: slow }
      ],
      internals: { toolTimeoutMs: undefined }
    });
    expect(socket.json()[0].tools).toEqual([
      { name: "export_page", description: "d", background: true },
      { name: "quick", description: "d" }
    ]);
    socket.serverSends(call("export_page"));
    socket.serverSends({ ...call("quick"), callId: "c2" });
    await vi.advanceTimersByTimeAsync(15_000);
    // The ordinary tool has run out of time; the background one is still at work.
    expect(socket.ofType("tool.result")).toEqual([{ type: "tool.result", callId: "c2", error: "timeout" }]);
    await vi.advanceTimersByTimeAsync(46_000);
    expect(socket.ofType("tool.result")[1]).toEqual({ type: "tool.result", callId: "c1", output: "made" });
  });

  it("awaits async handlers", async () => {
    const { socket } = await started({
      tools: [{ name: "slow", description: "d", handler: () => new Promise((r) => setTimeout(() => r("done"), 10)) }]
    });
    socket.serverSends(call("slow"));
    await vi.advanceTimersByTimeAsync(20);
    expect(socket.ofType("tool.result")).toEqual([{ type: "tool.result", callId: "c1", output: "done" }]);
  });

  it("answers an unknown tool with an error", async () => {
    const { socket } = await started();
    socket.serverSends(call("missing"));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.ofType("tool.result")).toEqual([{ type: "tool.result", callId: "c1", error: "unknown tool" }]);
  });

  it("reports thrown and rejected handler errors without crashing", async () => {
    const { socket } = await started({
      tools: [
        {
          name: "boom",
          description: "d",
          handler: () => {
            throw new Error("kaput");
          }
        },
        { name: "reject", description: "d", handler: () => Promise.reject(new Error("denied")) }
      ]
    });
    socket.serverSends(call("boom"));
    socket.serverSends({ ...call("reject"), callId: "c2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.ofType("tool.result")).toEqual([
      { type: "tool.result", callId: "c1", error: "kaput" },
      { type: "tool.result", callId: "c2", error: "denied" }
    ]);
  });

  it("times out a hung handler", async () => {
    const { socket } = await started({
      tools: [{ name: "hang", description: "d", handler: () => new Promise(() => undefined) }]
    });
    socket.serverSends(call("hang"));
    await vi.advanceTimersByTimeAsync(60);
    expect(socket.ofType("tool.result")).toEqual([{ type: "tool.result", callId: "c1", error: "timeout" }]);
  });

  it("omits output for handlers that return nothing and forwards tool.activity", async () => {
    const { agent, socket } = await started({ tools: [{ name: "void", description: "d", handler: () => undefined }] });
    const activity: string[] = [];
    agent.on("toolactivity", (a) => activity.push(a.state));
    socket.serverSends({ type: "tool.activity", callId: "c1", name: "void", where: "client", state: "started" });
    socket.serverSends(call("void"));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.ofType("tool.result")).toEqual([{ type: "tool.result", callId: "c1" }]);
    expect(activity).toEqual(["started"]);
  });
});

describe("reconnect", () => {
  it("does not reconnect after an idle close (4001) and releases the mic", async () => {
    const { agent, socket, calls } = await started();
    const closes: Array<{ code: number; willReconnect: boolean }> = [];
    agent.on("close", (c) => closes.push(c));
    socket.serverCloses(4001, "idle");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(agent.status).toBe("closed");
    expect(closes).toEqual([{ code: 4001, reason: "idle", willReconnect: false }]);
    expect(calls).toContain("releaseMic");
  });

  it("reconnects with backoff, re-sends session.start and audio.start, and gives up after 6 attempts", async () => {
    const { agent, socket } = await started();
    socket.serverCloses(1006);
    expect(agent.status).toBe("connecting");
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const second = FakeSocket.instances[1]!;
    second.open();
    expect(second.ofType("session.start")).toHaveLength(1);
    second.serverSends(STARTED);
    expect(second.ofType("audio.start")).toHaveLength(1);
    expect(agent.status).toBe("listening");

    const errors: string[] = [];
    agent.on("error", (e) => errors.push(e.code));
    let socketNow = second;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      socketNow.serverCloses(1006);
      await vi.advanceTimersByTimeAsync(8000);
      socketNow = FakeSocket.instances.at(-1)!;
      if (attempt < 6) expect(agent.status).toBe("connecting");
    }
    // The 6th retry socket drops too: no 7th attempt.
    socketNow.serverCloses(1006);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(agent.status).toBe("error");
    expect(errors).toContain("connection");
  });

  it("stays down when autoReconnect is false", async () => {
    const { agent, socket } = await started({ autoReconnect: false });
    socket.serverCloses(1006);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(agent.status).toBe("error");
  });

  it("stop() cancels a pending reconnect", async () => {
    const { agent, socket } = await started();
    socket.serverCloses(1006);
    agent.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(agent.status).toBe("idle");
  });

  it("rejects start() when the relay closes before the session starts", async () => {
    const a = fakeAudio();
    const agent = new VoiceAgent({
      url: "https://r.example.com",
      internals: { WebSocket: FakeSocket, audio: a.audio }
    });
    const start = agent.start();
    const assertion = expect(start).rejects.toBeInstanceOf(VoiceAgentError);
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.instances[0]!.serverCloses(1006);
    await assertion;
    expect(agent.status).toBe("error");
  });
});

describe("lifecycle", () => {
  it("setContext applies to the next session only", async () => {
    const { agent, socket } = await started({ context: "first" });
    agent.setContext("second");
    expect(socket.ofType("session.start")[0]?.context).toBe("first");
    socket.serverCloses(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.instances[1]!;
    next.open();
    expect(next.ofType("session.start")[0]?.context).toBe("second");
  });

  it("stop() closes the socket and destroy() silences listeners", async () => {
    const { agent, socket, calls } = await started();
    const statuses: string[] = [];
    agent.on("status", (s) => statuses.push(s));
    agent.stop();
    expect(socket.closed).toEqual({ code: 1000 });
    expect(agent.status).toBe("idle");
    expect(calls).toContain("releaseMic");
    agent.destroy();
    expect(calls).toContain("close");
    expect(statuses).toEqual(["idle", "closed"]);
    await expect(agent.start()).rejects.toThrow(/destroyed/);
  });

  it("a throwing listener does not break others", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { agent, socket } = await started();
    const seen: string[] = [];
    agent.on("status", () => {
      throw new Error("bad listener");
    });
    agent.on("status", (s) => seen.push(s));
    socket.serverSends({ type: "status", state: "thinking" });
    expect(seen).toEqual(["thinking"]);
    spy.mockRestore();
  });
});

/** Starts an agent and returns its first socket, before it has opened. */
async function connecting(options: Partial<VoiceAgentOptions> = {}) {
  const a = fakeAudio();
  const agent = new VoiceAgent({
    url: "https://relay.example.com",
    ...options,
    internals: { WebSocket: FakeSocket, audio: a.audio, ...options.internals }
  });
  const errors: VoiceAgentError[] = [];
  agent.on("error", (error) => errors.push(error));
  const start = agent.start();
  const rejection = start.then(
    () => undefined,
    (error: unknown) => error
  );
  await vi.advanceTimersByTimeAsync(0);
  return { agent, errors, rejection, ...a };
}

describe("close codes map to error codes", () => {
  it("reports 4003 before the session starts as usage_limit", async () => {
    const { agent, errors, rejection } = await connecting();
    FakeSocket.instances[0]!.serverCloses(4003);
    const error = (await rejection) as VoiceAgentError;
    expect(error).toBeInstanceOf(VoiceAgentError);
    expect(error.code).toBe("usage_limit");
    expect(error.closeCode).toBe(4003);
    expect(error.message).toBe("Voice minutes used up for this month");
    expect(errors.map((e) => e.code)).toEqual(["usage_limit"]);
    expect(agent.status).toBe("error");
  });

  it("reports 4003 after the session started as usage_limit, without reconnecting", async () => {
    const { agent, socket } = await started();
    const errors: string[] = [];
    agent.on("error", (e) => errors.push(e.code));
    socket.serverCloses(4003);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toEqual(["usage_limit"]);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("keeps connection for other closes, with the close code attached", async () => {
    const { rejection } = await connecting();
    FakeSocket.instances[0]!.serverCloses(1011);
    const error = (await rejection) as VoiceAgentError;
    expect(error.code).toBe("connection");
    expect(error.closeCode).toBe(1011);
  });

  it("stops at once on 1008 with a static token", async () => {
    const { rejection, errors } = await connecting({ token: "vst_static" });
    FakeSocket.instances[0]!.serverCloses(1008);
    expect(((await rejection) as VoiceAgentError).code).toBe("unauthorized");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(errors.map((e) => e.code)).toEqual(["unauthorized"]);
  });

  it("stops at once on 1008 without any token", async () => {
    const { rejection } = await connecting();
    FakeSocket.instances[0]!.serverCloses(1008);
    expect(((await rejection) as VoiceAgentError).code).toBe("unauthorized");
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("retries a refused first connect once with a fresh token, then reports unauthorized", async () => {
    const token = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    const { rejection, errors } = await connecting({ token });
    FakeSocket.instances[0]!.serverCloses(1008);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1]!.url).toContain("token=new");
    FakeSocket.instances[1]!.serverCloses(1008);
    expect(((await rejection) as VoiceAgentError).code).toBe("unauthorized");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(token).toHaveBeenCalledTimes(2);
    expect(errors.map((e) => e.code)).toEqual(["unauthorized"]);
  });

  it("lets the retried first connect succeed", async () => {
    const token = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    const { agent } = await connecting({ token });
    FakeSocket.instances[0]!.serverCloses(1008);
    await vi.advanceTimersByTimeAsync(0);
    const second = FakeSocket.instances[1]!;
    second.open();
    second.serverSends(STARTED);
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.status).toBe("listening");
  });

  it("retries a refused reconnect once with a fresh token, then stops with unauthorized", async () => {
    let n = 0;
    const token = vi.fn(() => Promise.resolve(`t${(n += 1)}`));
    const { agent, socket } = await started({ token });
    const errors: string[] = [];
    agent.on("error", (e) => errors.push(e.code));
    socket.serverCloses(1008);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1]!.url).toContain("token=t2");
    FakeSocket.instances[1]!.serverCloses(1008);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(errors).toEqual(["unauthorized"]);
    expect(agent.status).toBe("error");
  });

  it("grants a new retry after a session starts again", async () => {
    const token = vi.fn(() => Promise.resolve("t"));
    const { agent, socket } = await started({ token });
    socket.serverCloses(1008);
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.instances[1]!;
    second.open();
    second.serverSends(STARTED);
    second.serverCloses(1008);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(3);
    expect(agent.status).toBe("connecting");
  });

  it("does not retry 1008 when autoReconnect is off", async () => {
    const { agent, socket } = await started({ token: () => Promise.resolve("t"), autoReconnect: false });
    socket.serverCloses(1008);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(agent.status).toBe("error");
  });

  it("stops at once on 1008 mid-session with a static token", async () => {
    const { agent, socket } = await started({ token: "vst_static" });
    const errors: string[] = [];
    agent.on("error", (e) => errors.push(e.code));
    socket.serverCloses(1008);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(errors).toEqual(["unauthorized"]);
  });
});

describe("blocked audio", () => {
  it("emits a warning once, then audioresume, and exposes the state", async () => {
    const { agent, setBlocked } = await started();
    const seen: string[] = [];
    agent.on("warning", (w) => seen.push(w.code));
    agent.on("audioresume", () => seen.push("resume"));
    setBlocked(true);
    setBlocked(true);
    expect(agent.audioBlocked).toBe(true);
    setBlocked(false);
    expect(agent.audioBlocked).toBe(false);
    expect(seen).toEqual(["audio_blocked", "resume"]);
  });

  it("resumeAudio asks the audio layer and clears the warning when it runs", async () => {
    const { agent, setBlocked, calls, allowResume } = await started();
    setBlocked(true);
    allowResume(false);
    expect(await agent.resumeAudio()).toBe(false);
    expect(agent.audioBlocked).toBe(true);
    allowResume(true);
    expect(await agent.resumeAudio()).toBe(true);
    expect(agent.audioBlocked).toBe(false);
    expect(calls.filter((c) => c === "resume")).toHaveLength(2);
  });

  it("does not break listeners that only know the old events", async () => {
    const { agent, setBlocked } = await started();
    const statuses: string[] = [];
    agent.on("status", (s) => statuses.push(s));
    setBlocked(true);
    expect(statuses).toEqual([]);
  });
});

describe("microphone errors", () => {
  it("reports a refused microphone as code microphone, not connection", async () => {
    const a = fakeAudio();
    const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    a.failMic(denied);
    const agent = new VoiceAgent({
      url: "https://relay.example.com",
      internals: { WebSocket: FakeSocket, audio: a.audio }
    });
    const errors: VoiceAgentError[] = [];
    agent.on("error", (e) => errors.push(e));
    const start = agent.start();
    const rejection = start.then(
      () => undefined,
      (error: unknown) => error as VoiceAgentError
    );
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.instances[0]?.open();
    const error = await rejection;
    expect(error?.code).toBe("microphone");
    expect(error?.cause).toBe(denied);
    expect(errors.map((e) => e.code)).toEqual(["microphone"]);
    expect(agent.status).toBe("error");
  });
});

describe("protocol version", () => {
  async function startedWith(relay: Record<string, unknown>) {
    const a = fakeAudio();
    const agent = new VoiceAgent({
      url: "https://relay.example.com",
      internals: { WebSocket: FakeSocket, audio: a.audio, toolTimeoutMs: 50 }
    });
    const warnings: string[] = [];
    agent.on("warning", (w) => warnings.push(w.code));
    const promise = agent.start();
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeSocket.instances.at(-1)!;
    socket.open();
    socket.serverSends({ ...STARTED, ...relay });
    await promise;
    return { agent, socket, warnings };
  }

  it("sends the SDK's protocol and version in session.start", async () => {
    const { socket } = await started();
    expect(socket.ofType("session.start")[0]).toMatchObject({
      type: "session.start",
      protocol: PROTOCOL_VERSION,
      appVersion: `max-voice-agent@${SDK_VERSION}`
    });
  });

  it("says nothing to a relay on the same protocol, or one too old to say", async () => {
    expect((await startedWith({ protocol: PROTOCOL_VERSION })).warnings).toEqual([]);
    expect((await startedWith({})).warnings).toEqual([]);
  });

  it("warns once when the relay is ahead, and keeps the session", async () => {
    const { agent, socket, warnings } = await startedWith({ protocol: PROTOCOL_VERSION + 1 });
    expect(warnings).toEqual(["protocol_mismatch"]);
    expect(agent.status).not.toBe("idle");
    socket.serverSends({ ...STARTED, protocol: PROTOCOL_VERSION + 1 });
    expect(warnings).toEqual(["protocol_mismatch"]);
  });
});

describe("conversations the relay carries on or ends", () => {
  const RESUMABLE = { ...STARTED, resume: "rsm_abcdefghijklmnopqrstuvwxyz012345" };

  it("sends the resume id back when it reconnects, and not on a fresh start", async () => {
    const { agent, socket } = await started();
    expect(socket.ofType("session.start")[0]).not.toHaveProperty("resume");
    socket.serverSends(RESUMABLE);
    socket.serverCloses(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.instances[1]!;
    second.open();
    expect(second.ofType("session.start")[0]).toMatchObject({ resume: RESUMABLE.resume });
    second.serverSends(RESUMABLE);

    // stop() ends the conversation: the next start() begins a new one.
    agent.stop();
    const again = agent.start();
    await vi.advanceTimersByTimeAsync(0);
    const third = FakeSocket.instances[2]!;
    third.open();
    expect(third.ofType("session.start")[0]).not.toHaveProperty("resume");
    third.serverSends(STARTED);
    await again;
  });

  it("reports why the relay ended the conversation, lets the goodbye play and does not reconnect", async () => {
    const { agent, socket, calls } = await started();
    const ended: string[] = [];
    const closes: Array<{ code: number; willReconnect: boolean }> = [];
    agent.on("ended", (event) => ended.push(event.reason));
    agent.on("close", (event) => closes.push(event));
    calls.length = 0;
    socket.serverSends({ type: "session.ended", reason: "agent" });
    expect(ended).toEqual(["agent"]);
    expect(calls).toContain("releaseMic");
    // Even a plain 1000 from an older relay build must not start a new session.
    socket.serverCloses(1000, "agent");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(agent.status).toBe("closed");
    expect(closes[0]).toEqual({ code: 1000, reason: "agent", willReconnect: false });
    expect(calls).not.toContain("clear");
  });

  it("reports the agent a conversation was handed to", async () => {
    const { agent, socket } = await started();
    const agents: string[] = [];
    agent.on("agentchange", (event) => agents.push(event.agent));
    expect(agent.agent).toBeUndefined();
    socket.serverSends({ type: "agent.changed", agent: "billing" });
    expect(agents).toEqual(["billing"]);
    expect(agent.agent).toBe("billing");
    socket.serverSends({ type: "agent.changed" });
    expect(agents).toEqual(["billing"]);
    agent.stop();
    expect(agent.agent).toBeUndefined();
  });
});

describe("webrtc transport", () => {
  class FakeRtcSocket {
    static instances: FakeRtcSocket[] = [];
    readyState = 0;
    bufferedAmount = 0;
    binaryType = "blob";
    sent: Array<string | ArrayBuffer> = [];
    closed: { code?: number } | undefined;
    setMicrophone = vi.fn<(track: MediaStreamTrack | undefined) => void>();
    private handlers: { [K in keyof SocketEventMap]?: Array<(event: SocketEventMap[K]) => void> } = {};

    constructor(readonly options: WebRtcSocketOptions) {
      FakeRtcSocket.instances.push(this);
    }
    addEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void {
      (this.handlers[type] ??= []).push(listener);
    }
    send(data: string | ArrayBuffer): void {
      this.sent.push(data);
    }
    close(code?: number): void {
      this.readyState = 3;
      this.closed = code === undefined ? {} : { code };
    }
    private fire<K extends keyof SocketEventMap>(type: K, event: SocketEventMap[K]) {
      for (const handler of this.handlers[type] ?? []) handler(event);
    }
    open() {
      this.readyState = 1;
      this.fire("open", {});
    }
    serverSends(message: object) {
      this.fire("message", { data: JSON.stringify(message) });
    }
    serverCloses(code: number, reason = "") {
      this.readyState = 3;
      this.fire("close", { code, reason });
    }
    json(): Array<Record<string, unknown>> {
      return this.sent
        .filter((m): m is string => typeof m === "string")
        .map((m) => JSON.parse(m) as Record<string, unknown>);
    }
    ofType(type: string) {
      return this.json().filter((m) => m.type === type);
    }
  }

  const MIC_TRACK = { kind: "audio", id: "mic" } as unknown as MediaStreamTrack;
  const RESUMABLE = { ...STARTED, resume: "rsm_abcdefghijklmnopqrstuvwxyz012345" };
  const rtc = () => FakeRtcSocket.instances.at(-1)!;

  /** The fake audio, plus the stream methods and a microphone track that exists once startMic ran. */
  function rtcAudio() {
    const a = fakeAudio();
    const playStream = vi.fn();
    const stopStream = vi.fn();
    const clear = vi.fn();
    const audio = (onPlaying: (p: boolean) => void, onBlocked: (b: boolean) => void) => {
      const io = a.audio(onPlaying, onBlocked);
      io.playStream = playStream;
      io.stopStream = stopStream;
      io.micTrack = () => (a.calls.includes("startMic") ? MIC_TRACK : undefined);
      const clearPlayback = io.clearPlayback.bind(io);
      io.clearPlayback = () => {
        clear();
        clearPlayback();
      };
      return io;
    };
    return { ...a, audio, playStream, stopStream, clear };
  }

  function make(options: Partial<VoiceAgentOptions> = {}, webrtc = true) {
    const a = rtcAudio();
    const factory = vi.fn((o: WebRtcSocketOptions) => new FakeRtcSocket(o));
    const agent = new VoiceAgent({
      url: "https://relay.example.com/prefix",
      transport: "webrtc",
      ...options,
      internals: {
        WebSocket: FakeSocket,
        audio: a.audio,
        ...(webrtc ? { webrtc: factory } : {}),
        ...options.internals
      }
    });
    return { agent, factory, ...a };
  }

  async function startedRtc(options: Partial<VoiceAgentOptions> = {}, startOptions?: { microphone?: boolean }) {
    const made = make(options);
    const promise = made.agent.start(startOptions);
    await vi.advanceTimersByTimeAsync(0);
    const socket = rtc();
    socket.open();
    socket.serverSends(STARTED);
    await promise;
    return { ...made, socket };
  }

  beforeEach(() => {
    FakeRtcSocket.instances = [];
  });

  it("opens the WebRTC transport at the relay's /agent/webrtc URL with the resolved token", async () => {
    const { agent, factory } = make({ token: () => "tok_fn" });
    expect(agent.transport).toBeUndefined();
    const promise = agent.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]![0]).toMatchObject({
      url: "https://relay.example.com/prefix/agent/webrtc",
      token: "tok_fn"
    });
    expect(FakeSocket.instances).toHaveLength(0);
    rtc().open();
    rtc().serverSends(STARTED);
    await promise;
    expect(agent.transport).toBe("webrtc");
    expect(rtc().ofType("session.start")).toHaveLength(1);
    agent.stop();
    expect(agent.transport).toBeUndefined();
  });

  it("passes the ICE servers to the transport", async () => {
    const iceServers = [{ urls: "stun:stun.example.com" }];
    const { factory } = await startedRtc({ iceServers });
    expect(factory.mock.calls[0]![0].iceServers).toEqual(iceServers);
  });

  it("uses the WebSocket and never the WebRTC factory when no transport is asked for", async () => {
    const factory = vi.fn();
    const { agent } = await started({ internals: { webrtc: factory } });
    expect(factory).not.toHaveBeenCalled();
    expect(agent.transport).toBe("websocket");
  });

  it("falls back to the WebSocket with a warning when WebRTC reports it is unavailable", async () => {
    const tokens = vi.fn(() => "tok");
    const { agent, factory } = make({ token: tokens });
    const warnings: Array<{ code: string }> = [];
    agent.on("warning", (w) => warnings.push(w));
    const promise = agent.start();
    await vi.advanceTimersByTimeAsync(0);
    rtc().serverCloses(4990, "webrtc connect timeout");
    expect(warnings.map((w) => w.code)).toEqual(["webrtc_unavailable"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(tokens).toHaveBeenCalledTimes(2);
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe("wss://relay.example.com/prefix/agent?token=tok");
    socket.open();
    socket.serverSends(STARTED);
    await promise;
    expect(agent.transport).toBe("websocket");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("stays on the WebSocket for reconnects after a fallback, and tries WebRTC again on the next start()", async () => {
    const { agent, factory } = make();
    const promise = agent.start();
    await vi.advanceTimersByTimeAsync(0);
    rtc().serverCloses(4990);
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeSocket.instances[0]!;
    first.open();
    first.serverSends(STARTED);
    await promise;

    first.serverCloses(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(factory).toHaveBeenCalledTimes(1);
    FakeSocket.instances[1]!.open();
    FakeSocket.instances[1]!.serverSends(STARTED);

    agent.stop();
    const again = agent.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances).toHaveLength(2);
    rtc().open();
    rtc().serverSends(STARTED);
    await again;
    expect(agent.transport).toBe("webrtc");
  });

  it("reconnects over WebRTC after a drop, resuming the conversation", async () => {
    const { agent, factory, socket } = await startedRtc();
    socket.serverSends(RESUMABLE);
    socket.serverCloses(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(factory).toHaveBeenCalledTimes(2);
    const second = rtc();
    expect(second).not.toBe(socket);
    second.open();
    expect(second.ofType("session.start")[0]).toMatchObject({ resume: RESUMABLE.resume });
    second.serverSends(RESUMABLE);
    expect(agent.transport).toBe("webrtc");
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("rejects with unauthorized, without a fallback or warning, when WebRTC signalling is refused (1008)", async () => {
    const { agent } = make({ token: "vst_static" });
    const warnings: unknown[] = [];
    agent.on("warning", (w) => warnings.push(w));
    const rejection = agent.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    rtc().serverCloses(1008);
    const error = (await rejection) as VoiceAgentError;
    expect(error).toBeInstanceOf(VoiceAgentError);
    expect(error.code).toBe("unauthorized");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(FakeRtcSocket.instances).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("interrupt() silences playback and asks the relay to drop what it holds, over WebRTC only", async () => {
    const over = await startedRtc();
    over.agent.interrupt();
    expect(over.clear).toHaveBeenCalledTimes(1);
    expect(over.socket.ofType("transport.clear")).toHaveLength(1);

    const plain = await started();
    plain.calls.length = 0;
    plain.agent.interrupt();
    expect(plain.calls).toContain("clear");
    expect(plain.socket.ofType("transport.clear")).toEqual([]);
    expect(plain.socket.json().some((m) => String(m.type).startsWith("transport."))).toBe(false);
  });

  it("hands the open microphone's track to the socket", async () => {
    const { socket } = await startedRtc();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.setMicrophone).toHaveBeenCalledWith(MIC_TRACK);
  });

  it("hands no track to the socket when the microphone is off", async () => {
    const { socket } = await startedRtc({}, { microphone: false });
    await vi.advanceTimersByTimeAsync(0);
    for (const [track] of socket.setMicrophone.mock.calls) expect(track).toBeUndefined();
  });

  it("plays the agent's voice stream through the audio layer and stops it when the stream ends", async () => {
    const { factory, playStream, stopStream } = await startedRtc();
    const stream = {} as MediaStream;
    const { onStream, onStreamEnd } = factory.mock.calls[0]![0];
    onStream(stream);
    expect(playStream).toHaveBeenCalledWith(stream);
    onStreamEnd(stream);
    expect(stopStream).toHaveBeenCalledWith(stream);
  });

  it("offers microphone PCM frames to a WebRTC socket without trouble", async () => {
    const { socket, frame } = await startedRtc();
    expect(() => frame(new Int16Array(160).buffer)).not.toThrow();
    expect(socket.sent.filter((m) => m instanceof ArrayBuffer)).toHaveLength(1);
  });

  it("carries a picture as one JSON event, like text", async () => {
    const imageEncoder: ImageEncoder = async () => ({ width: 10, height: 10, encode: async () => "SkZJRg==" });
    const { agent, socket } = await startedRtc({ internals: { imageEncoder } });
    // `STARTED` reports no imageInput, so the relay is first told it may.
    socket.serverSends({ ...STARTED, capabilities: { imageInput: true } });
    expect(await agent.sendImage("data:image/png;base64,AAAA", { text: "what is this?" })).toBe(true);
    expect(socket.ofType("image.input")).toEqual([
      { type: "image.input", image: "SkZJRg==", mimeType: "image/jpeg", text: "what is this?" }
    ]);
  });
});

describe("sendImage", () => {
  const encoder =
    (log: Array<[unknown, number]> = []): ImageEncoder =>
    async (source) => ({
      width: 2000,
      height: 1000,
      async encode(width) {
        log.push([source, width]);
        return "SkZJRg==";
      }
    });

  async function startedWithImages(
    capabilities: Record<string, unknown> = { imageInput: true },
    log?: Array<[unknown, number]>
  ) {
    const made = await started({ internals: { imageEncoder: encoder(log) } });
    made.socket.serverSends({ ...STARTED, capabilities });
    return made;
  }

  it("sends one JPEG image.input with the trimmed words", async () => {
    const log: Array<[unknown, number]> = [];
    const { agent, socket } = await startedWithImages({ imageInput: true }, log);
    const source = "data:image/png;base64,AAAA";
    expect(await agent.sendImage(source, { text: "  what colour?  " })).toBe(true);
    expect(socket.ofType("image.input")).toEqual([
      { type: "image.input", image: "SkZJRg==", mimeType: "image/jpeg", text: "what colour?" }
    ]);
    // Scaled to the default 1024 on the longer side.
    expect(log).toEqual([[source, 1024]]);
  });

  it("omits blank words, and passes maxSide on", async () => {
    const log: Array<[unknown, number]> = [];
    const { agent, socket } = await startedWithImages({ imageInput: true }, log);
    expect(await agent.sendImage("data:x", { text: "   ", maxSide: 640 })).toBe(true);
    expect(socket.ofType("image.input")[0]).not.toHaveProperty("text");
    expect(log[0]![1]).toBe(640);
  });

  it("caps the words at the typed-turn limit", async () => {
    const { agent, socket } = await startedWithImages();
    await agent.sendImage("data:x", { text: "a".repeat(3000) });
    expect((socket.ofType("image.input")[0]!.text as string).length).toBe(2000);
  });

  it("returns false, and does no work, when the relay does not take pictures", async () => {
    const log: Array<[unknown, number]> = [];
    const { agent, socket } = await startedWithImages({ textInput: true }, log);
    expect(await agent.sendImage("data:x")).toBe(false);
    expect(socket.ofType("image.input")).toEqual([]);
    expect(log).toEqual([]);
  });

  it("returns false when there is no live session", async () => {
    const agent = new VoiceAgent({ url: "https://relay.example.com", internals: { imageEncoder: encoder() } });
    expect(await agent.sendImage("data:x")).toBe(false);
    const { agent: stopped } = await startedWithImages();
    stopped.stop();
    expect(await stopped.sendImage("data:x")).toBe(false);
  });

  it("returns false when the connection drops while the picture is being prepared", async () => {
    const { agent, socket } = await startedWithImages();
    const pending = agent.sendImage("data:x");
    socket.readyState = 3;
    expect(await pending).toBe(false);
    expect(socket.ofType("image.input")).toEqual([]);
  });

  /** An encoder that finishes when the test says so. */
  function slowEncoder() {
    const waiting: Array<() => void> = [];
    const encoder: ImageEncoder = async () => ({
      width: 10,
      height: 10,
      encode: () => new Promise<string>((resolve) => waiting.push(() => resolve("SkZJRg==")))
    });
    return { encoder, finish: () => waiting.splice(0).forEach((done) => done()) };
  }

  it("sends nothing when the session was replaced while the picture was prepared", async () => {
    const slow = slowEncoder();
    const { agent, socket } = await started({ internals: { imageEncoder: slow.encoder } });
    socket.serverSends({ ...STARTED, capabilities: { imageInput: true } });
    const pending = agent.sendImage("data:x");
    await vi.advanceTimersByTimeAsync(0);
    // A new session on the connection that does not take pictures.
    socket.serverSends({ ...STARTED, capabilities: { textInput: true } });
    slow.finish();
    expect(await pending).toBe(false);
    expect(socket.ofType("image.input")).toEqual([]);
  });

  it("sends nothing when a reconnect gave a new connection while the picture was prepared", async () => {
    const slow = slowEncoder();
    const { agent, socket } = await started({ internals: { imageEncoder: slow.encoder } });
    socket.serverSends({ ...STARTED, capabilities: { imageInput: true } });
    const pending = agent.sendImage("data:x");
    await vi.advanceTimersByTimeAsync(0);
    socket.serverCloses(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.instances.at(-1)!;
    expect(next).not.toBe(socket);
    next.open();
    next.serverSends({ ...STARTED, capabilities: { imageInput: true } });
    slow.finish();
    expect(await pending).toBe(false);
    expect(next.ofType("image.input")).toEqual([]);
  });

  it("answers false to a call made while another is encoding or within a second of the last one", async () => {
    const slow = slowEncoder();
    const { agent, socket } = await started({ internals: { imageEncoder: slow.encoder } });
    socket.serverSends({ ...STARTED, capabilities: { imageInput: true } });
    const first = agent.sendImage("data:x", { text: "one" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await agent.sendImage("data:x", { text: "two" })).toBe(false);
    slow.finish();
    expect(await first).toBe(true);

    await vi.advanceTimersByTimeAsync(999);
    expect(await agent.sendImage("data:x", { text: "three" })).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const fourth = agent.sendImage("data:x", { text: "four" });
    await vi.advanceTimersByTimeAsync(0);
    slow.finish();
    expect(await fourth).toBe(true);
    expect(socket.ofType("image.input").map((message) => message.text)).toEqual(["one", "four"]);
  });

  it("rejects with an image error when the picture cannot be prepared", async () => {
    const failing: ImageEncoder = async () => {
      throw new Error("the image does not fit");
    };
    const { agent, socket } = await started({ internals: { imageEncoder: failing } });
    socket.serverSends({ ...STARTED, capabilities: { imageInput: true } });
    await expect(agent.sendImage("data:x")).rejects.toMatchObject({
      name: "VoiceAgentError",
      code: "image",
      message: expect.stringContaining("does not fit")
    });
    expect(socket.ofType("image.input")).toEqual([]);
  });
});

describe("startVideo", () => {
  type FakeVideo = {
    opener: NonNullable<NonNullable<VoiceAgentOptions["internals"]>["video"]>;
    opened: Array<{ source: unknown; options: unknown }>;
    closed: number;
    /** What the next frame is read from; undefined: the video has no pixels yet. */
    showing: string | undefined;
    end(): void;
    fail?: Error;
  };

  function fakeVideo(): FakeVideo {
    const stream = { id: "stream" } as unknown as MediaStream;
    let ended: (() => void) | undefined;
    const video: FakeVideo = {
      opened: [],
      closed: 0,
      showing: "frame-1",
      end: () => ended?.(),
      opener: async (source, options) => {
        if (video.fail) throw video.fail;
        video.opened.push({ source, options });
        return {
          stream,
          frame: () => video.showing,
          onEnded: (listener) => void (ended = listener),
          close: () => void (video.closed += 1)
        };
      }
    };
    return video;
  }

  /** Encodes a frame to its own name, at the size and quality asked for. */
  const encoder =
    (log: Array<[unknown, number, number]> = []): ImageEncoder =>
    async (source) => ({
      width: 1280,
      height: 720,
      async encode(width, _height, quality) {
        log.push([source, width, quality]);
        return `JPEG(${String(source)})`;
      }
    });

  async function watching(capabilities: Record<string, unknown> = { imageInput: true, videoInput: true }) {
    const video = fakeVideo();
    const log: Array<[unknown, number, number]> = [];
    const made = await started({ internals: { video: video.opener, imageEncoder: encoder(log) } });
    made.socket.serverSends({ ...STARTED, capabilities });
    const events: unknown[] = [];
    made.agent.on("video", (event) => events.push(event));
    return { ...made, video, log, events };
  }

  it("opens the camera and sends a frame at once, then one a second, small and as JPEG", async () => {
    const { agent, socket, video, log, events } = await watching();
    const stream = await agent.startVideo();
    expect(stream).toEqual({ id: "stream" });
    expect(video.opened).toEqual([{ source: "camera", options: {} }]);
    expect(agent.videoSource).toBe("camera");
    expect(agent.videoStream).toBe(stream);
    expect(events).toEqual([{ active: true, source: "camera" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.ofType("video.frame")).toEqual([
      { type: "video.frame", image: "JPEG(frame-1)", mimeType: "image/jpeg" }
    ]);
    // 768 pixels on the longer side, at a lower quality than a picture.
    expect(log).toEqual([["frame-1", 768, 0.6]]);
    video.showing = "frame-2";
    await vi.advanceTimersByTimeAsync(999);
    expect(socket.ofType("video.frame")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.ofType("video.frame").at(-1)).toMatchObject({ image: "JPEG(frame-2)" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(socket.ofType("video.frame")).toHaveLength(5);
    agent.stop();
  });

  it("takes the screen, a stream of the page's own, and the options", async () => {
    const { agent, socket, video, log } = await watching();
    await agent.startVideo("screen", { intervalMs: 2000, maxSide: 1024 });
    expect(agent.videoSource).toBe("screen");
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual([["frame-1", 1024, 0.6]]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(socket.ofType("video.frame")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.ofType("video.frame")).toHaveLength(2);
    // A second video replaces the first: the screen is let go, and the relay hears of one video ending.
    const own = { id: "mine" } as unknown as MediaStream;
    await agent.startVideo(own, { intervalMs: 100 });
    expect(video.closed).toBe(1);
    expect(agent.videoSource).toBe("stream");
    expect(video.opened.at(-1)).toEqual({ source: own, options: { intervalMs: 100 } });
    // Never faster than the relay takes them.
    const before = socket.ofType("video.frame").length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.ofType("video.frame").length - before).toBe(3);
    agent.stop();
  });

  it("stops: the camera is let go, the relay is told, and no frame follows", async () => {
    const { agent, socket, video, events } = await watching();
    await agent.startVideo();
    await vi.advanceTimersByTimeAsync(0);
    agent.stopVideo();
    expect(video.closed).toBe(1);
    expect(agent.videoSource).toBeUndefined();
    expect(agent.videoStream).toBeUndefined();
    expect(socket.json().at(-1)).toEqual({ type: "video.stop" });
    expect(events.at(-1)).toEqual({ active: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.ofType("video.frame")).toHaveLength(1);
    // Stopping what is not on does nothing.
    agent.stopVideo();
    expect(socket.ofType("video.stop")).toHaveLength(1);
    expect(events).toHaveLength(2);
  });

  it("stops when the user stops sharing in the browser, and when the conversation ends", async () => {
    const first = await watching();
    await first.agent.startVideo("screen");
    first.video.end();
    expect(first.agent.videoSource).toBeUndefined();
    expect(first.video.closed).toBe(1);
    expect(first.socket.ofType("video.stop")).toHaveLength(1);

    const second = await watching();
    await second.agent.startVideo();
    second.agent.stop();
    // A camera never stays on after the conversation.
    expect(second.video.closed).toBe(1);
    expect(second.events.at(-1)).toEqual({ active: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(second.socket.ofType("video.frame").length).toBeLessThanOrEqual(1);
  });

  it("opens nothing without a ready session or a relay that takes video", async () => {
    const video = fakeVideo();
    const idle = new VoiceAgent({ url: "https://relay.example.com", internals: { video: video.opener } });
    expect(await idle.startVideo()).toBeNull();
    // Pictures alone are not video: an older relay.
    const { agent } = await watching({ imageInput: true });
    expect(await agent.startVideo()).toBeNull();
    expect(video.opened).toEqual([]);
    expect(agent.videoSource).toBeUndefined();
  });

  it("says so when the camera cannot be opened, which is what the user's no looks like", async () => {
    const { agent, video, events } = await watching();
    video.fail = new Error("Permission denied");
    await expect(agent.startVideo()).rejects.toMatchObject({
      code: "video",
      message: "Could not open the camera: Permission denied"
    });
    await expect(agent.startVideo("screen")).rejects.toMatchObject({ message: expect.stringContaining("the screen") });
    expect(agent.videoSource).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("lets the camera go when the conversation ended while the browser was asking", async () => {
    const { agent, video } = await watching();
    const pending = agent.startVideo();
    agent.stop();
    expect(await pending).toBeNull();
    expect(video.closed).toBe(1);
    expect(agent.videoSource).toBeUndefined();
  });

  it("skips a frame while there are no pixels, the last one is still being made, or the connection is behind", async () => {
    const waiting: Array<() => void> = [];
    const video = fakeVideo();
    const slow: ImageEncoder = async (source) => ({
      width: 100,
      height: 100,
      encode: () => new Promise<string>((resolve) => waiting.push(() => resolve(`JPEG(${String(source)})`)))
    });
    const { agent, socket } = await started({ internals: { video: video.opener, imageEncoder: slow } });
    socket.serverSends({ ...STARTED, capabilities: { videoInput: true } });
    video.showing = undefined;
    await agent.startVideo();
    await vi.advanceTimersByTimeAsync(2000);
    expect(waiting).toHaveLength(0);
    video.showing = "frame-1";
    await vi.advanceTimersByTimeAsync(3000);
    // Three ticks, one frame in the making.
    expect(waiting).toHaveLength(1);
    waiting.splice(0).forEach((done) => done());
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.ofType("video.frame")).toHaveLength(1);
    // Audio comes first.
    socket.bufferedAmount = 300 * 1024;
    await vi.advanceTimersByTimeAsync(3000);
    expect(waiting).toHaveLength(0);
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(waiting).toHaveLength(1);
    agent.stop();
  });

  it("keeps the video across a reconnect, and sends frames again to a session that takes them", async () => {
    const { agent, socket, video } = await watching();
    await agent.startVideo();
    await vi.advanceTimersByTimeAsync(0);
    socket.serverCloses(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.instances.at(-1)!;
    expect(next).not.toBe(socket);
    // Not ready yet: nothing goes out, and the camera stays open.
    await vi.advanceTimersByTimeAsync(2000);
    expect(next.ofType("video.frame")).toEqual([]);
    expect(video.closed).toBe(0);
    expect(agent.videoSource).toBe("camera");
    next.open();
    next.serverSends({ ...STARTED, capabilities: { videoInput: true } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(next.ofType("video.frame").length).toBeGreaterThanOrEqual(1);
    agent.stop();
  });
});
