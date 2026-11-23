import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEBRTC_UNAVAILABLE_CODE, createWebRtcSocket, type WebRtcSocketOptions } from "../sdk/src/webrtc";

type Handler = (event: never) => void;

class FakeChannel {
  readyState = "connecting";
  bufferedAmount = 0;
  sent: string[] = [];
  private handlers = new Map<string, Handler[]>();
  send = (data: string) => void this.sent.push(data);
  addEventListener(type: string, handler: Handler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  fire(type: string, event: object = {}) {
    for (const handler of this.handlers.get(type) ?? []) handler(event as never);
  }
  open() {
    this.readyState = "open";
    this.fire("open");
  }
  message(data: unknown) {
    this.fire("message", { data });
  }
  close() {
    this.readyState = "closed";
    this.fire("close");
  }
}

class FakePeer {
  static instances: FakePeer[] = [];
  static gathering = "complete";
  config: unknown;
  channel = new FakeChannel();
  channelLabel: string | undefined;
  sender = { replaceTrack: vi.fn<(track: unknown) => Promise<void>>(async () => {}) };
  transceiver: { kind: string; init: unknown } | undefined;
  iceGatheringState = FakePeer.gathering;
  connectionState = "new";
  localDescription: { sdp: string } | null = null;
  remote: unknown;
  closed = 0;
  private handlers = new Map<string, Handler[]>();

  constructor(config?: unknown) {
    this.config = config;
    FakePeer.instances.push(this);
  }
  addTransceiver(kind: string, init: unknown) {
    this.transceiver = { kind, init };
    return { sender: this.sender };
  }
  createDataChannel(label: string) {
    this.channelLabel = label;
    return this.channel;
  }
  addEventListener(type: string, handler: Handler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0 offer" };
  }
  async setLocalDescription(description: { sdp: string }) {
    this.localDescription = description;
  }
  async setRemoteDescription(description: unknown) {
    this.remote = description;
  }
  close() {
    this.closed += 1;
  }
  fire(type: string, event: object = {}) {
    for (const handler of this.handlers.get(type) ?? []) handler(event as never);
  }
  setState(state: string) {
    this.connectionState = state;
    this.fire("connectionstatechange");
  }
}

const answer = (status: number, body: unknown) =>
  vi.fn<(url: unknown, init?: unknown) => Promise<unknown>>(async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body
  }));
const okFetch = () => answer(200, { sdp: "v=0 answer" });

function build(extra: Partial<WebRtcSocketOptions> = {}) {
  const onStream = vi.fn();
  const onStreamEnd = vi.fn();
  const fetch = okFetch();
  const socket = createWebRtcSocket({
    url: "https://relay.example.com/agent/webrtc",
    onStream,
    onStreamEnd,
    PeerConnection: FakePeer as never,
    fetch: fetch as never,
    ...extra
  });
  const events: Array<{ type: string; detail?: unknown }> = [];
  socket.addEventListener("open", () => events.push({ type: "open" }));
  socket.addEventListener("error", () => events.push({ type: "error" }));
  socket.addEventListener("message", (e) => events.push({ type: "message", detail: e.data }));
  socket.addEventListener("close", (e) => events.push({ type: "close", detail: { code: e.code, reason: e.reason } }));
  const closes = () => events.filter((e) => e.type === "close").map((e) => e.detail);
  return { socket, onStream, onStreamEnd, fetch, events, closes };
}

/** Lets the offer, the signalling request and the answer run. */
const settle = () => vi.advanceTimersByTimeAsync(0);
const peer = () => FakePeer.instances.at(-1)!;

