import { useId } from "react";
import type { VoiceVisualizer } from "../../shared/agent";
import { TEMPLATES, type DesignTemplate } from "../lib/templates";
import { useLanguage } from "./LanguageToggle";

/** What the settings sheet needs to show and change the design template. */
export type AppearanceControls = {
  /** The template in effect (after relay pinning and fallbacks). */
  templateId: string;
  /** True when the owner pinned the template: show it, offer no choice. */
  pinned: boolean;
  onSelect: (id: string) => void;
  /** The voice display style in effect, and the viewer's way to change it. */
  visualizer: VoiceVisualizer;
  onSelectVisualizer: (id: VoiceVisualizer) => void;
};

/** A thumbnail of the template: its page, the Visor lens on a surface with
 *  the accent wave, and two lines of text. Built-in colours only. */
export function TemplateSwatch({ template }: { template: DesignTemplate }) {
  const { bg, surface, text, accent } = template.swatch;
  return (
    <svg className="templateSwatch" viewBox="0 0 56 40" aria-hidden="true" focusable="false">
      <rect className="templateSwatchFrame" x="0.5" y="0.5" width="55" height="39" rx="7" fill={bg} />
      <rect x="7" y="7" width="42" height="17" rx="8.5" fill={surface} />
      <path
        d="M11 15.5c2.5 0 2.5-4 5-4s2.5 8 5 8 2.5-8 5-8 2.5 8 5 8 2.5-8 5-8 2.5 4 5 4"
        fill="none"
        stroke={accent}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <rect x="7" y="29" width="22" height="3" rx="1.5" fill={text} />
      <rect x="32" y="29" width="11" height="3" rx="1.5" fill={text} opacity="0.5" />
    </svg>
  );
}

/** One radio per template: swatch, name and a one-line description. Native
 *  radios give arrow-key movement and the group semantics for free. */
export function TemplatePicker({ value, onSelect }: { value: string; onSelect: (id: string) => void }) {
  const { language, t } = useLanguage();
  const name = useId();
  const en = language === "en-US";
  return (
    <fieldset className="templatePicker">
      <legend className="visuallyHidden">{t("settings.template")}</legend>
      {TEMPLATES.map((template) => {
        const selected = template.id === value;
        return (
          <label key={template.id} className={`templateOption${selected ? " active" : ""}`}>
            <input
              className="visuallyHidden"
              type="radio"
              name={name}
              value={template.id}
              checked={selected}
              onChange={() => onSelect(template.id)}
            />
            <TemplateSwatch template={template} />
            <span className="templateText">
              <strong>{en ? template.label.en : template.label.zh}</strong>
              <span>{en ? template.description.en : template.description.zh}</span>
            </span>
            <span className="templateCheck" aria-hidden="true" />
          </label>
        );
      })}
    </fieldset>
  );
}
