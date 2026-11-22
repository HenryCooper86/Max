/**
 * WebRTC transport for the voice agent. Internal; the public surface is the
 * `transport` option of {@link VoiceAgent}.
 *
 * A peer connection carries what the WebSocket carries: the JSON events on a
 * data channel named "events", and audio as Opus on one track each way. To the
 * client it is a socket, so sessions, reconnects, tools and tokens work
 * unchanged. Binary frames are not sent here: the microphone travels on the
 * track, and the agent's voice arrives as a stream the browser plays itself.
 */

import type { SocketEventMap, WebSocketLike } from "./client.js";
import { UNAUTHORIZED_CLOSE_CODE } from "./protocol.js";

/**
 * Close code for "WebRTC could not be used here": the relay does not offer it,
 * the browser lacks it, or the network let no audio through. The client falls
 * back to the WebSocket. Never sent by a relay.
 */
export const WEBRTC_UNAVAILABLE_CODE = 4990;

/** How long the peer connection may take to open before the WebSocket is used instead. */
const CONNECT_TIMEOUT_MS = 8000;
/** Candidates are sent with the offer; gathering is not waited for longer than this. */
const GATHER_TIMEOUT_MS = 1500;
/** A network change shows as "disconnected" and often recovers. After this long it is a lost connection. */
const DISCONNECT_GRACE_MS = 5000;
/** After the relay says goodbye, the browser still holds a moment of speech to play. */
const CLOSE_LINGER_MS = 400;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** @internal */
export type WebRtcSocketOptions = {
  /** `https://relay.example.com/agent/webrtc`. */
  url: string;
  token?: string;
  iceServers?: RTCIceServer[];
  /** The agent's voice, once the relay's track arrives. */
  onStream(stream: MediaStream): void;
  /** The stream is over: the connection closed. */
  onStreamEnd(stream: MediaStream): void;
  connectTimeoutMs?: number;
  /** Test seams. */
  PeerConnection?: typeof RTCPeerConnection;
  fetch?: typeof fetch;
};

/** @internal A socket that also takes the microphone as a track. */
export interface WebRtcSocket extends WebSocketLike {
  /** Sends this microphone track, or silence when there is none. */
  setMicrophone(track: MediaStreamTrack | undefined): void;
}

/** Whether this browser can open a peer connection at all. */
export function webRtcSupported(): boolean {
  return typeof RTCPeerConnection === "function" && typeof fetch === "function";
}

type Listeners = { [K in keyof SocketEventMap]: Array<(event: SocketEventMap[K]) => void> };

