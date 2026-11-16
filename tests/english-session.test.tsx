import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdasDirection } from "../shared/adas";
import { ADAS_SCENARIOS } from "../shared/adas";
import type { NavRouteEvent } from "../shared/agent";
import { INITIAL_PROGRESS, step } from "../shared/guidance";
import { MOCK_ROUTE } from "../shared/nav-fixtures";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { NavigationPanel } from "../src/components/NavigationPanel";
import { useAudioPlayback } from "../src/hooks/useAudioPlayback";
import { createTranslator } from "../src/lib/i18n";
import { createNavigationController, displayInstruction, NAVIGATION_COPY } from "../src/lib/navigation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const englishRoute: NavRouteEvent = {
  type: "nav.route",
  commandId: "t",
  destinationName: "外滩",
  destination: MOCK_ROUTE.polyline.at(-1)!,
  distanceMeters: MOCK_ROUTE.distanceMeters,
  etaSeconds: MOCK_ROUTE.etaSeconds,
  polyline: MOCK_ROUTE.polyline,
  steps: MOCK_ROUTE.steps.map((maneuver, index) => ({
    ...maneuver,
    localizedInstruction: index === 0 ? "Turn right onto 南京东路" : "You have arrived"
  }))
};

describe("routes in the session's language", () => {
  it("shows the localized instruction when the route carries one, else the original", () => {
    expect(
      displayInstruction({ instruction: "右转进入南京东路", localizedInstruction: "Turn right onto 南京东路" })
    ).toBe("Turn right onto 南京东路");
    expect(displayInstruction({ instruction: "右转进入南京东路" })).toBe("右转进入南京东路");
    expect(displayInstruction(undefined)).toBeNull();
  });

  it("puts the English instruction on the panel and in the step list", async () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "en-US" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ key: null }) }));
    const position = MOCK_ROUTE.polyline[0]!;
    const update = step(position, englishRoute, INITIAL_PROGRESS);
    await act(async () => {
      renderer = create(
        <LanguageProvider>
          <NavigationPanel state={{ phase: "guiding", route: englishRoute, update, position }} />
        </LanguageProvider>
      );
    });
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("Turn right onto 南京东路");
    expect(text).not.toContain("右转进入南京东路");
  });

  it("words the controller's own lines in the session's language", () => {
    let language: "zh" | "en" = "en";
    const sent: Array<Record<string, unknown>> = [];
    const states: Array<{ phase: string; message?: string }> = [];
    const controller = createNavigationController({
      sendJson: (payload) => sent.push(payload as Record<string, unknown>),
      onState: (state) => states.push(state as { phase: string; message?: string }),
      hasLocationPermission: () => false,
      language: () => language
    });
    controller.handleDeviceCommand({ commandId: "a", action: "navigation.start", args: { query: "外滩" } });
    expect(states.at(-1)).toEqual({ phase: "unavailable", message: NAVIGATION_COPY.permission.en });
    language = "zh";
    controller.reset();
    controller.handleDeviceCommand({ commandId: "b", action: "navigation.start", args: { query: "外滩" } });
    expect(states.at(-1)).toEqual({ phase: "unavailable", message: NAVIGATION_COPY.permission.zh });
    expect(NAVIGATION_COPY.rerouteFailed.en).toBe("I couldn't find a new route. Navigation has stopped.");
  });
});

describe("hazard direction chip", () => {
  it("has a label for every direction in both languages", () => {
    const directions: AdasDirection[] = ["front", "rear", "left", "right", "left_rear", "right_rear"];
    const en = createTranslator("en-US");
    const zh = createTranslator("zh-CN");
    expect(directions.map((direction) => en(`hazard.direction.${direction}`))).toEqual([
      "Ahead",
      "Behind",
      "Left",
      "Right",
      "Left rear",
      "Right rear"
    ]);
    expect(directions.map((direction) => zh(`hazard.direction.${direction}`))).toEqual([
      "前方",
      "后方",
      "左侧",
      "右侧",
      "左后方",
      "右后方"
    ]);
  });
});

// ---- Speech ----------------------------------------------------------------

