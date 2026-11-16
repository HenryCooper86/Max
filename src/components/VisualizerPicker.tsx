import { useId } from "react";
import type { VoiceVisualizer } from "../../shared/agent";
import { synthesizeSpectrum, VISUALIZERS } from "../lib/visualizer";
import { useLanguage } from "./LanguageToggle";

// A frozen "speaking" frame, shared by every preview.
const PREVIEW_BINS = 12;
const FRAME = Array.from(synthesizeSpectrum(new Float32Array(PREVIEW_BINS), "speaking", 0, 1.15));
const PREVIEW_W = 64;
const PREVIEW_H = 30;
const CENTER = PREVIEW_H / 2;
const column = (index: number) => 14 + index * 3.1;

function PreviewContent({ style }: { style: VoiceVisualizer }) {
  switch (style) {
    case "wave":
      return <path d="M10 15c3 0 3-7 6-7s3 14 6 14 3-14 6-14 3 14 6 14 3-14 6-14 3 14 6 14 3-7 6-7" />;
    case "bars":
      return (
        <>
          {FRAME.map((value, i) => (
            <rect key={i} x={column(i)} width="2" y={24 - value * 16} height={Math.max(1, value * 16)} />
          ))}
        </>
      );
    case "mirror":
      return (
        <>
          {FRAME.map((value, i) => (
            <rect key={i} x={column(i)} width="2" y={CENTER - value * 9} height={Math.max(1, value * 18)} />
          ))}
        </>
      );
    case "dots":
      return (
        <>
          {FRAME.flatMap((value, i) =>
            [0, 1, 2, 3, 4].map((row) => (
              <circle
                key={`${i}-${row}`}
                cx={column(i) + 1}
                cy={23 - row * 4}
                r="1.1"
                opacity={row < value * 5 ? 1 : 0.2}
              />
            ))
          )}
        </>
      );
    case "ring":
      return (
        <>
          {Array.from({ length: 24 }, (_, k) => {
            const angle = (k / 24) * Math.PI * 2 - Math.PI / 2;
            const value = FRAME[k < 12 ? k : 23 - k] ?? 0;
            const outer = 6 + value * 6;
            return (
              <line
                key={k}
                x1={PREVIEW_W / 2 + Math.cos(angle) * 5}
                y1={CENTER + Math.sin(angle) * 5}
                x2={PREVIEW_W / 2 + Math.cos(angle) * outer}
                y2={CENTER + Math.sin(angle) * outer}
              />
            );
          })}
        </>
      );
  }
}

/** A tiny static lens showing one frame of the style. */
export function VisualizerPreview({ style }: { style: VoiceVisualizer }) {
  return (
    <svg
      className={`vizPreview ${style}`}
      viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
      aria-hidden="true"
      focusable="false"
    >
      <rect
        className="vizPreviewLens"
        x="0.75"
        y="0.75"
        width={PREVIEW_W - 1.5}
        height={PREVIEW_H - 1.5}
        rx={(PREVIEW_H - 1.5) / 2}
      />
      <g className="vizPreviewMark">
        <PreviewContent style={style} />
      </g>
    </svg>
  );
}

/** Settings → Appearance → Voice display: one native radio per style. */
export function VisualizerPicker({
  value,
  onSelect
}: {
  value: VoiceVisualizer;
  onSelect: (id: VoiceVisualizer) => void;
}) {
  const { language, t } = useLanguage();
  const name = useId();
  return (
    <fieldset className="vizPicker">
      <legend className="visuallyHidden">{t("settings.visualizer")}</legend>
      {VISUALIZERS.map((entry) => {
        const selected = entry.id === value;
        return (
          <label key={entry.id} className={`vizOption${selected ? " active" : ""}`}>
            <input
              className="visuallyHidden"
              type="radio"
              name={name}
              value={entry.id}
              checked={selected}
              onChange={() => onSelect(entry.id)}
            />
            <VisualizerPreview style={entry.id} />
            <span>{language === "en-US" ? entry.label.en : entry.label.zh}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** The pinned style, read-only. */
export function VisualizerBadge({ value }: { value: VoiceVisualizer }) {
  const { language } = useLanguage();
  const entry = VISUALIZERS.find((candidate) => candidate.id === value) ?? VISUALIZERS[0]!;
  return (
    <span className="templatePinned">
      <VisualizerPreview style={entry.id} />
      <span className="settingsValue">{language === "en-US" ? entry.label.en : entry.label.zh}</span>
    </span>
  );
}