/** Opens a peer connection to the relay. Like a WebSocket, it connects at once and reports through events. */
export function createWebRtcSocket(options: WebRtcSocketOptions): WebRtcSocket {
  const listeners: Listeners = { open: [], error: [], message: [], close: [] };
  const emit = <K extends keyof SocketEventMap>(type: K, event: SocketEventMap[K]) => {
    for (const listener of [...listeners[type]]) listener(event);
  };
  const Peer = options.PeerConnection ?? globalThis.RTCPeerConnection;
  const request = options.fetch ?? globalThis.fetch;

  let state = CONNECTING;
  let peer: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  let sender: RTCRtpSender | undefined;
  let microphone: MediaStreamTrack | undefined;
  let stream: MediaStream | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = typeof AbortController === "function" ? new AbortController() : undefined;

  /**
   * Ends the socket once. `linger` leaves the connection up for a moment:
   * "speech" so the relay's last words play out, "goodbye" only so this side's
   * closing message can leave, with the agent silenced at once.
   */
  const finish = (code: number, reason: string, linger?: "speech" | "goodbye") => {
    if (state === CLOSED) return;
    state = CLOSED;
    clearTimeout(connectTimer);
    clearTimeout(graceTimer);
    abort?.abort();
    const closing = peer;
    const ended = stream;
    const closePeer = () => {
      try {
        closing?.close();
      } catch {
        /* already closed */
      }
    };
    const endStream = () => {
      if (ended) options.onStreamEnd(ended);
    };
    if (linger !== "speech") endStream();
    if (linger) {
      setTimeout(() => {
        closePeer();
        if (linger === "speech") endStream();
      }, CLOSE_LINGER_MS);
    } else closePeer();
    emit("close", { code, reason });
  };

  const connectTimer = setTimeout(
    () => finish(WEBRTC_UNAVAILABLE_CODE, "webrtc connect timeout"),
    options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  );

  const attachMicrophone = () => {
    if (!sender || state === CLOSED) return;
    void sender.replaceTrack(microphone ?? null).catch(() => undefined);
  };

  const gathered = (connection: RTCPeerConnection) =>
    new Promise<void>((resolve) => {
      if (connection.iceGatheringState === "complete") return resolve();
      const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
      connection.addEventListener("icegatheringstatechange", () => {
        if (connection.iceGatheringState !== "complete") return;
        clearTimeout(timer);
        resolve();
      });
    });

  const open = async () => {
    if (typeof Peer !== "function" || typeof request !== "function") {
      finish(WEBRTC_UNAVAILABLE_CODE, "webrtc not supported");
      return;
    }
    const connection = new Peer(options.iceServers ? { iceServers: options.iceServers } : {});
    peer = connection;
    sender = connection.addTransceiver("audio", { direction: "sendrecv" }).sender;
    attachMicrophone();
    const events = connection.createDataChannel("events");
    channel = events;

    connection.addEventListener("track", (event) => {
      if (state === CLOSED) return;
      stream = event.streams[0] ?? new MediaStream([event.track]);
      options.onStream(stream);
    });
    connection.addEventListener("connectionstatechange", () => {
      clearTimeout(graceTimer);
      const now = connection.connectionState;
      // Before the session opened, a failure means this network will not carry WebRTC.
      if (now === "failed" || now === "closed") finish(state === OPEN ? 1006 : WEBRTC_UNAVAILABLE_CODE, now);
      else if (now === "disconnected") {
        graceTimer = setTimeout(() => finish(1006, "disconnected"), DISCONNECT_GRACE_MS);
      }
    });
    events.addEventListener("open", () => {
      if (state !== CONNECTING) return;
      state = OPEN;
      clearTimeout(connectTimer);
      emit("open", undefined);
    });
    events.addEventListener("message", (event: MessageEvent) => {
      if (state === CLOSED || typeof event.data !== "string") return;
      const data = event.data;
      if (data.length < 256 && data.includes('"transport.close"')) {
        // The relay's close code and reason, which a peer connection cannot carry.
        let code = 1000;
        let reason = "";
        try {
          const parsed = JSON.parse(data) as { code?: unknown; reason?: unknown };
          if (typeof parsed.code === "number") code = parsed.code;
          if (typeof parsed.reason === "string") reason = parsed.reason;
        } catch {
          /* a close without details */
        }
        finish(code, reason, "speech");
        return;
      }
      emit("message", { data });
    });
    events.addEventListener("close", () => finish(state === OPEN ? 1006 : WEBRTC_UNAVAILABLE_CODE, "channel closed"));

    await connection.setLocalDescription(await connection.createOffer());
    await gathered(connection);
    if (state === CLOSED) return;
    let response: Response;
    try {
      response = await request(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
        },
        body: JSON.stringify({ sdp: connection.localDescription?.sdp ?? "" }),
        ...(abort ? { signal: abort.signal } : {})
      });
    } catch {
      finish(WEBRTC_UNAVAILABLE_CODE, "webrtc signalling failed");
      return;
    }
    if (state === CLOSED) return;
    if (response.status === 401 || response.status === 403) {
      finish(UNAUTHORIZED_CLOSE_CODE, "unauthorized");
      return;
    }
    if (response.status === 429) {
      finish(1013, "too many connection attempts");
      return;
    }
    let answer: { sdp?: unknown } = {};
    try {
      answer = (await response.json()) as { sdp?: unknown };
    } catch {
      /* treated as no answer */
    }
    if (state === CLOSED) return;
    if (!response.ok || typeof answer.sdp !== "string") {
      // 404: the relay has WebRTC off. 503: it has no room. Either way the WebSocket still works.
      finish(WEBRTC_UNAVAILABLE_CODE, `webrtc refused (${response.status})`);
      return;
    }
    await connection.setRemoteDescription({ type: "answer", sdp: answer.sdp });
  };

  // Not before the caller has its listeners on: a failure in the first step
  // closes the socket, and that close must be heard.
  void Promise.resolve()
    .then(open)
    .catch(() => finish(WEBRTC_UNAVAILABLE_CODE, "webrtc setup failed"));

  return {
    get readyState() {
      return state;
    },
    bufferedAmount: 0,
    binaryType: "arraybuffer",
    send(data) {
      // Audio does not travel this way: the microphone is a track.
      if (typeof data !== "string" || state !== OPEN || channel?.readyState !== "open") return;
      channel.send(data);
    },
    close(code = 1000, reason = "") {
      if (state === CLOSED) return;
      if (state === OPEN && channel?.readyState === "open") {
        try {
          channel.send(JSON.stringify({ type: "transport.close" }));
        } catch {
          /* the relay notices the connection closing instead */
        }
      }
      finish(code, reason, state === OPEN ? "goodbye" : undefined);
    },
    addEventListener(type, listener) {
      (listeners[type] as Array<typeof listener>).push(listener);
    },
    setMicrophone(track) {
      microphone = track;
      attachMicrophone();
    }
  };
}
