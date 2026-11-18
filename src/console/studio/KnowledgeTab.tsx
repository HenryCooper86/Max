import { useRef, useState } from "react";
import { STUDIO_LIMITS } from "../../../shared/cloud-studio";
import { useLanguage } from "../../components/LanguageToggle";
import { findTemplate } from "../../lib/agent-templates";
import { useSay } from "../hooks";
import type { StudioTabProps } from "./types";

const MAX = STUDIO_LIMITS.knowledge;
const FILE_MAX_BYTES = 200 * 1024;

/** Adds imported text after what is there, within the limit. Returns the text and whether it was cut. */
export function appendKnowledge(current: string, added: string): { text: string; cut: boolean } {
  const joined = current.trim() ? `${current.trim()}\n\n${added.trim()}` : added.trim();
  return { text: joined.slice(0, MAX), cut: joined.length > MAX };
}

/** Studio → Knowledge: the facts the agent answers from. */
export function KnowledgeTab({ project, draft, updateStudio }: StudioTabProps) {
  const say = useSay();
  const { language } = useLanguage();
  const [note, setNote] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const knowledge = draft.studio.knowledge;
  const outline = findTemplate(draft.studio.template)?.knowledge[language === "en-US" ? "en" : "zh"] ?? "";
  const id = `cxs-${project.id}-knowledge`;

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > FILE_MAX_BYTES) {
      setNote(say("文件太大：最多 200 KB 的纯文本。", "That file is too big: up to 200 KB of plain text."));
      return;
    }
    const text = await file.text();
    const result = appendKnowledge(knowledge, text);
    updateStudio({ knowledge: result.text });
    setNote(
      result.cut
        ? say("已导入，但超出 20,000 字的部分被截掉了。", "Imported, but the part past 20,000 characters was cut.")
        : say(`已导入 ${file.name}。`, `Imported ${file.name}.`)
    );
  };

  return (
    <div className="cxsPanel">
      <p className="cxMuted">
        {say(
          "贴上营业时间、价格、政策、常见问答等。助手会根据这些回答；这里没有的，它会说不知道，而不是乱编。",
          "Paste opening hours, prices, policies, FAQs. The agent answers from this, and says it doesn't know rather than guessing when something isn't here."
        )}
      </p>
      <div className="cxField">
        <label htmlFor={id}>
          <span>{say("知识", "Knowledge")}</span>
        </label>
        <textarea
          id={id}
          className="cxsKnowledge"
          rows={16}
          maxLength={MAX}
          value={knowledge}
          placeholder={
            outline ||
            say("问：你们几点开门？\n答：每天 9 点到 18 点。", "Q: When are you open?\nA: Every day, 9 am to 6 pm.")
          }
          onChange={(event) => updateStudio({ knowledge: event.target.value })}
        />
        <small className="cxsCount">
          {knowledge.length.toLocaleString()} / {MAX.toLocaleString()}
        </small>
      </div>
      <div className="cxRow">
        <button type="button" className="siteButton secondary small" onClick={() => fileInput.current?.click()}>
          {say("从文本文件导入", "Import a text file")}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".txt,.md,.csv,text/plain,text/markdown"
          hidden
          onChange={(event) => {
            void importFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        {outline && !knowledge.trim() ? (
          <button type="button" className="siteButton quiet small" onClick={() => updateStudio({ knowledge: outline })}>
            {say("插入模板大纲", "Insert the template's outline")}
          </button>
        ) : null}
        <span className="cxStatus" aria-live="polite">
          {note}
        </span>
      </div>
      <ul className="cxsTips">
        <li>{say("用简单的问答格式效果最好。", "Simple question-and-answer pairs work best.")}</li>
        <li>{say("写清楚具体数字：价格、时间、地址。", "Spell out the specifics: prices, hours, addresses.")}</li>
        <li>
          {say(
            "需要实时数据（库存、订单状态）时，用“工具”而不是写在这里。",
            "For live data (stock, order status), use a Tool instead of writing it here."
          )}
        </li>
      </ul>
    </div>
  );
}
