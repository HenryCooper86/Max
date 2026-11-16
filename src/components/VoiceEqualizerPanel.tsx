import { ArrowCounterClockwise, CaretDown } from "@phosphor-icons/react";
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { VoiceEqualizer, VoiceEqualizerOptions } from "../../shared/agent";
import { EQ_MAX_DB, EQ_MIN_DB, formatDb, frequencyLabel, resolveEqualizer } from "../lib/equalizer";
import { useLanguage } from "./LanguageToggle";

type Props = {
  /** A usable (ten-band) offer; see usableEqualizerOptions. */
  options: VoiceEqualizerOptions;
  /** The viewer's choice, or null for the relay default. */
  value: VoiceEqualizer | null;
  onChange: (value: VoiceEqualizer | null) => void;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
};

const CUSTOM = "__custom";
const SPAN = EQ_MAX_DB - EQ_MIN_DB;
const clampStep = (db: number) => Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, Math.round(db)));
/** 0 at +12 dB, 100 at -12 dB: the fader's (and the curve's) vertical axis. */
const yOf = (db: number) => ((EQ_MAX_DB - db) / SPAN) * 100;

/** A smooth curve through the band gains (Catmull–Rom as cubic Béziers),
 *  in a 100×100 box whose columns line up with the faders. */
