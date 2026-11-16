import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceEqualizerOptions } from "../shared/agent";
import { VoiceEqualizerPanel } from "../src/components/VoiceEqualizerPanel";
import { EQUALIZER_RESTART_DEBOUNCE_MS, useHelmetAgent, type HelmetAgent } from "../src/hooks/useHelmetAgent";
import {
  clampDb,
  equalizerForSession,
  equalizerResponse,
  normalizeEqualizer,
  resolveDefaultEqualizer,
  resolveEqualizer
} from "../src/lib/equalizer";
import { normalizeStoredSettings } from "../src/lib/persistence";

const OPTIONS: VoiceEqualizerOptions = {
  default: { preset: "flat" },
  adjustable: true,
  presets: [
    { id: "flat", label: "Flat", bands: { bass: 0, mid: 0, presence: 0, treble: 0, gain: 0 } },
    {
      id: "clarity",
      label: "Clarity",
      description: "Lifts consonants.",
      bands: { bass: -2, mid: 0, presence: 4, treble: 2, gain: 0 }
    },
    { id: "loud", label: "Loud", bands: { bass: 30, mid: 0, presence: 0, treble: 0, gain: -40 } }
  ]
};

describe("equalizer normalisation", () => {
  it("clamps band values to -12…12 dB in whole-dB steps and drops non-numbers", () => {
    expect(clampDb(40)).toBe(12);
    expect(clampDb(-40)).toBe(-12);
    expect(clampDb(2.6)).toBe(3);
    expect(clampDb(-0.2)).toBe(0);
    expect(clampDb(Number.NaN)).toBeUndefined();
    expect(clampDb(Infinity)).toBeUndefined();
    expect(clampDb("6")).toBeUndefined();
  });

  it("keeps a plausible preset id and clamped bands; anything else goes", () => {
    expect(normalizeEqualizer({ preset: "clarity", bass: 99, treble: "loud", gain: -3.4 })).toEqual({
      preset: "clarity",
      bass: 12,
      gain: -3
    });
    expect(normalizeEqualizer({ preset: "<script>" })).toBeNull();
    expect(normalizeEqualizer(null)).toBeNull();
    expect(normalizeEqualizer([1, 2])).toBeNull();
  });

  it("persists the equaliser through the stored-settings normaliser", () => {
    expect(normalizeStoredSettings({ equalizer: { bass: -50, mid: 2 } })).toEqual({ equalizer: { bass: -12, mid: 2 } });
    expect(normalizeStoredSettings({ equalizer: "loud" })).toEqual({});
  });
});

describe("equalizer resolution", () => {
  it("resolves a preset to its bands and the relay default when nothing is chosen", () => {
    expect(resolveEqualizer({ preset: "clarity" }, OPTIONS)).toEqual({
      preset: "clarity",
      bands: { bass: -2, mid: 0, presence: 4, treble: 2, gain: 0 }
    });
    expect(resolveEqualizer(null, OPTIONS)).toEqual(resolveDefaultEqualizer(OPTIONS));
    expect(resolveDefaultEqualizer(OPTIONS).preset).toBe("flat");
  });

  it("turns a preset with a changed band into a custom curve", () => {
    const resolved = resolveEqualizer({ preset: "clarity", bass: 5 }, OPTIONS);
    expect(resolved.preset).toBeNull();
    expect(resolved.bands).toEqual({ bass: 5, mid: 0, presence: 4, treble: 2, gain: 0 });
  });

  it("clamps a relay preset whose bands are out of range", () => {
    expect(resolveEqualizer({ preset: "loud" }, OPTIONS).bands).toMatchObject({ bass: 12, gain: -12 });
  });

  it("falls back to the relay default for a preset this relay does not offer", () => {
    expect(resolveEqualizer({ preset: "gone" }, OPTIONS)).toEqual(resolveDefaultEqualizer(OPTIONS));
  });
});

describe("equalizer in session.start", () => {
  it("sends a preset by id and a custom curve as all five bands", () => {
    expect(equalizerForSession({ preset: "clarity" }, OPTIONS)).toEqual({ preset: "clarity" });
    expect(equalizerForSession({ bass: 20, presence: 3 }, OPTIONS)).toEqual({
      bass: 12,
      mid: 0,
      presence: 3,
      treble: 0,
      gain: 0
    });
  });

  it("sends nothing without an adjustable relay equaliser, a choice, or a known preset", () => {
    expect(equalizerForSession({ preset: "clarity" }, undefined)).toBeUndefined();
    expect(equalizerForSession({ preset: "clarity" }, { ...OPTIONS, adjustable: false })).toBeUndefined();
    expect(equalizerForSession(null, OPTIONS)).toBeUndefined();
    expect(equalizerForSession({ preset: "gone" }, OPTIONS)).toBeUndefined();
  });

  it("draws a flat curve for flat bands and shifts it by the gain", () => {
    const flat = { bass: 0, mid: 0, presence: 0, treble: 0, gain: 0 };
    expect(equalizerResponse(flat, 1000)).toBe(0);
    expect(equalizerResponse({ ...flat, gain: -4 }, 50)).toBe(-4);
    expect(equalizerResponse({ ...flat, bass: 6 }, 40)).toBeGreaterThan(5);
    expect(equalizerResponse({ ...flat, bass: 6 }, 10_000)).toBeLessThan(0.1);
  });
});

