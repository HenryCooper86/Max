import type { CSSProperties } from "react";
import type { HazardLevel } from "../../shared/agent";

/** Conversational state of the hands-free session, driven by server events. */
export type TurnState = "idle" | "listening" | "hearing" | "thinking" | "speaking";

type Props = {
  connected: boolean;
  listening: boolean;
  voiceLevel: number;
  turnState: TurnState;
  /** Fused ride/weather/ADAS hazard; tints the gauge when above normal. */
  hazardLevel?: HazardLevel;
};

// On-visor waveform: many thin bars whose amplitudes follow a bell envelope
// with a deterministic ripple, so the line reads as an organic sound wave
// rather than a row of LED segments. While Max speaks a CSS animation runs a
// travelling wave through them (see .visorVisualizer.speaking); while the
// rider talks the bars are driven live by the mic level.
const BAR_COUNT = 27;
const BAR_AMPS = Array.from({ length: BAR_COUNT }, (_, index) => {
  const t = index / (BAR_COUNT - 1);
  const bell = Math.exp(-((t - 0.5) ** 2) / 0.09);
  const ripple = 0.16 * Math.sin(index * 2.1);
  return Math.max(0.18, Math.min(1, 0.28 + 0.72 * bell + ripple));
});

// Instrument bezel: a 270° tick ring (gap at the bottom, like a tachometer)
// wrapped around the helmet. Its luminous arc IS the state gauge — how far it
// fills, and in what colour, reads the session state at a glance. Ticks are
// laid out in a 400×400 SVG so the whole ring scales with the stage.
const TICK_COUNT = 60;
const GAUGE_START = -135; // degrees from top (12 o'clock)
const GAUGE_SWEEP = 270;
const GAUGE_R = 176;
const TICKS = Array.from({ length: TICK_COUNT }, (_, i) => {
  const t = i / (TICK_COUNT - 1);
  const angle = GAUGE_START + t * GAUGE_SWEEP;
  const major = i % 6 === 0;
  const len = major ? 15 : 9;
  return { i, angle, major, y1: 200 - GAUGE_R, y2: 200 - (GAUGE_R - len) };
});

/** Drive mode for the gauge arc — mirrors the visor waveform's modes so the two
 *  instruments always agree on what Max is doing. */
type GaugeMode = "offline" | "idle" | "mic" | "thinking" | "speaking" | "hazard";

/** How many ticks light up. `mic`/`idle`/`speaking`/`hazard` fill a real arc;
 *  `thinking` lights nothing here (a CSS travelling wave owns those ticks). */
function gaugeLitCount(mode: GaugeMode, voiceLevel: number): number {
  switch (mode) {
    case "idle":
      return 3; // a small "ready" nub at the start of the sweep
    case "mic": {
      const level = Math.max(0, Math.min(1, voiceLevel * 1.7));
      return Math.round((0.08 + level * 0.82) * TICK_COUNT);
    }
    case "speaking":
      return Math.round(0.9 * TICK_COUNT);
    case "hazard":
      return Math.round(0.82 * TICK_COUNT);
    default:
      return 0; // offline, thinking
  }
}

const CAPTIONS: Record<TurnState, string> = {
  idle: "待机",
  listening: "免提待命 · 请讲话",
  hearing: "正在聆听…",
  thinking: "Max 思考中…",
  speaking: "Max 回答中"
};

// Latin telltale shown under the Chinese state word — Space Mono, instrument
// register. Deliberately English: it reads as a gauge label, not primary copy.
const TELLTALE: Record<TurnState, string> = {
  idle: "STANDBY",
  listening: "LISTENING",
  hearing: "HEARING",
  thinking: "THINKING",
  speaking: "SPEAKING"
};

// Maps each turn state to a gauge/ring palette (see .helmetStage.* in styles).
const RING_CLASS: Record<TurnState, string> = {
  idle: "online",
  listening: "listening",
  hearing: "listening",
  thinking: "thinking",
  speaking: "speaking"
};

const HAZARD_CAPTIONS: Record<Exclude<HazardLevel, "normal">, string> = {
  caution: "注意路况",
  critical: "高风险 · 优先安全"
};

const HAZARD_TELLTALE: Record<Exclude<HazardLevel, "normal">, string> = {
  caution: "CAUTION",
  critical: "HAZARD"
};

/** The state readout that sits below the helmet: a large Chinese state word with
 *  a Space Mono Latin telltale beneath it. Rendered as a sibling of the helmet
 *  (not inside the gauge) so it always has room to breathe. */
export function VoiceStateReadout({
  connected,
  turnState,
  hazardLevel = "normal"
}: Pick<Props, "connected" | "turnState" | "hazardLevel">) {
  const hazard = connected && hazardLevel !== "normal" ? hazardLevel : null;
  const caption = !connected
    ? "离线"
    : hazard
      ? `${HAZARD_CAPTIONS[hazard]} · ${CAPTIONS[turnState]}`
      : CAPTIONS[turnState];
  const telltale = !connected ? "OFFLINE" : hazard ? HAZARD_TELLTALE[hazard] : TELLTALE[turnState];
  const stateClass = !connected ? "offline" : hazard ? `hazard-${hazard}` : RING_CLASS[turnState];

  return (
    <div className={`voiceReadout ${stateClass}`} aria-live="polite">
      <div className="voiceReadoutState">{caption}</div>
      <div className="voiceReadoutTell">{telltale}</div>
    </div>
  );
}

/** Cinematic helmet centerpiece: gradient shell, a tick-marked instrument gauge
 *  whose luminous arc reads the session state, and an on-visor voice visualizer
 *  driven by the live mic level. */
