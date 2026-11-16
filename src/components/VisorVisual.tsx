import { useId, useState, type CSSProperties } from "react";
import type { HazardLevel } from "../../shared/agent";
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

/** The Visor: a wide lens whose waveform is the assistant's live state. It is
 *  also the product mark, so it stays device-agnostic — the same lens reads as
 *  a helmet visor or a pair of glasses. */
export function VisorVisual(props: Props) {
  const { connected, voiceLevel, hazardLevel = "normal" } = props;
  const id = useId().replace(/:/g, "");
  const mode = visorMode(props);
  const hazard = connected && hazardLevel !== "normal" ? hazardLevel : null;
  const style = { "--visor-amp": amplitudeFor(mode, voiceLevel) } as CSSProperties;

  return (
    <div className={`visorStage ${mode}${hazard ? ` hazard-${hazard}` : ""}`} style={style} aria-hidden="true">
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
          <line className="visorBaseline" x1="0" x2={W} y1={MID} y2={MID} />
          <g className="visorWave">
            <g className="visorWaveTrack slow">
              <path className="visorWaveSecondary" d={SECONDARY_WAVE} />
            </g>
            <g className="visorWaveTrack">
              <path className="visorWavePrimary" d={PRIMARY_WAVE} />
            </g>
          </g>
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
        <h1 className="voiceReadoutState">{starting ? t("voice.connecting") : t("voice.welcome", { name })}</h1>
        <p className="voiceReadoutHint">
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
      <h1 className="voiceReadoutState">{caption}</h1>
      <p className="voiceReadoutHint">{hint}</p>
    </div>
  );
}
