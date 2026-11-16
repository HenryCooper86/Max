import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { VisorVisual } from "../src/components/VisorVisual";
import { VisualizerPicker } from "../src/components/VisualizerPicker";
import { DEFAULT_ASSISTANT, resolveAssistant } from "../src/lib/assistant";
import { loadStoredSettings, saveStoredAppearance, saveStoredSettings } from "../src/lib/persistence";
import {
  isVisualizer,
  resolveVisualizer,
  SPECTRUM_BINS,
  spectrumFromAnalyser,
  synthesizeSpectrum,
  updatePeaks,
  VISUALIZERS,
  type SpectrumMode
} from "../src/lib/visualizer";

const MODES: SpectrumMode[] = ["idle", "connecting", "ready", "listening", "thinking", "speaking", "offline"];
const mean = (values: Float32Array) => values.reduce((sum, value) => sum + value, 0) / values.length;
const frame = (mode: SpectrumMode, level: number, t: number) =>
  synthesizeSpectrum(new Float32Array(SPECTRUM_BINS), mode, level, t);

describe("visualiser styles", () => {
  it("knows exactly the five contract ids", () => {
    expect(VISUALIZERS.map((entry) => entry.id)).toEqual(["wave", "bars", "mirror", "dots", "ring"]);
    expect(isVisualizer("bars")).toBe(true);
    expect(isVisualizer("Bars")).toBe(false);
    expect(isVisualizer("matrix")).toBe(false);
    expect(isVisualizer(undefined)).toBe(false);
  });

  it("resolves default → relay → viewer, and ignores the viewer when the owner pinned the look", () => {
    expect(resolveVisualizer({})).toBe("wave");
    expect(resolveVisualizer({ relay: "ring" })).toBe("ring");
    expect(resolveVisualizer({ relay: "ring", viewer: "dots" })).toBe("dots");
    expect(resolveVisualizer({ relay: "ring", viewer: "dots", templateSwitching: false })).toBe("ring");
    expect(resolveVisualizer({ relay: "laser", viewer: "plasma" })).toBe("wave");
    expect(resolveVisualizer({ relay: "laser", viewer: "mirror" })).toBe("mirror");
  });

  it("carries only a known style through resolveAssistant", () => {
    const base = { ...DEFAULT_ASSISTANT, languages: [] };
    expect(resolveAssistant({ ...base, visualizer: "mirror" }).visualizer).toBe("mirror");
    expect(resolveAssistant({ ...base, visualizer: "laser" as never })).not.toHaveProperty("visualizer");
  });

  it("remembers the viewer's style across the voice session's settings writes", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
      }
    });
    saveStoredAppearance({ visualizer: "dots", template: "holo" });
    saveStoredSettings({ voiceGender: "male" });
    expect(loadStoredSettings()).toMatchObject({ visualizer: "dots", template: "holo", voiceGender: "male" });
    values.set("max.settings.v1", JSON.stringify({ visualizer: "laser" }));
    expect(loadStoredSettings()).not.toHaveProperty("visualizer");
  });

  afterEach(() => vi.unstubAllGlobals());
});

describe("synthesised spectrum", () => {
  it("stays within 0…1 for every state, level and time", () => {
    for (const mode of MODES) {
      for (const level of [-1, 0, 0.3, 1, 5, Number.NaN]) {
        for (let t = 0; t < 20; t += 0.37) {
          for (const value of frame(mode, level, t)) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("depends on the state: speaking is full, idle breathes low, offline is flat", () => {
    const average = (mode: SpectrumMode, level = 0) => {
      let total = 0;
      for (let t = 0; t < 4; t += 0.1) total += mean(frame(mode, level, t));
      return total / 40;
    };
    expect(average("speaking")).toBeGreaterThan(average("ready") * 2);
    expect(average("ready")).toBeGreaterThan(average("idle"));
    expect(average("idle")).toBeLessThan(0.12);
    expect(new Set(frame("offline", 1, 3))).toEqual(new Set([Math.fround(0.02)]));
  });

  it("follows the microphone level while listening", () => {
    expect(mean(frame("listening", 0.4, 2))).toBeGreaterThan(mean(frame("listening", 0, 2)) * 2);
  });

  it("sweeps across the lens while connecting", () => {
    const loudest = (values: Float32Array) => values.indexOf(Math.max(...values));
    expect(loudest(frame("connecting", 0, 0.5))).toBeLessThan(loudest(frame("connecting", 0, 1.4)));
  });

  it("lets peak caps jump up and fall back slowly", () => {
    const peaks = new Float32Array([0.2, 0.9]);
    updatePeaks(peaks, new Float32Array([0.5, 0.1]), 0.5);
    expect(peaks[0]).toBeCloseTo(0.5);
    expect(peaks[1]).toBeCloseTo(0.9 - 0.275);
  });

  it("folds analyser data into bounded log-spaced bins and reports the loudest", () => {
    const analyser = {
      frequencyBinCount: 256,
      context: { sampleRate: 48_000 },
      getByteFrequencyData: (array: Uint8Array) => array.fill(204)
    };
    const out = new Float32Array(SPECTRUM_BINS);
    const loudest = spectrumFromAnalyser(analyser as never, new Uint8Array(256), out);
    expect(loudest).toBeCloseTo(0.8);
    expect([...out].every((value) => value >= 0 && value <= 1)).toBe(true);
  });
});

describe("voice display rendering", () => {
  const render = (visualizer: (typeof VISUALIZERS)[number]["id"]) =>
    renderToStaticMarkup(
      <VisorVisual connected listening voiceLevel={0.3} turnState="speaking" visualizer={visualizer} />
    );

  it("keeps the original wave by default", () => {
    const html = renderToStaticMarkup(<VisorVisual connected listening voiceLevel={0} turnState="listening" />);
    expect(html).toContain("viz-wave");
    expect(html).toContain("visorWavePrimary");
  });

  it("draws each spectrum style in the same lens", () => {
    expect(render("bars").match(/class="visorCap"/g)).toHaveLength(SPECTRUM_BINS);
    expect(render("mirror")).toContain("visorSpectrum mirror");
    expect(render("dots").match(/<circle/g)!.length).toBeGreaterThanOrEqual(SPECTRUM_BINS * 9);
    expect(render("ring").match(/<line/g)!.length).toBeGreaterThanOrEqual(SPECTRUM_BINS * 2);
    for (const style of ["bars", "mirror", "dots", "ring"] as const) {
      expect(render(style)).not.toContain("visorWavePrimary");
      expect(render(style)).toContain("visorRim");
    }
  });

  it("offers every style in the picker with the active one checked", () => {
    const html = renderToStaticMarkup(
      <LanguageProvider>
        <VisualizerPicker value="dots" onSelect={() => {}} />
      </LanguageProvider>
    );
    expect(html.match(/type="radio"/g)).toHaveLength(5);
    expect(html).toMatch(/checked="" value="dots"/);
  });
});
