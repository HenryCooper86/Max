type Props = {
  onSelect: (text: string) => void;
  disabled: boolean;
};

// Mixed-language presets that double as a demo of Max's trilingual support.
const PHRASES = ["最近的加油站", "回家最快路线", "前方天气如何", "附近休息点", "Weather ahead?", "ルート確認"];

/** One-tap rider commands that submit straight to the agent. */
export function QuickPhrases({ onSelect, disabled }: Props) {
  return (
    <div className="quickPhrases" aria-label="快捷指令">
      {PHRASES.map((phrase) => (
        <button key={phrase} type="button" className="chip" disabled={disabled} onClick={() => onSelect(phrase)}>
          {phrase}
        </button>
      ))}
    </div>
  );
}
