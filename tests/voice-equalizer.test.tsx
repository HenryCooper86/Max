import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EQUALIZER_FREQUENCIES, type VoiceEqualizerOptions } from "../shared/agent";
import { VoiceEqualizerPanel } from "../src/components/VoiceEqualizerPanel";
import { EQUALIZER_RESTART_DEBOUNCE_MS, useHelmetAgent, type HelmetAgent } from "../src/hooks/useHelmetAgent";
import {
  clampDb,
  equalizerForSession,
  frequencyLabel,
  normalizeBands,
  normalizeEqualizer,
  resolveDefaultEqualizer,
  resolveEqualizer,
  usableEqualizerOptions
} from "../src/lib/equalizer";
import { normalizeStoredSettings } from "../src/lib/persistence";

const FLAT = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const CLARITY = [-2, -1, 0, 0, 1, 3, 4, 3, 2, 1];
const OPTIONS: VoiceEqualizerOptions = {
  default: { preset: "flat" },
  adjustable: true,
  frequencies: [...EQUALIZER_FREQUENCIES],
  presets: [
    { id: "flat", label: "Flat", bands: FLAT, preamp: 0 },
    { id: "clarity", label: "Clarity", description: "Lifts consonants.", bands: CLARITY, preamp: -1 },
    { id: "loud", label: "Loud", bands: [30, 0, 0, 0, 0, 0, 0, 0, 0, -40], preamp: 20 }
  ]
};

