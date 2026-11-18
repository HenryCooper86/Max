import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioIO } from "../sdk/src/audio";
import {
  VoiceAgent,
  VoiceAgentError,
  defineClientTool,
  type SocketEventMap,
  type VoiceAgentOptions,
  type WebSocketLike
} from "../sdk/src/client";

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
  const calls: string[] = [];
  const audio: AudioIO = {
    prepare: () => Promise.resolve(),
    startMic: (cb) => {
      calls.push("startMic");
      onFrame = cb;
      return Promise.resolve();
    },
    setMicEnabled: (enabled) => void calls.push(`mic:${enabled}`),
    releaseMic: () => void calls.push("releaseMic"),
    playPcm16: () => void calls.push("play"),
    speak: (text) => void calls.push(`speak:${text}`),
    clearPlayback: () => void calls.push("clear"),
    levels: () => ({ mic: 0, output: 0 }),
    close: () => void calls.push("close")
  };
  const factory = (onPlayingChange: (playing: boolean) => void) => {
    setPlaying = onPlayingChange;
    return audio;
  };
  return {
    audio: factory,
    calls,
    frame: (pcm: ArrayBuffer) => onFrame?.(pcm),
    setPlaying: (p: boolean) => setPlaying(p)
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