function curvePath(bands: readonly number[]): string {
  const points = bands.map((db, index) => [((index + 0.5) / bands.length) * 100, yOf(db)] as const);
  const at = (index: number) => points[Math.max(0, Math.min(points.length - 1, index))]!;
  let d = `M${at(0)[0].toFixed(2)} ${at(0)[1].toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0]!.toFixed(2)} ${c1[1]!.toFixed(2)} ${c2[0]!.toFixed(2)} ${c2[1]!.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

/** One vertical fader: value on top, the slot, its label underneath. A
 *  `role="slider"` element so it is keyboard- and screen-reader-operable
 *  the same way in every browser (vertical native ranges are not). */
function Fader({
  label,
  name,
  db,
  interactive,
  className = "",
  onChange
}: {
  label: string;
  /** Accessible name, e.g. "1 kHz" or "Preamp". */
  name: string;
  db: number;
  interactive: boolean;
  className?: string;
  onChange: (db: number) => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = slotRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const next = clampStep(EQ_MAX_DB - ratio * SPAN);
    if (next !== db) onChange(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = {
      ArrowUp: 1,
      ArrowRight: 1,
      ArrowDown: -1,
      ArrowLeft: -1,
      PageUp: 3,
      PageDown: -3
    };
    let next: number | null = null;
    if (event.key in step) next = clampStep(db + step[event.key]!);
    else if (event.key === "Home") next = EQ_MIN_DB;
    else if (event.key === "End") next = EQ_MAX_DB;
    if (next === null) return;
    event.preventDefault();
    if (next !== db) onChange(next);
  };
  const top = Math.min(yOf(db), yOf(0));
  const height = Math.abs(yOf(db) - yOf(0));
  return (
    <div className={`eqFader${className ? ` ${className}` : ""}${db !== 0 ? " moved" : ""}`}>
      <span className="eqFaderValue" aria-hidden="true">
        {db > 0 ? `+${db}` : db < 0 ? `−${Math.abs(db)}` : "0"}
      </span>
      <div
        ref={slotRef}
        className="eqSlot"
        role="slider"
        tabIndex={interactive ? 0 : -1}
        aria-label={name}
        aria-orientation="vertical"
        aria-valuemin={EQ_MIN_DB}
        aria-valuemax={EQ_MAX_DB}
        aria-valuenow={db}
        aria-valuetext={`${name} ${formatDb(db)}`}
        aria-disabled={interactive ? undefined : true}
        onKeyDown={interactive ? onKeyDown : undefined}
        onPointerDown={
          interactive
            ? (event) => {
                event.currentTarget.setPointerCapture?.(event.pointerId);
                fromPointer(event);
              }
            : undefined
        }
        onPointerMove={
          interactive
            ? (event) => {
                if (event.currentTarget.hasPointerCapture?.(event.pointerId)) fromPointer(event);
              }
            : undefined
        }
      >
        <span className="eqGroove" aria-hidden="true" />
        <span className="eqFill" aria-hidden="true" style={{ top: `${top}%`, height: `${height}%` }} />
        <span className="eqCap" aria-hidden="true" style={{ top: `${yOf(db)}%` }} />
      </div>
      <span className="eqFaderLabel" aria-hidden="true">
        {label}
      </span>
    </div>
  );
}

/** Settings → Voice → Equalizer: a ten-band graphic equaliser with a preamp,
 *  a preset menu, an on/off switch and a curve drawn through the bands.
 *  Read-only when the relay fixes the equaliser. */
export function VoiceEqualizerPanel({ options, value, onChange, enabled, onEnabledChange }: Props) {
  const { t } = useLanguage();
  const adjustable = options.adjustable;
  const resolved = resolveEqualizer(adjustable ? value : null, options);
  const interactive = adjustable && enabled;
  const preset = options.presets.find((candidate) => candidate.id === resolved.preset);
  const presetLabel = preset?.label ?? t("settings.equalizerCustom");
  const setBand = (index: number, db: number) =>
    onChange({ bands: resolved.bands.map((band, i) => (i === index ? db : band)), preamp: resolved.preamp });
  const setPreamp = (db: number) => onChange({ bands: resolved.bands, preamp: db });
  const curve = curvePath(resolved.bands);

  return (
    <div className={`eqPanel${adjustable ? "" : " readOnly"}${enabled || !adjustable ? "" : " off"}`}>
      <div className="eqToolbar">
        {adjustable ? (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            className={`eqPower${enabled ? " on" : ""}`}
            onClick={() => onEnabledChange(!enabled)}
          >
            <span className="eqPowerLamp" aria-hidden="true" />
            {t("settings.equalizerPower")}
          </button>
        ) : null}
        {adjustable ? (
          <label className="eqPresetField">
            <span className="visuallyHidden">{t("settings.equalizerPreset")}</span>
            <select
              value={resolved.preset ?? CUSTOM}
              disabled={!enabled}
              onChange={(event) => {
                if (event.currentTarget.value !== CUSTOM) onChange({ preset: event.currentTarget.value });
              }}
            >
              {resolved.preset === null ? (
                <option value={CUSTOM} disabled>
                  {t("settings.equalizerCustom")}
                </option>
              ) : null}
              {options.presets.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
            <CaretDown className="eqPresetCaret" size={14} aria-hidden="true" />
          </label>
        ) : (
          <span className="eqPresetFixed">{presetLabel}</span>
        )}
        {adjustable ? (
          <button type="button" className="eqReset" disabled={value === null} onClick={() => onChange(null)}>
            <ArrowCounterClockwise size={14} aria-hidden="true" />
            {t("settings.equalizerReset")}
          </button>
        ) : null}
      </div>
      {preset?.description ? <p className="eqPresetNote">{preset.description}</p> : null}

      <div className="eqRack" role="group" aria-label={t("settings.equalizer")}>
        <div className="eqConsole">
          <Fader
            className="preamp"
            label={t("settings.equalizerPreamp")}
            name={t("settings.equalizerPreamp")}
            db={resolved.preamp}
            interactive={interactive}
            onChange={setPreamp}
          />
          <div className="eqScale" aria-hidden="true">
            <span>+12</span>
            <span>0</span>
            <span>−12</span>
          </div>
          <div className="eqBank">
            <svg className="eqCurve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <line className="eqGrid" x1="0" x2="100" y1="25" y2="25" />
              <line className="eqGrid zero" x1="0" x2="100" y1="50" y2="50" />
              <line className="eqGrid" x1="0" x2="100" y1="75" y2="75" />
              <path className="eqCurveFill" d={`${curve}L95 50L5 50Z`} />
              <path className="eqCurveLine" d={curve} />
            </svg>
            {resolved.bands.map((db, index) => {
              const hz = options.frequencies[index] ?? 0;
              return (
                <Fader
                  key={hz || index}
                  label={frequencyLabel(hz)}
                  name={hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`}
                  db={db}
                  interactive={interactive}
                  onChange={(next) => setBand(index, next)}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
