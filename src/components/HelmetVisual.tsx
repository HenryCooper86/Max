import type { HazardLevel } from "../../shared/agent";

/** Conversational state of the hands-free session, driven by server events. */
export type TurnState = "idle" | "listening" | "hearing" | "thinking" | "speaking";

type Props = {
  connected: boolean;
  listening: boolean;
  voiceLevel: number;
  turnState: TurnState;
  /** Fused ride/weather/ADAS hazard; tints the ring when above normal. */
  hazardLevel?: HazardLevel;
};

// Relative heights of the on-visor voice bars.
const BARS = [0.42, 0.78, 0.56, 0.94, 0.68, 0.84, 0.48, 0.72, 0.6];

const CAPTIONS: Record<TurnState, string> = {
  idle: "待机",
  listening: "免提待命 · 请讲话",
  hearing: "正在聆听…",
  thinking: "Max 思考中…",
  speaking: "Max 回答中"
};

// Maps each turn state to a helmet ring palette (see .helmetStage.* in styles).
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

/** Cinematic helmet centerpiece: gradient shell, animated state reticle, and
 *  an on-visor voice visualizer driven by the live mic level. */
export function HelmetVisual({ connected, listening, voiceLevel, turnState, hazardLevel = "normal" }: Props) {
  const stateClass = connected ? RING_CLASS[turnState] : "offline";
  // The fused hazard overrides the conversational palette: a rider glancing at
  // the helmet must see danger first, turn state second.
  const hazardClass = connected && hazardLevel !== "normal" ? `hazard-${hazardLevel}` : "";
  const caption = !connected
    ? "离线"
    : hazardLevel !== "normal"
      ? `${HAZARD_CAPTIONS[hazardLevel]} · ${CAPTIONS[turnState]}`
      : CAPTIONS[turnState];

  return (
    <div className={`helmetStage ${stateClass} ${hazardClass}`}>
      <div className="hudFrame" aria-hidden="true">
        <span className="corner tl" />
        <span className="corner tr" />
        <span className="corner bl" />
        <span className="corner br" />
      </div>
      <div className="reticle" aria-hidden="true" />

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

        <div className={`visorVisualizer ${listening ? "active" : ""}`}>
          {BARS.map((weight, index) => {
            const scale = listening ? Math.max(0.14, Math.min(1, voiceLevel * weight + 0.1)) : 0.14;
            return <span key={weight + index} style={{ transform: `scaleY(${scale})` }} />;
          })}
        </div>
      </div>

      <div className="helmetCaption">
        <span className="captionDot" />
        {caption}
      </div>
    </div>
  );
}
