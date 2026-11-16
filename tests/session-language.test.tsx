import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider, useLanguage } from "../src/components/LanguageToggle";
import { useHelmetAgent, type HelmetAgent } from "../src/hooks/useHelmetAgent";
import type { Language } from "../src/lib/i18n";

// Only audio I/O is replaced; the session hook and its socket handling are real.
const audio = vi.hoisted(() => ({
  playPcm16: vi.fn(),
  stopAgentSpeech: vi.fn(),
  speak: vi.fn(),
  speakWarning: vi.fn(),
  ensurePlaybackContext: vi.fn(async () => true),
  closePlayback: vi.fn()
}));
const capture = vi.hoisted(() => ({
  voiceLevel: 0,
  packetStats: {},
  audioProcessing: {},
  setPacketStats: vi.fn(),
  ensureMic: vi.fn(async () => {}),
  releaseMic: vi.fn(),
  setTrackEnabled: vi.fn(),
  resetFrameWindow: vi.fn()
}));
vi.mock("../src/hooks/useAudioPlayback", () => ({ useAudioPlayback: () => audio }));
vi.mock("../src/hooks/useMicCapture", () => ({ useMicCapture: () => capture }));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
type JsonEvent = Record<string, unknown>;
class Socket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  sent: JsonEvent[] = [];
  constructor() {
    super();
    Socket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = Socket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }
  send(data: string) {
    const event = JSON.parse(data) as JsonEvent;
    this.sent.push(event);
    if (event.type === "session.start")
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ type: "session.started", provider: "mock", mode: "mock", capabilities: {} })
          })
        )
      );
  }
  close() {
    this.readyState = Socket.CLOSING;
    queueMicrotask(() => {
      this.readyState = Socket.CLOSED;
      this.dispatchEvent(new Event("close"));
    });
  }
}

let renderer: ReactTestRenderer | undefined;
let agent: HelmetAgent;
let setLanguage: (language: Language) => void;
function Harness() {
  agent = useHelmetAgent();
  setLanguage = useLanguage().setLanguage;
  return null;
}
const starts = () =>
  Socket.instances.flatMap((socket) => socket.sent.filter((event) => event.type === "session.start"));

beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("window", {
    location: { protocol: "http:", host: "localhost", search: "" },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  });
  vi.stubGlobal("document", { hidden: false, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("navigator", { language: "en-US" });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ provider: "mock", capabilities: {} })));
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the assistant answers in the app's language", () => {
  it("sends the UI language in session.start and restarts when it changes", async () => {
    await act(async () => {
      renderer = create(
        <LanguageProvider>
          <Harness />
        </LanguageProvider>
      );
    });
    await act(async () => {
      await agent.startMic();
    });
    expect(starts()).toHaveLength(1);
    expect(starts()[0]).toMatchObject({ language: "zh" });

    await act(async () => setLanguage("en-US"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(Socket.instances).toHaveLength(2);
    expect(starts()).toHaveLength(2);
    expect(starts()[1]).toMatchObject({ language: "en" });

    // Choosing the language it already has does not restart.
    await act(async () => setLanguage("en-US"));
    expect(Socket.instances).toHaveLength(2);
  });

  it("does not open a session just because the language changed", async () => {
    await act(async () => {
      renderer = create(
        <LanguageProvider>
          <Harness />
        </LanguageProvider>
      );
    });
    await act(async () => setLanguage("en-US"));
    expect(Socket.instances).toHaveLength(0);
  });
});
