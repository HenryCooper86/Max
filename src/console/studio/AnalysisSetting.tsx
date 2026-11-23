import { useState } from "react";
import {
  ANALYSIS_FIELD_TYPES,
  ANALYSIS_LIMITS,
  analysisConfigFrom,
  type AnalysisField,
  type AnalysisResult
} from "../../../shared/analysis";
import { DEFAULT_ANALYSIS, type StudioAnalysis } from "../../../shared/cloud-studio";
import type { Backend, ConversationAnalysis } from "../api";
import { useSay } from "../hooks";
import type { StudioTabProps } from "./types";

type Say = (zh: string, en: string) => string;

const VENDOR: Record<Backend, string> = { openai: "OpenAI", gemini: "Google", grok: "xAI" };

/** A name that is free among the fields: field_1, field_2, … */
function freeName(fields: readonly AnalysisField[]): string {
  for (let n = fields.length + 1; ; n += 1) {
    const name = `field_${n}`;
    if (!fields.some((field) => field.name === name)) return name;
  }
}

function typeLabel(type: AnalysisField["type"], say: Say): string {
  if (type === "number") return say("数字", "Number");
  if (type === "boolean") return say("是或否", "Yes or no");
  if (type === "enum") return say("几个选项之一", "One of a few choices");
  return say("文字", "Text");
}

const NOTHING = "nothing to look for";

/** The choices as typed: "orders, returns" (a Chinese comma works too). */
export function parseOptions(typed: string): string[] {
  return typed
    .split(/[,，]/)
    .map((option) => option.trim())
    .filter(Boolean);
}

/** What is wrong with the settings as typed, in the server's own words, or nothing. */
export function analysisProblem(analysis: StudioAnalysis): string | undefined {
  const parsed = analysisConfigFrom({
    summary: analysis.summary,
    sentiment: analysis.sentiment,
    successCriteria: analysis.successCriteria,
    fields: analysis.fields
  });
  if (!parsed.config) return (parsed.problem ?? "").replace(/^analysis[. ]?/, "");
  if (
    analysis.enabled &&
    !analysis.summary &&
    !analysis.sentiment &&
    !analysis.successCriteria.trim() &&
    analysis.fields.length === 0
  ) {
    return NOTHING;
  }
  return undefined;
}

function FieldRow({
  field,
  index,
  onChange,
  onRemove
}: {
  field: AnalysisField;
  index: number;
  onChange: (next: AnalysisField) => void;
  onRemove: () => void;
}) {
  const say = useSay();
  // As typed, while it still says what the field holds. A row that another field has moved into, or a field
  // that was made something else and back, shows its own choices and not what was typed for another.
  const [typed, setTyped] = useState((field.options ?? []).join(", "));
  const own = field.options ?? [];
  const options = JSON.stringify(parseOptions(typed)) === JSON.stringify(own) ? typed : own.join(", ");
  const id = `cxsAnalysisField${index}`;
  return (
    <div className="cxsAnalysisField" role="group" aria-label={say(`字段 ${index + 1}`, `Field ${index + 1}`)}>
      <label className="cxField" htmlFor={`${id}-name`}>
        <span>{say("名称", "Name")}</span>
        <input
          id={`${id}-name`}
          value={field.name}
          spellCheck={false}
          autoCapitalize="none"
          onChange={(event) =>
            onChange({ ...field, name: event.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 48) })
          }
        />
      </label>
      <label className="cxField" htmlFor={`${id}-type`}>
        <span>{say("类型", "Type")}</span>
        <select
          id={`${id}-type`}
          value={field.type}
          onChange={(event) => {
            const type = event.target.value as AnalysisField["type"];
            const { options: _dropped, ...rest } = field;
            void _dropped;
            onChange(type === "enum" ? { ...rest, type, options: field.options ?? [] } : { ...rest, type });
          }}
        >
          {ANALYSIS_FIELD_TYPES.map((type) => (
            <option key={type} value={type}>
              {typeLabel(type, say)}
            </option>
          ))}
        </select>
      </label>
      <label className="cxField cxsAnalysisWide" htmlFor={`${id}-desc`}>
        <span>{say("要找什么", "What to look for")}</span>
        <input
          id={`${id}-desc`}
          value={field.description}
          maxLength={ANALYSIS_LIMITS.description}
          placeholder={say("例如：访客问到的订单号", "For example: the order number the visitor asked about")}
          onChange={(event) => onChange({ ...field, description: event.target.value })}
        />
      </label>
      {field.type === "enum" ? (
        <label className="cxField cxsAnalysisWide" htmlFor={`${id}-options`}>
          <span>{say("选项（用逗号分隔，至少两个）", "Choices (comma-separated, at least two)")}</span>
          <input
            id={`${id}-options`}
            value={options}
            placeholder={say("订单, 退货, 其他", "orders, returns, other")}
            onChange={(event) => {
              setTyped(event.target.value);
              onChange({ ...field, options: parseOptions(event.target.value) });
            }}
          />
        </label>
      ) : null}
      <div className="cxsAnalysisActions">
        <button
          type="button"
          className="siteButton quiet small"
          aria-label={say(`删除字段 ${index + 1}`, `Remove field ${index + 1}`)}
          onClick={onRemove}
        >
          {say("删除字段", "Remove field")}
        </button>
      </div>
    </div>
  );
}