async function opened(extra: Partial<WebRtcSocketOptions> = {}) {
  const built = build(extra);
  await settle();
  peer().channel.open();
  return built;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakePeer.instances = [];
  FakePeer.gathering = "complete";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createWebRtcSocket connecting", () => {
  it("posts the offer as JSON with a bearer token, applies the answer and opens with the events channel", async () => {
    const { socket, fetch, events } = build({ token: "tok_1" });
    expect(socket.readyState).toBe(0);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]! as [
      string,
      { method: string; headers: Record<string, string>; body: string }
    ];
    expect(url).toBe("https://relay.example.com/agent/webrtc");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer tok_1" });
    expect(JSON.parse(init.body)).toEqual({ sdp: "v=0 offer" });
    expect(peer().remote).toEqual({ type: "answer", sdp: "v=0 answer" });
    expect(peer().transceiver).toEqual({ kind: "audio", init: { direction: "sendrecv" } });
    expect(peer().channelLabel).toBe("events");
    expect(socket.readyState).toBe(0);
    expect(events).toEqual([]);

    peer().channel.open();
    expect(socket.readyState).toBe(1);
    expect(events).toEqual([{ type: "open" }]);
  });

  it("sends no authorization header without a token", async () => {
    const { fetch } = build();
    await settle();
    const init = fetch.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers).toEqual({ "content-type": "application/json" });
  });

  it("passes ICE servers to the peer connection only when given", async () => {
    build();
    await settle();
    expect(peer().config).toEqual({});
    build({ iceServers: [{ urls: "stun:stun.example.com" }] });
    await settle();
    expect(peer().config).toEqual({ iceServers: [{ urls: "stun:stun.example.com" }] });
  });

  it("sends strings to the events channel and ignores binary frames", async () => {
    const { socket } = await opened();
    socket.send('{"type":"x"}');
    socket.send(new ArrayBuffer(8));
    expect(peer().channel.sent).toEqual(['{"type":"x"}']);
  });

  it("says how much is waiting in the events channel, so live video can hold its frames back", async () => {
    const { socket } = await opened();
    expect(socket.bufferedAmount).toBe(0);
    peer().channel.bufferedAmount = 300_000;
    expect(socket.bufferedAmount).toBe(300_000);
  });

  it("does not send before the channel is open", async () => {
    const { socket } = build();
    await settle();
    socket.send("early");
    expect(peer().channel.sent).toEqual([]);
  });

  it("delivers channel messages to listeners as { data }", async () => {
    const { events } = await opened();
    peer().channel.message('{"type":"hello"}');
    expect(events.at(-1)).toEqual({ type: "message", detail: '{"type":"hello"}' });
  });

  it("ignores non-string channel messages", async () => {
    const { events } = await opened();
    peer().channel.message(new ArrayBuffer(4));
    expect(events.filter((e) => e.type === "message")).toEqual([]);
  });

  it("waits for ICE gathering to finish before posting the offer, and gives up waiting after a while", async () => {
    FakePeer.gathering = "gathering";
    const first = build();
    await settle();
    expect(first.fetch).not.toHaveBeenCalled();
    peer().iceGatheringState = "complete";
    peer().fire("icegatheringstatechange");
    await settle();
    expect(first.fetch).toHaveBeenCalledTimes(1);

    const second = build();
    await settle();
    expect(second.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(second.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("createWebRtcSocket relay goodbye", () => {
  it("closes with the relay's code and reason, hides the message, and lets the speech play out first", async () => {
    const { events, closes, onStream, onStreamEnd } = await opened();
    const stream = {} as MediaStream;
    peer().fire("track", { streams: [stream], track: {} });
    expect(onStream).toHaveBeenCalledWith(stream);

    peer().channel.message(JSON.stringify({ type: "transport.close", code: 4001, reason: "agent" }));
    expect(closes()).toEqual([{ code: 4001, reason: "agent" }]);
    expect(events.filter((e) => e.type === "message")).toEqual([]);
    expect(peer().closed).toBe(0);
    expect(onStreamEnd).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(399);
    expect(peer().closed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(peer().closed).toBe(1);
    expect(onStreamEnd).toHaveBeenCalledWith(stream);
  });

  it("uses 1000 and no reason when the goodbye has no details", async () => {
    const { closes } = await opened();
    peer().channel.message('{"type":"transport.close"}');
    expect(closes()).toEqual([{ code: 1000, reason: "" }]);
  });
});

describe("createWebRtcSocket when WebRTC cannot be used", () => {
  it.each([
    [401, 1008],
    [403, 1008],
    [429, 1013],
    [404, WEBRTC_UNAVAILABLE_CODE],
    [503, WEBRTC_UNAVAILABLE_CODE]
  ])("maps a %i answer from signalling to close code %i", async (status, code) => {
    const { closes, socket } = build({ fetch: answer(status, {}) as never });
    await settle();
    expect(closes()).toHaveLength(1);
    expect((closes()[0] as { code: number }).code).toBe(code);
    expect(socket.readyState).toBe(3);
    expect(peer().closed).toBe(1);
  });

  it("closes with 4990 when the signalling request fails", async () => {
    const { closes } = build({
      fetch: vi.fn(async () => {
        throw new TypeError("offline");
      }) as never
    });
    await settle();
    expect((closes()[0] as { code: number }).code).toBe(WEBRTC_UNAVAILABLE_CODE);
  });

  it("closes with 4990 when a 200 answer has no sdp string", async () => {
    const { closes } = build({ fetch: answer(200, { sdp: 5 }) as never });
    await settle();
    expect((closes()[0] as { code: number }).code).toBe(WEBRTC_UNAVAILABLE_CODE);
  });

  // The close comes after the caller has had the chance to listen for it.
  it("closes with 4990 when there is no RTCPeerConnection", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    const { closes } = build({ PeerConnection: undefined as never });
    await settle();
    expect(closes()).toEqual([{ code: WEBRTC_UNAVAILABLE_CODE, reason: "webrtc not supported" }]);
  });

  it("reports a closed socket when there is no RTCPeerConnection", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    const { socket } = build({ PeerConnection: undefined as never });
    await settle();
    expect(socket.readyState).toBe(3);
  });

  it("closes with 4990 when the channel never opens within the connect timeout", async () => {
    const { closes, socket } = build({ connectTimeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(2999);
    expect(closes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect((closes()[0] as { code: number }).code).toBe(WEBRTC_UNAVAILABLE_CODE);
    expect(socket.readyState).toBe(3);
    expect(peer().closed).toBe(1);
  });

  it("does not time out once the channel has opened", async () => {
    const { closes } = await opened({ connectTimeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closes()).toEqual([]);
  });
});

describe("createWebRtcSocket connection loss", () => {
  it("a failed connection before open means WebRTC is unavailable", async () => {
    const { closes } = build();
    await settle();
    peer().setState("failed");
    expect((closes()[0] as { code: number }).code).toBe(WEBRTC_UNAVAILABLE_CODE);
  });

  it("a failed connection after open is an ordinary drop (1006)", async () => {
    const { closes } = await opened();
    peer().setState("failed");
    expect((closes()[0] as { code: number }).code).toBe(1006);
  });

  it("treats disconnected as a drop only after the grace period", async () => {
    const { closes } = await opened();
    peer().setState("disconnected");
    await vi.advanceTimersByTimeAsync(4999);
    expect(closes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect((closes()[0] as { code: number }).code).toBe(1006);
  });

  it("does not close when the connection recovers within the grace period", async () => {
    const { closes, socket } = await opened();
    peer().setState("disconnected");
    await vi.advanceTimersByTimeAsync(3000);
    peer().setState("connected");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(closes()).toEqual([]);
    expect(socket.readyState).toBe(1);
  });

  it("the events channel closing before open means unavailable, after open means 1006", async () => {
    const before = build();
    await settle();
    peer().channel.close();
    expect((before.closes()[0] as { code: number }).code).toBe(WEBRTC_UNAVAILABLE_CODE);

    const after = await opened();
    peer().channel.close();
    expect((after.closes()[0] as { code: number }).code).toBe(1006);
  });
});

describe("createWebRtcSocket close()", () => {
  it("after open: says goodbye on the channel, emits close once, ends the stream at once and the peer after a linger", async () => {
    const { socket, closes, onStreamEnd } = await opened();
    const stream = {} as MediaStream;
    peer().fire("track", { streams: [stream], track: {} });

    socket.close(1000, "bye");
    expect(peer().channel.sent).toEqual(['{"type":"transport.close"}']);
    expect(closes()).toEqual([{ code: 1000, reason: "bye" }]);
    expect(socket.readyState).toBe(3);
    expect(onStreamEnd).toHaveBeenCalledWith(stream);
    expect(peer().closed).toBe(0);

    await vi.advanceTimersByTimeAsync(400);
    expect(peer().closed).toBe(1);
  });

  it("before open: closes the peer at once without a goodbye", async () => {
    const { socket, closes } = build();
    await settle();
    socket.close();
    expect(peer().closed).toBe(1);
    expect(peer().channel.sent).toEqual([]);
    expect(closes()).toEqual([{ code: 1000, reason: "" }]);
  });

  it("emits a single close event when called twice", async () => {
    const { socket, closes } = await opened();
    socket.close(1000);
    socket.close(4000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(closes()).toEqual([{ code: 1000, reason: "" }]);
    expect(peer().closed).toBe(1);
  });

  it("closing before the offer is sent stops the signalling request", async () => {
    FakePeer.gathering = "gathering";
    const { socket, fetch } = build();
    await settle();
    socket.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("createWebRtcSocket media", () => {
  it("sends the microphone track by replacing the sender's track, or null for none", async () => {
    const { socket } = build();
    await settle();
    const track = { id: "mic" } as MediaStreamTrack;
    socket.setMicrophone(track);
    expect(peer().sender.replaceTrack).toHaveBeenLastCalledWith(track);
    socket.setMicrophone(undefined);
    expect(peer().sender.replaceTrack).toHaveBeenLastCalledWith(null);
  });

  it("attaches a microphone set right after creation, before the offer has gone out", async () => {
    const { socket } = build();
    const track = { id: "mic" } as MediaStreamTrack;
    socket.setMicrophone(track);
    await settle();
    expect(peer().sender.replaceTrack).toHaveBeenLastCalledWith(track);
  });

  it("does not touch the sender after the socket closed", async () => {
    const { socket } = build();
    await settle();
    socket.close();
    peer().sender.replaceTrack.mockClear();
    socket.setMicrophone({} as MediaStreamTrack);
    expect(peer().sender.replaceTrack).not.toHaveBeenCalled();
  });

  it("hands the first stream of a track event to onStream", async () => {
    const { onStream } = build();
    await settle();
    const first = { id: "a" } as unknown as MediaStream;
    const second = { id: "b" } as unknown as MediaStream;
    peer().fire("track", { streams: [first, second], track: {} });
    expect(onStream).toHaveBeenCalledTimes(1);
    expect(onStream).toHaveBeenCalledWith(first);
  });
});
