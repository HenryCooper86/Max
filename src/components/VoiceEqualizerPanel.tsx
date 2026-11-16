import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { useId, type CSSProperties } from "react";
import type { VoiceEqualizer, VoiceEqualizerOptions } from "../../shared/agent";
import {
  EQ_BAND_HZ,
  EQ_BANDS,
  EQ_MAX_DB,
  EQ_MIN_DB,
  equalizerResponse,
  resolveEqualizer,
  type EqBand,
  type EqBands
} from "../lib/equalizer";
import { useLanguage } from "./LanguageToggle";

type Props = {
  options: VoiceEqualizerOptions;
  /** The viewer's choice, or null for the relay default. */
  value: VoiceEqualizer | null;
  onChange: (value: VoiceEqualizer | null) => void;
};

const MIN_HZ = 20;
const MAX_HZ = 20_000;
/** The preview's vertical range; the bands plus gain can exceed ±12. */
const VIEW_DB = 18;
const WIDTH = 320;
const HEIGHT = 88;

function xOf(hz: number): number {
  return (Math.log10(hz / MIN_HZ) / Math.log10(MAX_HZ / MIN_HZ)) * WIDTH;
}

function yOf(db: number): number {
  const clamped = Math.max(-VIEW_DB, Math.min(VIEW_DB, db));
  return HEIGHT / 2 - (clamped / VIEW_DB) * (HEIGHT / 2 - 4);
}

function formatDb(db: number): string {
  return `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db)} dB`;
}

/** The response through the five gains on a log-frequency axis. */
function ResponseCurve({ bands, label }: { bands: EqBands; label: string }) {
  const points: string[] = [];
  const steps = 96;
  for (let index = 0; index <= steps; index += 1) {
    const hz = MIN_HZ * (MAX_HZ / MIN_HZ) ** (index / steps);
    points.push(`${xOf(hz).toFixed(1)} ${yOf(equalizerResponse(bands, hz)).toFixed(1)}`);
  }
  const line = `M${points.join("L")}`;
  const zero = yOf(0);
  return (
    <div className="eqCurve">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {Object.values(EQ_BAND_HZ).map((hz) => (
          <line key={hz} className="eqCurveGrid" x1={xOf(hz)} x2={xOf(hz)} y1="0" y2={HEIGHT} />
        ))}
        <line className="eqCurveZero" x1="0" x2={WIDTH} y1={zero} y2={zero} />
        <path className="eqCurveFill" d={`${line}L${WIDTH} ${zero}L0 ${zero}Z`} />
        <path className="eqCurveLine" d={line} />
      </svg>
      <div className="eqAxis" aria-hidden="true">
        {Object.entries(EQ_BAND_HZ).map(([band, hz]) => (
          <span key={band} style={{ left: `${(xOf(hz) / WIDTH) * 100}%` }}>
            {hz >= 1000 ? `${hz / 1000}k` : hz}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Settings → Voice → Equalizer: relay presets, five band sliders and a
 *  live response preview. Read-only when the relay fixes the equaliser. */
export function VoiceEqualizerPanel({ options, value, onChange }: Props) {
  const { t } = useLanguage();
  const id = useId();
  const adjustable = options.adjustable;
  const resolved = resolveEqualizer(adjustable ? value : null, options);
  const presetLabel = (presetId: string | null) =>
    options.presets.find((preset) => preset.id === presetId)?.label ?? t("settings.equalizerCustom");
  const summary = EQ_BANDS.map((band) => `${t(`settings.eq.${band}`)} ${formatDb(resolved.bands[band])}`).join(", ");
  const curve = <ResponseCurve bands={resolved.bands} label={t("settings.equalizerCurve", { summary })} />;

  if (!adjustable) {
    return (
      <div className="eqPanel readOnly">
        <div className="eqHead">
          <span className="settingsValue">{presetLabel(resolved.preset)}</span>
        </div>
        {curve}
      </div>
    );
  }

  const setBand = (band: EqBand, db: number) => onChange({ ...resolved.bands, [band]: db });

  return (
    <div className="eqPanel">
      <div className="eqPresets" role="group" aria-label={t("settings.equalizerPresets")}>
        {options.presets.map((preset) => {
          const selected = resolved.preset === preset.id;
          return (
            <button
              type="button"
              key={preset.id}
              className={`eqChip${selected ? " active" : ""}`}
              aria-pressed={selected}
              title={preset.description}
              aria-description={preset.description}
              onClick={() => onChange({ preset: preset.id })}
            >
              {preset.label}
            </button>
          );
        })}
        {/* Always present, so the first slider move cannot reflow the
            sliders under the pointer. It only reports the state. */}
        <span
          className={`eqChip custom${resolved.preset === null ? " active" : ""}`}
          aria-current={resolved.preset === null ? "true" : undefined}
        >
          {t("settings.equalizerCustom")}
        </span>
      </div>

      {curve}

      <div className="eqBands">
        {EQ_BANDS.map((band) => {
          const db = resolved.bands[band];
          const position = ((db - EQ_MIN_DB) / (EQ_MAX_DB - EQ_MIN_DB)) * 100;
          return (
            <div className="eqBand" key={band}>
              <label htmlFor={`${id}-${band}`}>
                {t(`settings.eq.${band}`)}
                {band !== "gain" ? (
                  <small>
                    {EQ_BAND_HZ[band] >= 1000 ? `${EQ_BAND_HZ[band] / 1000} kHz` : `${EQ_BAND_HZ[band]} Hz`}
                  </small>
                ) : null}
              </label>
              <input
                id={`${id}-${band}`}
                type="range"
                min={EQ_MIN_DB}
                max={EQ_MAX_DB}
                step={1}
                value={db}
                aria-valuetext={formatDb(db)}
                style={
                  {
                    "--eq-from": `${Math.min(50, position)}%`,
                    "--eq-to": `${Math.max(50, position)}%`
                  } as CSSProperties
                }
                onChange={(event) => setBand(band, Number(event.currentTarget.value))}
              />
              <output htmlFor={`${id}-${band}`} className="eqReadout">
                {formatDb(db)}
              </output>
            </div>
          );
        })}
      </div>

      <div className="eqFoot">
        <button type="button" className="eqReset" disabled={value === null} onClick={() => onChange(null)}>
          <ArrowCounterClockwise size={14} aria-hidden="true" />
          {t("settings.equalizerReset")}
        </button>
      </div>
    </div>
  );
}
