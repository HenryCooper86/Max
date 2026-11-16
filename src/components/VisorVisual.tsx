import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { HazardLevel, VoiceVisualizer } from "../../shared/agent";
import {
  ANALYSER_SILENCE,
  SPECTRUM_BINS,
  smoothSpectrum,
  spectrumFromAnalyser,
  synthesizeSpectrum,
  updatePeaks,
  type SpectrumMode
} from "../lib/visualizer";
import { deviceCopyKey } from "../lib/i18n";
import { useAssistant } from "./AssistantContext";
import { useLanguage } from "./LanguageToggle";

/** Conversational state of the hands-free session, driven by server events. */
export type TurnState = "idle" | "listening" | "hearing" | "thinking" | "speaking";

/** Session lifecycle while no relay session is up: never started, or starting. */
type SessionPhase = "inactive" | "starting";

type Props = {
  connected: boolean;
  listening: boolean;
  /** Live microphone level, 0–1, already quantised by useMicCapture. */
  voiceLevel: number;
  turnState: TurnState;
  /** Fused ride/weather/ADAS hazard; recolours the rim when above normal. */
  hazardLevel?: HazardLevel;
  /** Distinguishes a session that was never started (calm idle) and one that
   *  is being set up (scanning) from a session that dropped (offline). */
  sessionState?: SessionPhase;
  /** Drawing style; "wave" (the default) is the original line. */
  visualizer?: VoiceVisualizer;
  /** Live spectrum taps, when the app has them (see useHelmetAgent). */
  getAnalyser?: (source: "mic" | "playback") => AnalyserNode | null;
};

/** What the lens is showing. One mode at a time; each has its own motion. */
type VisorMode = "idle" | "connecting" | "ready" | "listening" | "thinking" | "speaking" | "offline";

function visorMode({ connected, listening, turnState, sessionState }: Props): VisorMode {
  if (!connected) {
    if (sessionState === "starting") return "connecting";
    if (sessionState === "inactive") return "idle";
    return "offline";
  }
  if (turnState === "thinking") return "thinking";
  if (turnState === "speaking") return "speaking";
  if (listening && (turnState === "listening" || turnState === "hearing")) return "listening";
  return "ready";
}

// Lens geometry, in a 480×200 viewBox: a 2.4:1 capsule with a 1px rim and an
// inner lens inset by 8 units. The waveform is drawn twice as wide as the lens
// and slid left by exactly one period, so the loop is seamless.
const W = 480;
const H = 200;
const MID = H / 2;
const PERIOD = 120;

function wavePath(period: number, amplitude: number, harmonic = 0): string {
  const points: string[] = [];
  for (let x = -period; x <= W + period * 2; x += 4) {
    const phase = (x / period) * Math.PI * 2;
    const y = MID - amplitude * (Math.sin(phase) * (1 - harmonic) + Math.sin(phase * 2 + 0.6) * harmonic);
    points.push(`${x === -period ? "M" : "L"}${x} ${y.toFixed(2)}`);
  }
  return points.join("");
}

const PRIMARY_WAVE = wavePath(PERIOD, 46, 0.32);
const SECONDARY_WAVE = wavePath(PERIOD / 2, 26, 0.18);
const TICKS = Array.from({ length: 17 }, (_, i) => 48 + i * 24);

function amplitudeFor(mode: VisorMode, voiceLevel: number): number {
  switch (mode) {
    case "listening":
      return Math.min(1, 0.16 + Math.max(0, voiceLevel) * 2.4);
    case "speaking":
      return 1;
    case "ready":
      return 0.12;
    case "idle":
      return 0.1;
    default:
      return 0.02;
  }
}

// Spectrum geometry inside the lens (the capsule's round ends are left
// clear): 24 columns 12 units apart between x = 96 and 384.
const SPECTRUM_LEFT = 96;
const SPECTRUM_STEP = 12;
const BAR_WIDTH = 8;
const BAR_BASE = 152;
const BAR_MAX = 106;
const MIRROR_HALF = 66;
const DOT_ROWS = 9;
const DOT_STEP = 12;
const RING_SPOKES = SPECTRUM_BINS * 2;
const RING_INNER = 36;
const RING_REACH = 46;
const columnX = (index: number) => SPECTRUM_LEFT + index * SPECTRUM_STEP + (SPECTRUM_STEP - BAR_WIDTH) / 2;
const spokeAngle = (index: number) => (index / RING_SPOKES) * Math.PI * 2 - Math.PI / 2;
/** Spokes mirror the bins left/right so low frequencies sit at the top. */
const spokeBin = (index: number) => (index < SPECTRUM_BINS ? index : RING_SPOKES - 1 - index);
const BINS = Array.from({ length: SPECTRUM_BINS }, (_, index) => index);
const DOT_ROW_INDEXES = Array.from({ length: DOT_ROWS }, (_, row) => row);
const SPOKES = Array.from({ length: RING_SPOKES }, (_, index) => index);

