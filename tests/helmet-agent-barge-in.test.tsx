// @vitest-environment node
// Barge-in under the relay's audio plan: when session.started says
// `bargeIn: "confirm"`, a `hearing` status or a rider transcript cuts the
// agent only once our own microphone has heard the wearer
// (docs/audio/contract.md, "Interruption"). Only audio I/O is replaced; the
// session hook, its socket handling and the relay event validator are real.
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { useHelmetAgent, type HelmetAgent } from "../src/hooks/useHelmetAgent";
import { NAV_FABRICATION_CLEAR_DETAIL } from "../shared/nav-fabrication";

const audio = vi.hoisted(() => ({
  playPcm16: vi.fn(),
  stopAgentSpeech: vi.fn(),
  speak: vi.fn(),
  speakWarning: vi.fn(async () => "unused" as const),
  ensurePlaybackContext: vi.fn(async () => true),
  closePlayback: vi.fn()
}));
const mic = vi.hoisted(() => ({
  params: undefined as { onFrameRms: (rms: number) => void } | undefined,
  value: {
    voiceLevel: 0,
    packetStats: {},
    audioProcessing: {},
    setPacketStats: vi.fn(),
    ensureMic: vi.fn(async () => {}),
    releaseMic: vi.fn(),
    setTrackEnabled: vi.fn(),
    resetFrameWindow: vi.fn()
  }
}));
vi.mock("../src/hooks/useAudioPlayback", () => ({ useAudioPlayback: () => audio }));
vi.mock("../src/hooks/useMicCapture", () => ({
  useMicCapture: (params: { onFrameRms: (rms: number) => void }) => {
    mic.params = params;
    return mic.value;
  }
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
type JsonEvent = Record<string, unknown>;
/** The plan the relay answers the next session.start with. */
let plan: Record<string, unknown> | undefined;

class Socket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
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
    if (event.type !== "session.start") return;
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "session.started",
            provider: "mock",
            mode: "mock",
            capabilities: {},
            ...(plan ? { audio: plan } : {})
          })
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
function Harness() {
  agent = useHelmetAgent();
  return null;
}

const RELAY_PLAN = { wakeGate: "relay", silenceFill: false, bargeIn: "relay" };
const CONFIRM_PLAN = { wakeGate: "relay", silenceFill: false, bargeIn: "confirm" };
const HEARING: JsonEvent = { type: "status", state: "hearing", detail: "豆包检测到骑手语音" };
const riderSays = (text: string): JsonEvent => ({
  type: "transcript",
  turnId: `turn-${text}`,
  deliveryId: `delivery-${text}`,
  speaker: "rider",
  text,
  final: true
});

/** The relay sends an event to the current session. */
const relay = (event: JsonEvent) => {
  act(() => {
    Socket.instances.at(-1)!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  });
};
/** One captured 20 ms frame, at this loudness (RMS of the PCM16 samples). */
const micFrame = (rms: number) => {
  act(() => {
    mic.params?.onFrameRms?.(rms);
    vi.advanceTimersByTime(20);
  });
};
const quiet = (frames = 20) => {
  for (let index = 0; index < frames; index += 1) micFrame(100);
};
const loud = (frames = 3) => {
  for (let index = 0; index < frames; index += 1) micFrame(2000);
};
/** How often the agent's speech was cut since the session started. */
const cuts = () => audio.stopAgentSpeech.mock.calls.length;

async function startHandsFree() {
  await act(async () => {
    renderer = create(
      <LanguageProvider>
        <Harness />
      </LanguageProvider>
    );
  });
  await act(async () => {
    await agent.startMic();
    await vi.advanceTimersByTimeAsync(10);
  });
  // startMic itself silences whatever was playing; count from here.
  audio.stopAgentSpeech.mockClear();
}

beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  plan = undefined;
  mic.params = undefined;
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

describe("a session whose plan leaves the barge-in to the relay", () => {
  it("cuts the agent on every hearing status and rider transcript, microphone or not", async () => {
    plan = RELAY_PLAN;
    await startHandsFree();
    quiet();
    relay(HEARING);
    expect(cuts()).toBe(1);
    relay(riderSays("前面的路口怎么走"));
    expect(cuts()).toBe(2);
  });

  it("does the same when the relay sends no plan at all", async () => {
    await startHandsFree();
    relay(HEARING);
    expect(cuts()).toBe(1);
    relay(riderSays("导航去公司"));
    expect(cuts()).toBe(2);
  });
});

describe("a session whose plan says bargeIn: confirm", () => {
  beforeEach(() => {
    plan = CONFIRM_PLAN;
  });

  it("leaves the agent speaking when the microphone never hears the wearer", async () => {
    // The relay's detector fired on our own speaker: its event comes and goes
    // while our microphone stays quiet.
    await startHandsFree();
    relay(HEARING);
    quiet();
    expect(cuts()).toBe(0);
    relay(riderSays("前方畅通"));
    quiet();
    expect(cuts()).toBe(0);
  });

  it("cuts once the microphone agrees, within the grace period", async () => {
    await startHandsFree();
    relay(HEARING);
    expect(cuts()).toBe(0);
    loud(2);
    expect(cuts()).toBe(0);
    loud(1);
    // Agreed from a later frame: the cut is not reported as a new interruption.
    expect(audio.stopAgentSpeech.mock.calls).toEqual([[false]]);
  });

  it("cuts at once when the microphone already heard the wearer", async () => {
    await startHandsFree();
    loud();
    relay(HEARING);
    expect(audio.stopAgentSpeech.mock.calls).toEqual([[true]]);
  });

  it("gives up when the microphone agrees only after the grace period", async () => {
    await startHandsFree();
    relay(HEARING);
    quiet(16);
    loud();
    expect(cuts()).toBe(0);
  });

  it("confirms a rider transcript the same way", async () => {
    await startHandsFree();
    relay(riderSays("导航去公司"));
    expect(cuts()).toBe(0);
    loud();
    expect(audio.stopAgentSpeech.mock.calls).toEqual([[false]]);
  });

  it("confirms a rider transcript at once when the microphone already heard the wearer", async () => {
    await startHandsFree();
    loud();
    relay(riderSays("导航去公司"));
    expect(audio.stopAgentSpeech.mock.calls).toEqual([[true]]);
  });

  it("still cuts at once when the relay cut the reply itself", async () => {
    // Nothing is behind these for a microphone to confirm.
    await startHandsFree();
    relay({ ...HEARING, detail: "回答已停止", cause: "relay" });
    expect(cuts()).toBe(1);
    relay({ ...HEARING, detail: NAV_FABRICATION_CLEAR_DETAIL });
    expect(cuts()).toBe(2);
    // Any other cause is not the marker.
    relay({ ...HEARING, cause: "user" });
    quiet();
    expect(cuts()).toBe(2);
  });

  it("still cuts at once for an interrupting safety alert", async () => {
    await startHandsFree();
    relay({
      type: "hazard.alert",
      threat: "rear_approach",
      direction: "rear",
      severity: "critical",
      label: "后方接近",
      message: "车辆接近",
      advice: "靠边停车",
      interrupt: true
    });
    expect(cuts()).toBe(1);
  });

  it("goes back to the relay's word when the next session announces no such plan", async () => {
    await startHandsFree();
    relay(HEARING);
    expect(cuts()).toBe(0);
    plan = RELAY_PLAN;
    await act(async () => agent.setVoiceGender("male"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    relay(HEARING);
    expect(cuts()).toBe(1);
  });
});
