import { Camera, Flashlight, MusicNotes, NavigationArrow, Phone } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import type { VoiceVisualizer } from "../../../shared/agent";
import { findDevice, deviceLogoUrl } from "../../lib/device-catalog";
import { localized } from "../../lib/i18n";
import { scriptForDevice, useScriptedDemo, type DemoAction, type DemoFrame } from "../../lib/scripted-demo";
import { resolveAppearance, type Appearance } from "../../lib/templates";
import type { ThemeOverrides } from "../../lib/theme-tokens";
import { useLanguage } from "../LanguageToggle";
import { VisorVisual } from "../VisorVisual";

/** The template's tokens as inline custom properties, so a preview can wear
 *  a different look from the page around it. */
function scopedTokens(appearance: Appearance): CSSProperties {
  const style: Record<string, string> = { colorScheme: appearance.template.scheme };
  for (const [name, value] of Object.entries(appearance.tokens)) style[`--${name}`] = value;
  return style as CSSProperties;
}

export type PreviewIdentity = {
  name: string;
  device: string;
  template: string;
  visualizer: VoiceVisualizer;
  accentColor?: string;
  theme?: ThemeOverrides;
  /** The owner's logo, when there is one (an object URL or a relay path). */
  logoUrl?: string;
  wakePhrase?: string;
};

const ACTION_ICONS: Record<DemoAction["kind"], typeof Camera> = {
  navigation: NavigationArrow,
  camera: Camera,
  torch: Flashlight,
  music: MusicNotes,
  call: Phone
};

/** The Visor's props for a frame of the scripted conversation. */
export function visorPropsFor(frame: DemoFrame) {
  const live = frame.phase !== "idle" && frame.phase !== "connecting";
  return {
    connected: live,
    listening: live,
    voiceLevel: frame.level,
    turnState: live ? (frame.phase as Exclude<DemoFrame["phase"], "idle" | "connecting">) : ("idle" as const),
    hazardLevel: frame.hazard ? ("caution" as const) : ("normal" as const),
    sessionState:
      frame.phase === "idle" ? ("inactive" as const) : frame.phase === "connecting" ? ("starting" as const) : undefined
  };
}

/**
 * A scripted session in a scoped copy of the assistant's look: its mark and
 * name, the live Visor in its voice display style, the state line, captions,
 * a safety alert and a device action. No relay, no microphone.
 */
export function AssistantPreview({
  identity,
  playing = true,
  compact = false,
  label
}: {
  identity: PreviewIdentity;
  playing?: boolean;
  compact?: boolean;
  /** Accessible name for the preview region. */
  label?: string;
}) {
  const { language, t } = useLanguage();
  const en = language === "en-US";
  const frame = useScriptedDemo(scriptForDevice(identity.device), playing);
  const appearance = resolveAppearance({
    relayTemplate: identity.template,
    theme: identity.theme,
    accentColor: identity.accentColor
  });
  const device = findDevice(identity.device);
  const name = identity.name.trim() || "Max";
  const logo = identity.logoUrl ?? deviceLogoUrl(device.id);
  const visor = visorPropsFor(frame);
  const state =
    frame.phase === "idle"
      ? localized(language, `你好，我是 ${name}`, `Hi, I'm ${name}`)
      : frame.phase === "connecting"
        ? t("voice.connecting")
        : t(`voice.state.${frame.phase}`, { name });
  const ActionIcon = frame.action ? ACTION_ICONS[frame.action.kind] : null;

  return (
    <div
      className={`assistantPreview${compact ? " compact" : ""}`}
      style={scopedTokens(appearance)}
      data-template={appearance.template.id}
      role="group"
      aria-label={label}
    >
      <div className="previewTopbar">
        <span className="previewBrand">
          {logo ? <img className="previewLogo" src={logo} alt="" /> : null}
          <strong>{name}</strong>
        </span>
        <span className="previewDevice">{en ? device.label.en : device.label.zh}</span>
      </div>
      {frame.hazard ? (
        <div className="previewHazard" role="presentation">
          <span className="previewHazardDir">{en ? frame.hazard.direction.en : frame.hazard.direction.zh}</span>
          <span>
            <strong>{en ? frame.hazard.label.en : frame.hazard.label.zh}</strong>
            <small>{en ? frame.hazard.advice.en : frame.hazard.advice.zh}</small>
          </span>
        </div>
      ) : null}
      <div className="previewLens">
        <VisorVisual {...visor} visualizer={identity.visualizer} />
      </div>
      <p className="previewState">{state}</p>
      {frame.action && ActionIcon ? (
        <p className="previewAction">
          <ActionIcon size={16} weight="bold" aria-hidden="true" />
          {en ? frame.action.label.en : frame.action.label.zh}
        </p>
      ) : null}
      {compact ? null : (
        <ol className="previewCaptions" aria-label={localized(language, "字幕", "Captions")}>
          {frame.captions.map((caption) => (
            <li key={caption.id} className={caption.who}>
              <span>{caption.who === "wearer" ? localized(language, "你", "You") : name}</span>
              {en ? caption.line.en : caption.line.zh}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