type SpectrumNodes = {
  bars: (SVGRectElement | null)[];
  caps: (SVGRectElement | null)[];
  dots: (SVGCircleElement | null)[];
  spokes: (SVGLineElement | null)[];
  core: SVGCircleElement | null;
};

/** Write one frame of `values` (and peak caps) onto the style's elements. */
function drawSpectrum(style: VoiceVisualizer, nodes: SpectrumNodes, values: Float32Array, peaks: Float32Array) {
  for (let i = 0; i < SPECTRUM_BINS; i += 1) {
    const value = values[i] ?? 0;
    if (style === "bars") {
      const height = Math.max(2, value * BAR_MAX);
      nodes.bars[i]?.setAttribute("y", (BAR_BASE - height).toFixed(1));
      nodes.bars[i]?.setAttribute("height", height.toFixed(1));
      nodes.caps[i]?.setAttribute("y", (BAR_BASE - Math.max(2, (peaks[i] ?? 0) * BAR_MAX) - 6).toFixed(1));
    } else if (style === "mirror") {
      const half = Math.max(1, value * MIRROR_HALF);
      nodes.bars[i]?.setAttribute("y", (MID - half).toFixed(1));
      nodes.bars[i]?.setAttribute("height", (half * 2).toFixed(1));
    } else if (style === "dots") {
      const lit = Math.round(value * DOT_ROWS);
      const peak = Math.min(DOT_ROWS - 1, Math.round((peaks[i] ?? 0) * DOT_ROWS) - 1);
      for (let row = 0; row < DOT_ROWS; row += 1) {
        const dot = nodes.dots[i * DOT_ROWS + row];
        dot?.setAttribute("opacity", row < lit ? "1" : row === peak ? "0.7" : "0.14");
      }
    }
  }
  if (style === "ring") {
    let sum = 0;
    for (let k = 0; k < RING_SPOKES; k += 1) {
      const value = values[spokeBin(k)] ?? 0;
      sum += value;
      const angle = spokeAngle(k);
      const outer = RING_INNER + 4 + value * RING_REACH;
      nodes.spokes[k]?.setAttribute("x2", (W / 2 + Math.cos(angle) * outer).toFixed(1));
      nodes.spokes[k]?.setAttribute("y2", (MID + Math.sin(angle) * outer).toFixed(1));
    }
    nodes.core?.setAttribute("r", (RING_INNER - 10 + (sum / RING_SPOKES) * 10).toFixed(1));
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** The analyser to read for a mode: the assistant while it speaks, the
 *  wearer while listening; none otherwise. */
function analyserSource(mode: SpectrumMode): "mic" | "playback" | null {
  if (mode === "speaking") return "playback";
  if (mode === "listening") return "mic";
  return null;
}

/** Bars, mirror, dots and ring: one requestAnimationFrame loop that reads a
 *  live analyser when it has sound and synthesises a spectrum otherwise. It
 *  pauses while the tab is hidden and, with reduced motion, draws a single
 *  representative frame per state instead of animating. */
function SpectrumLayer({
  style,
  mode,
  voiceLevel,
  getAnalyser
}: {
  style: Exclude<VoiceVisualizer, "wave">;
  mode: SpectrumMode;
  voiceLevel: number;
  getAnalyser?: Props["getAnalyser"];
}) {
  const nodes = useRef<SpectrumNodes>({ bars: [], caps: [], dots: [], spokes: [], core: null });
  const live = useRef({ mode, voiceLevel, getAnalyser });
  useEffect(() => {
    live.current = { mode, voiceLevel, getAnalyser };
  });
  const [reducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    const target = new Float32Array(SPECTRUM_BINS);
    const display = new Float32Array(SPECTRUM_BINS);
    const peaks = new Float32Array(SPECTRUM_BINS);
    if (reducedMotion) {
      synthesizeSpectrum(target, mode, voiceLevel, 1.2);
      drawSpectrum(style, nodes.current, target, target);
      return;
    }
    let scratch: Uint8Array<ArrayBuffer> | null = null;
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      const { mode: current, voiceLevel: level, getAnalyser: tap } = live.current;
      const source = analyserSource(current);
      const analyser = source ? (tap?.(source) ?? null) : null;
      let heard = false;
      if (analyser) {
        if (!scratch || scratch.length !== analyser.frequencyBinCount) {
          scratch = new Uint8Array(analyser.frequencyBinCount);
        }
        heard = spectrumFromAnalyser(analyser, scratch, target) >= ANALYSER_SILENCE;
      }
      if (!heard) synthesizeSpectrum(target, current, level, now / 1000);
      smoothSpectrum(display, target, dt);
      updatePeaks(peaks, display, dt);
      drawSpectrum(style, nodes.current, display, peaks);
      frame = window.requestAnimationFrame(tick);
    };
    const start = () => {
      if (frame || document.hidden) return;
      last = 0;
      frame = window.requestAnimationFrame(tick);
    };
    const stop = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // The loop reads mode and level from `live`; only a reduced-motion
    // frame is redrawn per state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style, reducedMotion, ...(reducedMotion ? [mode, voiceLevel] : [])]);

  const set =
    <T,>(list: (T | null)[], index: number) =>
    (element: T | null) => {
      list[index] = element;
    };

  if (style === "ring") {
    return (
      <g className="visorSpectrum ring">
        <circle
          className="visorRingCore"
          cx={W / 2}
          cy={MID}
          r={RING_INNER - 10}
          ref={(element) => {
            nodes.current.core = element;
          }}
        />
        {SPOKES.map((k) => {
          const angle = spokeAngle(k);
          return (
            <line
              key={k}
              ref={set(nodes.current.spokes, k)}
              x1={W / 2 + Math.cos(angle) * RING_INNER}
              y1={MID + Math.sin(angle) * RING_INNER}
              x2={W / 2 + Math.cos(angle) * (RING_INNER + 4)}
              y2={MID + Math.sin(angle) * (RING_INNER + 4)}
            />
          );
        })}
      </g>
    );
  }
  if (style === "dots") {
    return (
      <g className="visorSpectrum dots">
        {BINS.flatMap((i) =>
          DOT_ROW_INDEXES.map((row) => (
            <circle
              key={`${i}-${row}`}
              ref={set(nodes.current.dots, i * DOT_ROWS + row)}
              cx={columnX(i) + BAR_WIDTH / 2}
              cy={BAR_BASE - 4 - row * DOT_STEP}
              r="3.6"
              opacity="0.14"
            />
          ))
        )}
      </g>
    );
  }
  return (
    <g className={`visorSpectrum ${style}`}>
      {BINS.map((i) => (
        <rect
          key={i}
          ref={set(nodes.current.bars, i)}
          x={columnX(i)}
          width={BAR_WIDTH}
          y={style === "mirror" ? MID - 1 : BAR_BASE - 2}
          height={2}
          rx="2"
        />
      ))}
      {style === "bars"
        ? BINS.map((i) => (
            <rect
              key={`cap-${i}`}
              className="visorCap"
              ref={set(nodes.current.caps, i)}
              x={columnX(i)}
              width={BAR_WIDTH}
              y={BAR_BASE - 8}
              height="3"
              rx="1.5"
            />
          ))
        : null}
    </g>
  );
}

/** The Visor: a wide lens whose waveform is the assistant's live state. It is
 *  also the product mark, so it stays device-agnostic — the same lens reads as
 *  a helmet visor or a pair of glasses. The waveform can be drawn in several
 *  styles (wave, bars, mirror, dots, ring); all react to the same states. */
export function VisorVisual(props: Props) {
  const { connected, voiceLevel, hazardLevel = "normal", visualizer = "wave", getAnalyser } = props;
  const id = useId().replace(/:/g, "");
  const mode = visorMode(props);
  const hazard = connected && hazardLevel !== "normal" ? hazardLevel : null;
  const style = { "--visor-amp": amplitudeFor(mode, voiceLevel) } as CSSProperties;

  return (
    <div
      className={`visorStage ${mode} viz-${visualizer}${hazard ? ` hazard-${hazard}` : ""}`}
      style={style}
      aria-hidden="true"
    >
      <svg className="visorSvg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <clipPath id={`${id}-lens`}>
            <rect x="9" y="9" width={W - 18} height={H - 18} rx={(H - 18) / 2} />
          </clipPath>
          <linearGradient id={`${id}-scan`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="currentColor" stopOpacity="0" />
            <stop offset="0.7" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        <rect className="visorRim" x="1.5" y="1.5" width={W - 3} height={H - 3} rx={(H - 3) / 2} />
        <rect className="visorLens" x="9" y="9" width={W - 18} height={H - 18} rx={(H - 18) / 2} />
        <g clipPath={`url(#${id}-lens)`}>
          <g className="visorTicks">
            {TICKS.map((x) => (
              <line key={x} x1={x} x2={x} y1={H - 30} y2={H - (x === W / 2 ? 42 : 36)} />
            ))}
          </g>
          {visualizer === "wave" || visualizer === "mirror" ? (
            <line className="visorBaseline" x1="0" x2={W} y1={MID} y2={MID} />
          ) : null}
          {visualizer === "wave" ? (
            <g className="visorWave">
              <g className="visorWaveTrack slow">
                <path className="visorWaveSecondary" d={SECONDARY_WAVE} />
              </g>
              <g className="visorWaveTrack">
                <path className="visorWavePrimary" d={PRIMARY_WAVE} />
              </g>
            </g>
          ) : (
            <SpectrumLayer style={visualizer} mode={mode} voiceLevel={voiceLevel} getAnalyser={getAnalyser} />
          )}
          <g className="visorScan">
            <rect x="-140" y="0" width="140" height={H} fill={`url(#${id}-scan)`} />
            <line x1="-1" x2="-1" y1="0" y2={H} />
          </g>
          <g className="visorDots">
            <circle cx={W / 2 - 30} cy={MID} r="8" />
            <circle cx={W / 2} cy={MID} r="8" />
            <circle cx={W / 2 + 30} cy={MID} r="8" />
          </g>
        </g>
        <g className="visorFault">
          <line x1="58" x2="58" y1={MID - 22} y2={MID + 22} />
        </g>
      </svg>
    </div>
  );
}

/** A small, static rendering of the lens for headers and the sign-in card. */
function VisorMark({ className = "" }: { className?: string }) {
  return (
    <svg className={`visorMark ${className}`.trim()} viewBox="0 0 48 20" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="46" height="18" rx="9" />
      <path d="M9 10h6l3-5 4 10 4-8 3 3h10" />
    </svg>
  );
}

/** The assistant's mark wherever the brand appears (header, settings card,
 *  sign-in, workspaces): the owner's logo from the relay when it has one,
 *  otherwise — or if that image fails to load — the built-in Visor mark.
 *  `className` names the slot so each can size the logo for itself. */
export function BrandMark({ className = "" }: { className?: string }) {
  const { logoUrl } = useAssistant();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!logoUrl || failedUrl === logoUrl) return <VisorMark className={className} />;
  return (
    <img
      className={`brandLogo ${className}`.trim()}
      src={logoUrl}
      alt=""
      decoding="async"
      draggable={false}
      onError={() => setFailedUrl(logoUrl)}
    />
  );
}

/** The text under the Visor: a greeting before the session starts, then the
 *  live state with one line of guidance. */
export function VoiceStateReadout({
  connected,
  turnState,
  hazardLevel = "normal",
  sessionState
}: Pick<Props, "connected" | "turnState" | "hazardLevel" | "sessionState">) {
  const { t } = useLanguage();
  const assistant = useAssistant();
  const name = assistant.name;

  if (!connected && sessionState) {
    const starting = sessionState === "starting";
    return (
      <div className={`voiceReadout ${starting ? "starting" : "welcome"}`} aria-live="polite">
        {/* Keyed by what they say, so a new line arrives instead of swapping in place. */}
        <h1 key={starting ? "starting" : "welcome"} className="voiceReadoutState">
          {starting ? t("voice.connecting") : t("voice.welcome", { name })}
        </h1>
        <p key={starting ? "starting-hint" : "welcome-hint"} className="voiceReadoutHint">
          {starting ? t("voice.setupHint") : t(deviceCopyKey("voice.startHint", assistant.device))}
        </p>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="voiceReadout offline" aria-live="polite">
        <h1 className="voiceReadoutState">{t("voice.offline")}</h1>
        <p className="voiceReadoutHint">{t("voice.offlineHint")}</p>
      </div>
    );
  }

  const hazard = hazardLevel !== "normal" ? hazardLevel : null;
  const stateCaption = t(`voice.state.${turnState}`, { name });
  const caption = hazard ? `${t(`voice.hazard.${hazard}`)} · ${stateCaption}` : stateCaption;
  const hint =
    turnState === "thinking" || turnState === "speaking"
      ? t("voice.interruptHint")
      : assistant.wakeWordEnabled
        ? t("voice.wakeHint", { wake: assistant.wakePhrase })
        : t("voice.openMicHint");

  return (
    <div className={`voiceReadout ${hazard ? `hazard-${hazard}` : turnState}`} aria-live="polite">
      <h1 key={caption} className="voiceReadoutState">
        {caption}
      </h1>
      <p key={hint} className="voiceReadoutHint">
        {hint}
      </p>
    </div>
  );
}