class Source {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}
class Context {
  state = "running";
  currentTime = 10;
  destination = {};
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createBufferSource() {
    return new Source();
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { length, sampleRate, duration: length / sampleRate, getChannelData: () => new Float32Array(length) };
  }
  decodeAudioData = vi.fn(async () => this.createBuffer(1, 72000, 24000));
  createGain() {
    return { context: this, gain: { value: 1 }, connect: vi.fn() };
  }
  createDynamicsCompressor() {
    return {
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      connect: vi.fn()
    };
  }
  createAnalyser() {
    return { fftSize: 0, smoothingTimeConstant: 0, minDecibels: 0, maxDecibels: 0 };
  }
}

type Utterance = { text: string; lang?: string; onend?: () => void };

function setup(withSpeech = true) {
  const spoken: Utterance[] = [];
  const speech = {
    speaking: false,
    cancel: vi.fn(),
    speak: vi.fn((utterance: Utterance) => spoken.push(utterance)),
    getVoices: () => []
  };
  vi.stubGlobal("window", withSpeech ? { speechSynthesis: speech } : {});
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      lang = "";
      constructor(public text: string) {}
    }
  );
  vi.stubGlobal("AudioContext", Context);
  const fetchClip = vi.fn(async (url: string) => ({
    ok: true,
    arrayBuffer: async () => {
      const bytes = readFileSync(`public${new URL(String(url), "https://max.example").pathname}`);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  }));
  vi.stubGlobal("fetch", fetchClip);
  let playback!: ReturnType<typeof useAudioPlayback>;
  function Probe() {
    playback = useAudioPlayback({
      voiceGenderRef: { current: "female" },
      transmittingRef: { current: true },
      onInterrupted: vi.fn()
    });
    return null;
  }
  act(() => {
    renderer = create(createElement(Probe));
  });
  return { playback, speech, spoken, fetchClip };
}

const chineseWarning = `${ADAS_SCENARIOS[0].message} ${ADAS_SCENARIOS[0].advice}`;
const englishWarning = "Vehicle closing fast behind. Hold your lane and avoid hard braking.";

describe("spoken safety warnings", () => {
  it("speaks the English wording with an en-US voice in an English session, instead of the clip", async () => {
    const { playback, spoken, fetchClip } = setup();
    await playback.ensurePlaybackContext();
    fetchClip.mockClear();
    expect(await playback.speakWarning(englishWarning, { language: "en" })).toBe("spoken");
    expect(spoken).toEqual([expect.objectContaining({ text: englishWarning, lang: "en-US" })]);
    expect(fetchClip).not.toHaveBeenCalled();
  });

  it("holds an ordinary reply until the English warning has been spoken", async () => {
    const { playback, spoken } = setup();
    await playback.ensurePlaybackContext();
    await playback.speakWarning(englishWarning, { language: "en" });
    playback.speak("Sure, here is the weather.");
    expect(spoken).toHaveLength(1);
    act(() => spoken[0]!.onend?.());
    expect(spoken.map((utterance) => utterance.text)).toEqual([englishWarning, "Sure, here is the weather."]);
  });

  it("keeps the recorded Chinese clip for a Chinese session, exactly as before", async () => {
    const { playback, spoken } = setup();
    await playback.ensurePlaybackContext();
    expect(await playback.speakWarning(chineseWarning, { language: "zh" })).toBe("scheduled");
    expect(await playback.speakWarning(chineseWarning)).toBe("scheduled");
    expect(spoken).toHaveLength(0);
  });

  it("falls back to the clip when the browser cannot speak", async () => {
    const { playback } = setup(false);
    await playback.ensurePlaybackContext();
    expect(await playback.speakWarning(chineseWarning, { language: "en" })).toBe("scheduled");
  });
});

describe("browser speech picks the language from the text", () => {
  it("uses zh-CN for Han text and en-US otherwise", () => {
    const { playback, spoken } = setup();
    playback.speak("你好，我是 Max。");
    playback.speak("Hello, I'm Max.");
    expect(spoken.map((utterance) => utterance.lang)).toEqual(["zh-CN", "en-US"]);
  });
});
