import { CHARACTERS, characterInfo, MAX_CHARACTERS, type CharacterId } from "../../shared/characters";
import { localized } from "../lib/i18n";
import { useLanguage } from "./LanguageToggle";

/**
 * Picks the creatures that fly on the page: up to three, in order (the first
 * leads and follows the cursor), repeats allowed (two bees). Stills come from
 * `assetBase` (the relay's origin; "" on the relay itself).
 */
export function CharacterPicker({
  value,
  onChange,
  assetBase = "",
  allowNone = false
}: {
  value: readonly CharacterId[];
  onChange: (next: CharacterId[]) => void;
  assetBase?: string;
  /** Let the list be emptied (the Cloud widget can show no character). */
  allowNone?: boolean;
}) {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const name = (id: CharacterId) => say(characterInfo(id).label.zh, characterInfo(id).label.en);
  const still = (id: CharacterId) => `${assetBase}/character/${id}.png`;
  const full = value.length >= MAX_CHARACTERS;

  return (
    <div className="characterPicker">
      <ol className="characterChosen" aria-label={say("已选角色", "Chosen characters")}>
        {value.map((id, index) => (
          <li key={`${id}-${index}`}>
            <img src={still(id)} alt="" draggable={false} loading="lazy" />
            <span>
              {name(id)}
              {index === 0 ? <small>{say("领头", "Leads")}</small> : null}
            </span>
            {value.length > 1 || allowNone ? (
              <button
                type="button"
                className="characterRemove"
                aria-label={say(`移除${name(id)}`, `Remove ${name(id)}`)}
                onClick={() => onChange(value.filter((_, at) => at !== index))}
              >
                ×
              </button>
            ) : null}
          </li>
        ))}
        {value.length === 0 ? <li className="characterNone">{say("不显示角色", "No character")}</li> : null}
      </ol>
      <div className="characterAdd" role="group" aria-label={say("添加角色", "Add a character")}>
        {CHARACTERS.map((character) => (
          <button key={character.id} type="button" disabled={full} onClick={() => onChange([...value, character.id])}>
            <img src={still(character.id)} alt="" draggable={false} loading="lazy" />
            <span>
              {say("添加", "Add")} {name(character.id)}
            </span>
          </button>
        ))}
      </div>
      <small className="characterHint">
        {full
          ? say(`最多 ${MAX_CHARACTERS} 个。`, `Up to ${MAX_CHARACTERS} at once.`)
          : say(
              "第一个跟随鼠标，其余在旁边飞。可以重复，比如两只蜜蜂。",
              "The first follows the cursor; the others hover nearby. Repeats are fine, like two bees."
            )}
      </small>
    </div>
  );
}