/** What each conversation is analysed for when it ends. */
export function AnalysisSetting({ project, draft, updateStudio }: StudioTabProps) {
  const say = useSay();
  // A project from a relay older than analysis has none.
  const analysis: StudioAnalysis = draft.studio.analysis ?? DEFAULT_ANALYSIS;
  const saved: StudioAnalysis = project.studio.analysis ?? DEFAULT_ANALYSIS;
  const unsaved = JSON.stringify(analysis) !== JSON.stringify(saved);
  // Checked whether it is on or off: the server refuses what it cannot use either way, and a field left
  // half-written behind a switch that is off would stop every other setting from being saved.
  const problem = analysisProblem(analysis);
  // Opened by a problem behind the switch, the form stays open while it is being put right: gone with
  // the first key that made it valid, it would take the rest of what is being typed with it.
  const [heldOpen, setHeldOpen] = useState(false);
  if (!analysis.enabled && problem && !heldOpen) setHeldOpen(true);
  const shown = analysis.enabled || Boolean(problem) || heldOpen;
  const vendor = VENDOR[draft.backend];
  const set = (patch: Partial<StudioAnalysis>) => updateStudio({ analysis: { ...analysis, ...patch } });
  const nowhere =
    analysis.enabled && !draft.studio.keepConversations && !(draft.studio.conversationWebhook ?? "").trim();

  return (
    <div className="cxsHistorySetting">
      <label className="cxsHistoryCheck">
        <input
          type="checkbox"
          checked={analysis.enabled}
          onChange={(event) => {
            setHeldOpen(false);
            set({ enabled: event.target.checked });
          }}
        />
        <span>{say("对话结束时分析每段对话", "Analyse each conversation when it ends")}</span>
      </label>
      <p className="cxMuted">
        {say(
          "一个模型读完对话文字，写出摘要、情绪、是否成功，以及你要它找的信息。",
          "A model reads the transcript and writes a summary, the mood, whether it succeeded, and what you ask it to find. "
        )}
        {project.analysisOnOwnKey === false
          ? say(
              "它在本服务运营方提供的模型上运行，对话文字会发送到那里，不使用你的密钥，也不向你收费。",
              "It runs on a model this service's operator provides: the transcript is sent there, your key is not used, and you are not charged for it. "
            )
          : say(
              `它用你自己的 ${vendor} 密钥运行，每段对话大约几千个 token，费用记在你的 ${vendor} 账户上。`,
              `It runs with your own ${vendor} key: a few thousand tokens per conversation, on your ${vendor} bill. `
            )}
        {say(
          "结果显示在对话记录里，并随对话一起发到你的服务器。",
          "The result is shown with the conversation here and sent to your server with it."
        )}
      </p>
      {shown ? (
        <div className="cxsAnalysis">
          <div className="cxsAnalysisChecks" role="group" aria-label={say("分析内容", "What to write")}>
            <label className="cxsHistoryCheck">
              <input
                type="checkbox"
                checked={analysis.summary}
                onChange={(event) => set({ summary: event.target.checked })}
              />
              <span>{say("摘要", "A summary")}</span>
            </label>
            <label className="cxsHistoryCheck">
              <input
                type="checkbox"
                checked={analysis.sentiment}
                onChange={(event) => set({ sentiment: event.target.checked })}
              />
              <span>{say("访客的情绪", "How the visitor felt")}</span>
            </label>
          </div>
          <label className="cxField" htmlFor="cxsAnalysisCriteria">
            <span>{say("怎样算成功（可不填）", "What counts as a success (optional)")}</span>
            <textarea
              id="cxsAnalysisCriteria"
              rows={2}
              maxLength={ANALYSIS_LIMITS.criteria}
              value={analysis.successCriteria}
              placeholder={say(
                "例如：访客得到了订单状态，并且没有要求转人工。",
                "For example: the visitor was given their order status and did not ask for a person."
              )}
              onChange={(event) => set({ successCriteria: event.target.value })}
            />
          </label>
          <strong className="cxsAnalysisTitle">
            {say("要从对话中找出的信息", "What to find in each conversation")}
          </strong>
          {analysis.fields.map((field, at) => (
            <FieldRow
              key={at}
              field={field}
              index={at}
              onChange={(next) => set({ fields: analysis.fields.map((other, i) => (i === at ? next : other)) })}
              onRemove={() => set({ fields: analysis.fields.filter((_, i) => i !== at) })}
            />
          ))}
          <div className="cxsAnalysisActions">
            <button
              type="button"
              className="siteButton secondary small"
              disabled={analysis.fields.length >= ANALYSIS_LIMITS.fields}
              onClick={() =>
                set({
                  fields: [...analysis.fields, { name: freeName(analysis.fields), type: "string", description: "" }]
                })
              }
            >
              {say("添加字段", "Add a field")}
            </button>
          </div>
        </div>
      ) : null}
      <div aria-live="polite">
        {problem ? (
          <p className="cxWarn">
            {say("现在还不能保存：", "This cannot be saved yet: ")}
            {problem === NOTHING
              ? say(
                  "没有要找的内容。请选择摘要、情绪、成功规则，或添加一个字段。",
                  "there is nothing to look for. Choose a summary, the mood, a success rule, or add a field."
                )
              : problem}
          </p>
        ) : null}
        {nowhere && !problem ? (
          <p className="cxWarn">
            {say(
              "结果没有地方可去：请打开“保存对话记录”，或填写你的服务器地址。",
              "The result has nowhere to go: turn on keeping transcripts, or give your server's address."
            )}
          </p>
        ) : null}
        {unsaved && !problem ? <p className="cxWarn">{say("请发布以生效", "Publish to apply")}</p> : null}
      </div>
    </div>
  );
}

