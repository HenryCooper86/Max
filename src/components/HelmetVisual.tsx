import type { CSSProperties } from "react";
import type { HazardLevel } from "../../shared/agent";
import { useLanguage } from "./LanguageToggle";

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
  hazardLevel = "normal",
  sessionState
}: Pick<Props, "connected" | "turnState" | "hazardLevel"> & { sessionState?: "inactive" | "starting" }) {
  const { t } = useLanguage();
  if (!connected && sessionState) {
    return (
      <div className="voiceReadout sessionGuidance" aria-live="polite">
        <div className="voiceReadoutState">
          {sessionState === "starting" ? t("voice.connecting") : t("voice.welcome")}
        </div>
        <div className="voiceReadoutHint">
          {sessionState === "starting" ? t("voice.setupHint") : t("voice.startHint")}
        </div>
      </div>
    );
  }
  const hazard = connected && hazardLevel !== "normal" ? hazardLevel : null;
  const stateCaption = t(
    `voice.state.${turnState}` as
      | "voice.state.idle"
      | "voice.state.listening"
      | "voice.state.hearing"
      | "voice.state.thinking"
      | "voice.state.speaking"
  );
  const caption = !connected
    ? t("voice.offline")
    : hazard
      ? `${t(`voice.hazard.${hazard}` as "voice.hazard.caution" | "voice.hazard.critical")} · ${stateCaption}`
      : stateCaption;
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
          {/* State glow — the visor lights with the ring colour while Max is
              live, in place of a separate on-visor visualizer (the gauge bezel
              now carries the live mic signal). Matches the iOS/Android visor. */}
          <path
            className="visorGlow"
            fill="var(--ring)"
            d="M155 88h155c22 0 40 18 40 40v13c-48 18-106 25-178 21-27-1-49-24-49-51 0-13 11-23 32-23Z"
          />
          <ellipse className="visorGlare" cx="206" cy="106" rx="58" ry="11" />
          {/* Crisp specular streak across the upper visor for a glassy read. */}
          <ellipse className="visorSpec" cx="190" cy="99" rx="44" ry="3.4" />
          <circle className="micDot" cx="258" cy="205" r="9" />
          <circle className="greenDot" cx="282" cy="205" r="9" />
        </svg>
      </div>
    </div>
  );
}