describe("equalizer normalisation", () => {
  it("clamps gains to -12…12 dB in whole-dB steps and drops non-numbers", () => {
    expect(clampDb(40)).toBe(12);
    expect(clampDb(-40)).toBe(-12);
    expect(clampDb(2.6)).toBe(3);
    expect(clampDb(-0.2)).toBe(0);
    expect(clampDb(Number.NaN)).toBeUndefined();
    expect(clampDb("6")).toBeUndefined();
  });

  it("accepts exactly ten finite bands", () => {
    expect(normalizeBands([20, -20, 1.4, 0, 0, 0, 0, 0, 0, 0])).toEqual([12, -12, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(normalizeBands([0, 0, 0, 0, 0])).toBeNull();
    expect(normalizeBands([...FLAT, 0])).toBeNull();
    expect(normalizeBands([...FLAT.slice(1), "0"])).toBeNull();
  });

  it("keeps a plausible preset id, ten bands and a preamp; anything else goes", () => {
    expect(normalizeEqualizer({ preset: "clarity", bands: [99, ...FLAT.slice(1)], preamp: -30 })).toEqual({
      preset: "clarity",
      bands: [12, ...FLAT.slice(1)],
      preamp: -12
    });
    expect(normalizeEqualizer({ preset: "<script>" })).toBeNull();
    expect(normalizeEqualizer(null)).toBeNull();
  });

  it("discards a setting stored in the retired five-band shape", () => {
    expect(normalizeEqualizer({ bass: -8, mid: -1, presence: 5, treble: 2, gain: 2 })).toBeNull();
    expect(normalizeStoredSettings({ equalizer: { bass: -50, mid: 2 } })).toEqual({});
    expect(normalizeStoredSettings({ equalizer: { bands: CLARITY, preamp: 2 }, equalizerOff: true })).toEqual({
      equalizer: { bands: CLARITY, preamp: 2 },
      equalizerOff: true
    });
  });
});

describe("the relay's equaliser offer", () => {
  it("is usable only in the ten-band shape; five-band presets fall back to nothing", () => {
    expect(usableEqualizerOptions(OPTIONS)?.presets.map((preset) => preset.id)).toEqual(["flat", "clarity", "loud"]);
    const old = {
      default: { preset: "flat" },
      adjustable: true,
      presets: [{ id: "flat", label: "Flat", bands: { bass: 0, mid: 0, presence: 0, treble: 0, gain: 0 } }]
    };
    expect(usableEqualizerOptions(old)).toBeUndefined();
    expect(usableEqualizerOptions(undefined)).toBeUndefined();
    expect(usableEqualizerOptions({ presets: "flat" })).toBeUndefined();
  });

  it("drops malformed presets, clamps the rest and defaults the frequencies", () => {
    const usable = usableEqualizerOptions({
      ...OPTIONS,
      frequencies: [1, 2, 3],
      presets: [...OPTIONS.presets, { id: "short", label: "Short", bands: [1, 2], preamp: 0 }]
    })!;
    expect(usable.presets.map((preset) => preset.id)).toEqual(["flat", "clarity", "loud"]);
    expect(usable.presets[2]).toMatchObject({ bands: [12, 0, 0, 0, 0, 0, 0, 0, 0, -12], preamp: 12 });
    expect(usable.frequencies).toEqual([...EQUALIZER_FREQUENCIES]);
  });
});

describe("equalizer resolution", () => {
  it("resolves a preset to its bands and the relay default when nothing is chosen", () => {
    expect(resolveEqualizer({ preset: "clarity" }, OPTIONS)).toEqual({ preset: "clarity", bands: CLARITY, preamp: -1 });
    expect(resolveEqualizer(null, OPTIONS)).toEqual(resolveDefaultEqualizer(OPTIONS));
    expect(resolveDefaultEqualizer(OPTIONS).preset).toBe("flat");
  });

  it("calls a changed curve custom, and a curve that lands on a preset by its name", () => {
    expect(resolveEqualizer({ preset: "clarity", preamp: 3 }, OPTIONS).preset).toBeNull();
    expect(resolveEqualizer({ bands: [1, ...FLAT.slice(1)], preamp: 0 }, OPTIONS).preset).toBeNull();
    expect(resolveEqualizer({ bands: CLARITY, preamp: -1 }, OPTIONS).preset).toBe("clarity");
  });

  it("falls back to the relay default for a preset this relay does not offer", () => {
    expect(resolveEqualizer({ preset: "gone" }, OPTIONS)).toEqual(resolveDefaultEqualizer(OPTIONS));
  });
});

describe("equalizer in session.start", () => {
  it("sends an untouched preset by id and a custom curve as bands plus preamp", () => {
    expect(equalizerForSession({ preset: "clarity" }, OPTIONS)).toEqual({ preset: "clarity" });
    const custom = [20, 3, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(equalizerForSession({ bands: custom, preamp: -2 }, OPTIONS)).toEqual({
      bands: [12, 3, 0, 0, 0, 0, 0, 0, 0, 0],
      preamp: -2
    });
  });

  it("asks for flat when switched off", () => {
    expect(equalizerForSession({ preset: "clarity" }, OPTIONS, false)).toEqual({ preset: "flat" });
    const noFlat = { ...OPTIONS, presets: OPTIONS.presets.filter((preset) => preset.id !== "flat") };
    expect(equalizerForSession(null, noFlat, false)).toEqual({ bands: FLAT, preamp: 0 });
  });

  it("sends nothing without an adjustable relay equaliser, a choice, or a known preset", () => {
    expect(equalizerForSession({ preset: "clarity" }, undefined)).toBeUndefined();
    expect(equalizerForSession({ preset: "clarity" }, { ...OPTIONS, adjustable: false })).toBeUndefined();
    expect(equalizerForSession({ preset: "clarity" }, { ...OPTIONS, adjustable: false }, false)).toBeUndefined();
    expect(equalizerForSession(null, OPTIONS)).toBeUndefined();
    expect(equalizerForSession({ preset: "gone" }, OPTIONS)).toBeUndefined();
  });

  it("labels the bands the classic way", () => {
    expect(EQUALIZER_FREQUENCIES.map(frequencyLabel)).toEqual([
      "60",
      "125",
      "250",
      "500",
      "1K",
      "2K",
      "3K",
      "4K",
      "6K",
      "9K"
    ]);
  });
});

describe("equalizer panel", () => {
  const render = (props: Partial<Parameters<typeof VoiceEqualizerPanel>[0]> = {}) =>
    renderToStaticMarkup(
      <VoiceEqualizerPanel
        options={OPTIONS}
        value={{ preset: "clarity" }}
        onChange={() => {}}
        enabled
        onEnabledChange={() => {}}
        {...props}
      />
    );

  it("draws a preamp and ten vertical faders labelled with frequency and value", () => {
    const html = render();
    expect(html.match(/role="slider"/g)).toHaveLength(11);
    expect(html.match(/aria-orientation="vertical"/g)).toHaveLength(11);
    expect(html).toContain('aria-valuetext="3 kHz +4 dB"');
    expect(html).toContain('aria-valuetext="60 Hz −2 dB"');
    expect(html).toMatch(/<option value="clarity" selected="">Clarity<\/option>/);
    expect(html).toContain("Lifts consonants.");
    expect(html).toContain('role="switch" aria-checked="true"');
    expect(html).toContain('class="eqCurve"');
  });

  it("offers Custom only when the curve matches no preset", () => {
    expect(render()).not.toContain("__custom");
    expect(render({ value: { bands: [5, ...FLAT.slice(1)], preamp: 0 } })).toMatch(/value="__custom"[^>]*selected/);
  });

  it("locks the faders when switched off or when the relay fixes the curve", () => {
    expect(render({ enabled: false }).match(/aria-disabled="true"/g)).toHaveLength(11);
    const fixed = render({ options: { ...OPTIONS, adjustable: false } });
    expect(fixed).not.toContain("<select");
    expect(fixed).not.toContain('role="switch"');
    expect(fixed.match(/tabindex="-1"/g)).toHaveLength(11);
    expect(fixed).toContain("Flat");
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
    for (const low of [1, 2, 3, 4, 40]) {
      act(() => agent.setEqualizer({ bands: [low, ...FLAT.slice(1)], preamp: -2 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    expect(agent.equalizer).toMatchObject({ bands: [12, ...FLAT.slice(1)] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EQUALIZER_RESTART_DEBOUNCE_MS);
    });
    expect(sessionStarts()).toHaveLength(2);
    expect(sessionStarts()[1]!.equalizer).toEqual({ bands: [12, ...FLAT.slice(1)], preamp: -2 });
  });

  it("switching it off restarts with the flat preset and keeps the choice for later", async () => {
    await mount(OPTIONS);
    act(() => agent.setEqualizer({ preset: "clarity" }));
    act(() => agent.setEqualizerEnabled(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EQUALIZER_RESTART_DEBOUNCE_MS);
    });
    expect(sessionStarts()).toHaveLength(2);
    expect(sessionStarts()[1]).toMatchObject({ equalizer: { preset: "flat" } });
    expect(JSON.parse(stored["max.settings.v1"]!)).toMatchObject({
      equalizer: { preset: "clarity" },
      equalizerOff: true
    });
    act(() => agent.setEqualizerEnabled(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EQUALIZER_RESTART_DEBOUNCE_MS);
    });
    expect(sessionStarts()[2]).toMatchObject({ equalizer: { preset: "clarity" } });
  });

  it("ignores an older relay's five-band offer", async () => {
    await mount({
      default: { preset: "flat" },
      adjustable: true,
      presets: [{ id: "flat", label: "Flat", bands: { bass: 0 } }]
    } as unknown as VoiceEqualizerOptions);
    act(() => agent.setEqualizer({ preset: "flat" }));
    await act(async () => agent.setVoiceGender("male"));
    expect(sessionStarts()).toHaveLength(2);
    expect(sessionStarts().every((event) => !("equalizer" in event))).toBe(true);
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