function sentimentLabel(sentiment: NonNullable<AnalysisResult["sentiment"]>, say: Say): string {
  if (sentiment === "positive") return say("满意", "Positive");
  if (sentiment === "negative") return say("不满", "Negative");
  return say("一般", "Neutral");
}

/** The marks a conversation gets in the list and at the top of its page. */
export function AnalysisMarks({ sentiment, success }: { sentiment?: AnalysisResult["sentiment"]; success?: boolean }) {
  const say = useSay();
  return (
    <>
      {typeof success === "boolean" ? (
        <span className={`cxsHistoryBadge ${success ? "good" : "bad"}`}>
          {success ? say("成功", "Succeeded") : say("未成功", "Did not succeed")}
        </span>
      ) : null}
      {sentiment ? (
        <span
          className={`cxsHistoryBadge ${sentiment === "negative" ? "bad" : sentiment === "positive" ? "good" : ""}`}
        >
          {sentimentLabel(sentiment, say)}
        </span>
      ) : null}
    </>
  );
}

function valueText(value: string | number | boolean | null, say: Say): string {
  if (value === null) return say("（对话中没有提到）", "(not said in the conversation)");
  if (typeof value === "boolean") return value ? say("是", "Yes") : say("否", "No");
  return String(value);
}

/** What the analysis made of one conversation. */
export function AnalysisView({ analysis }: { analysis: ConversationAnalysis }) {
  const say = useSay();
  const result = analysis.result;
  if (!result) {
    return (
      <section className="cxsAnalysisResult" aria-label={say("分析", "Analysis")}>
        <p className="cxWarn">
          {say("这段对话没有分析结果：", "This conversation was not analysed: ")}
          {analysis.error ?? say("未知原因", "unknown reason")}
        </p>
      </section>
    );
  }
  const data = Object.entries(result.data ?? {});
  return (
    <section className="cxsAnalysisResult" aria-label={say("分析", "Analysis")}>
      <strong className="cxsAnalysisTitle">{say("分析", "Analysis")}</strong>
      {result.summary ? <p>{result.summary}</p> : null}
      {typeof result.success === "boolean" && result.successReason ? (
        <p className="cxMuted">
          {result.success ? say("成功：", "Succeeded: ") : say("未成功：", "Did not succeed: ")}
          {result.successReason}
        </p>
      ) : null}
      {data.length > 0 ? (
        <dl className="cxsAnalysisData">
          {data.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd className={value === null ? "cxMuted" : undefined}>{valueText(value, say)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