describe("equalizer panel", () => {
  it("offers preset chips, five sliders and a reset when adjustable", () => {
    const html = renderToStaticMarkup(
      <VoiceEqualizerPanel options={OPTIONS} value={{ preset: "clarity" }} onChange={() => {}} />
    );
    expect(html.match(/type="range"/g)).toHaveLength(5);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Clarity</);
    expect(html).toContain('title="Lifts consonants."');
    expect(html).toContain("+4 dB");
    expect(html).toContain('role="img"');
  });

  it("shows the relay's setting read-only when it is not adjustable", () => {
    const html = renderToStaticMarkup(
      <VoiceEqualizerPanel options={{ ...OPTIONS, adjustable: false }} value={{ bass: 9 }} onChange={() => {}} />
    );
    expect(html).not.toContain('type="range"');
    expect(html).not.toContain("<button");
    expect(html).toContain("Flat");
  });
});

// The hook wiring, with only audio I/O replaced (as in the navigation suite).
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
let stored: Record<string, string>;
function Harness() {
  agent = useHelmetAgent();
  return null;
}
const sessionStarts = () =>
  Socket.instances.flatMap((socket) => socket.sent.filter((event) => event.type === "session.start"));

async function mount(equalizer: VoiceEqualizerOptions | undefined) {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          provider: "mock",
          capabilities: {},
          voice: { active: "mock", switching: true, providers: [], ...(equalizer ? { equalizer } : {}) }
        })
      )
  );
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => {
    await agent.startMic();
  });
  expect(agent.listening).toBe(true);
}

describe("equalizer settings ↔ session.start", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Socket.instances = [];
    stored = {};
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost", search: "" },
      localStorage: {
        getItem: (key: string) => stored[key] ?? null,
        setItem: (key: string, value: string) => {
          stored[key] = value;
        },
        removeItem: (key: string) => {
          delete stored[key];
        }
      },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval
    });
    vi.stubGlobal("document", { hidden: false, addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("WebSocket", Socket);
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("restarts once, after the debounce, with the chosen preset in session.start", async () => {
    await mount(OPTIONS);
    expect(sessionStarts()).toHaveLength(1);
    expect(sessionStarts()[0]).not.toHaveProperty("equalizer");

    act(() => agent.setEqualizer({ preset: "clarity" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EQUALIZER_RESTART_DEBOUNCE_MS - 50);
    });
    expect(sessionStarts()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(sessionStarts()).toHaveLength(2);
    expect(sessionStarts()[1]).toMatchObject({ equalizer: { preset: "clarity" } });
    expect(JSON.parse(stored["max.settings.v1"]!)).toMatchObject({ equalizer: { preset: "clarity" } });
  });

  it("coalesces a slider drag into one restart and clamps what it sends", async () => {
    await mount(OPTIONS);
    for (const bass of [1, 2, 3, 4, 40]) {
      act(() => agent.setEqualizer({ bass, mid: 0, presence: 0, treble: 0, gain: 0 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    expect(agent.equalizer).toMatchObject({ bass: 12 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EQUALIZER_RESTART_DEBOUNCE_MS);
    });
    expect(sessionStarts()).toHaveLength(2);
    expect(sessionStarts()[1]!.equalizer).toEqual({ bass: 12, mid: 0, presence: 0, treble: 0, gain: 0 });
  });

  it("neither restarts nor sends the equaliser when the relay does not let clients adjust it", async () => {
    await mount({ ...OPTIONS, adjustable: false });
    act(() => agent.setEqualizer({ preset: "clarity" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EQUALIZER_RESTART_DEBOUNCE_MS * 2);
    });
    expect(sessionStarts()).toHaveLength(1);
    await act(async () => agent.setVoiceGender("male"));
    expect(sessionStarts()).toHaveLength(2);
    expect(sessionStarts()[1]).not.toHaveProperty("equalizer");
  });

  it("leaves session.start unchanged on a relay without an equaliser", async () => {
    await mount(undefined);
    act(() => agent.setEqualizer({ preset: "clarity" }));
    await act(async () => agent.setVoiceGender("male"));
    expect(sessionStarts()).toHaveLength(2);
    expect(sessionStarts().every((event) => !("equalizer" in event))).toBe(true);
  });
});