export function HelmetVisual({ connected, listening, voiceLevel, turnState, hazardLevel = "normal" }: Props) {
  const stateClass = connected ? RING_CLASS[turnState] : "offline";
  // The fused hazard overrides the conversational palette: a rider glancing at
  // the helmet must see danger first, turn state second.
  const hazardClass = connected && hazardLevel !== "normal" ? `hazard-${hazardLevel}` : "";

  const gaugeMode: GaugeMode = !connected
    ? "offline"
    : hazardLevel !== "normal"
      ? "hazard"
      : turnState === "thinking"
        ? "thinking"
        : turnState === "speaking"
          ? "speaking"
          : listening
            ? "mic"
            : "idle";
  const litCount = gaugeLitCount(gaugeMode, voiceLevel);

  return (
    <div className={`helmetStage ${stateClass} ${hazardClass}`}>
      <svg className={`gaugeBezel ${gaugeMode}`} viewBox="0 0 400 400" aria-hidden="true">
        <circle className="gaugeGuide" cx="200" cy="200" r="182" />
        <circle className="gaugeGuide gaugeGuideInner" cx="200" cy="200" r="140" />
        {TICKS.map(({ i, angle, major, y1, y2 }) => {
          const lit = i < litCount;
          const cls = ["gaugeTick", major ? "major" : "", lit ? "lit" : ""].filter(Boolean).join(" ");
          const style = { "--i": i } as CSSProperties;
          return (
            <line
              key={i}
              className={cls}
              style={style}
              x1="200"
              y1={y1}
              x2="200"
              y2={y2}
              transform={`rotate(${angle} 200 200)`}
            />
          );
        })}
      </svg>

      <div className="helmetVisual" aria-hidden="true">
        <svg viewBox="0 0 420 270" role="img">
          <defs>
            <linearGradient id="shellGrad" x1="0" y1="0" x2="0.25" y2="1">
              <stop offset="0" stopColor="#f6f9f6" />
              <stop offset="0.55" stopColor="#cdd6d1" />
              <stop offset="1" stopColor="#8b9893" />
            </linearGradient>
            <linearGradient id="visorGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#54787e" />
              <stop offset="0.42" stopColor="#22393d" />
              <stop offset="1" stopColor="#0a1a1f" />
            </linearGradient>
            <linearGradient id="chinGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#8b9b97" />
              <stop offset="1" stopColor="#5d6b68" />
            </linearGradient>
            {/* Soft top rim light that gives the shell volume. */}
            <linearGradient id="shellSheen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.5" />
              <stop offset="0.4" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
          </defs>

          <path
            className="helmetShell"
            fill="url(#shellGrad)"
            d="M54 161c4-81 68-132 151-132 93 0 159 61 166 149 2 24-11 45-34 54-45 17-126 26-204 8-50-12-81-39-79-79Z"
          />
          {/* Top rim light — lifts the shell off the background with volume. */}
          <path
            className="shellSheen"
            fill="url(#shellSheen)"
            d="M54 161c4-81 68-132 151-132 93 0 159 61 166 149 2 24-11 45-34 54-45 17-126 26-204 8-50-12-81-39-79-79Z"
          />
          <path
            className="chin"
            fill="url(#chinGrad)"
            d="M220 167c40 4 82 0 126-12-5 28-18 46-40 54-31 11-66 17-103 17 17-17 22-36 17-59Z"
          />
          <path
            className="helmetVisor"
            fill="url(#visorGrad)"
            d="M155 88h155c22 0 40 18 40 40v13c-48 18-106 25-178 21-27-1-49-24-49-51 0-13 11-23 32-23Z"
          />
          <ellipse className="visorGlare" cx="206" cy="106" rx="58" ry="11" />
          {/* Crisp specular streak across the upper visor for a glassy read. */}
          <ellipse className="visorSpec" cx="190" cy="99" rx="44" ry="3.4" />
          <circle className="micDot" cx="258" cy="205" r="9" />
          <circle className="greenDot" cx="282" cy="205" r="9" />
        </svg>

        <VisorWaveform connected={connected} listening={listening} voiceLevel={voiceLevel} turnState={turnState} />
      </div>
    </div>
  );
}

/** The waveform on the visor. Three drive modes: a CSS travelling wave while
 *  Max replies, live mic level while the rider talks, and a low scanning
 *  shimmer while Max thinks; otherwise a calm flat line. */
function VisorWaveform({
  connected,
  listening,
  voiceLevel,
  turnState
}: Pick<Props, "connected" | "listening" | "voiceLevel" | "turnState">) {
  const speaking = connected && turnState === "speaking";
  const thinking = connected && turnState === "thinking";
  const micDriven = listening && !speaking && !thinking;
  const mode = speaking ? "speaking" : thinking ? "thinking" : "";

  return (
    <div className={["visorVisualizer", mode, listening ? "active" : ""].filter(Boolean).join(" ")}>
      {BAR_AMPS.map((amp, index) => {
        const style: CSSProperties = { "--amp": amp, "--i": index } as CSSProperties;
        // Inline transforms only in mic-driven/idle modes — the speaking and
        // thinking waves are CSS animations, which must own the transform.
        if (!speaking && !thinking) {
          const scale = micDriven ? Math.max(0.1, Math.min(1, voiceLevel * 1.7 * amp + 0.07)) : 0.1;
          style.transform = `scaleY(${scale})`;
        }
        return <span key={index} style={style} />;
      })}
    </div>
  );
}
