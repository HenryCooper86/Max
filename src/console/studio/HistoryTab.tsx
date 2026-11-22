import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "../../components/LanguageToggle";
import { STUDIO_LIMITS, toolUrlProblem } from "../../../shared/cloud-studio";
import type { Conversation, ConversationSummary, ConversationTurn, WebhookDelivery, WebhookTestResult } from "../api";
import { useSay } from "../hooks";
import { AnalysisMarks, AnalysisSetting, AnalysisView } from "./AnalysisSetting";
import type { StudioTabProps } from "./types";
import "./history-tab.css";

/** Seconds as m:ss ("0:07", "12:05"). Bad input shows "0:00". */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Where a conversation came from, in plain words. */
export function sourceLabel(source: string, say: (zh: string, en: string) => string): string {
  if (source === "test") return say("测试", "Test");
  if (source === "embed") return say("网站", "Website");
  if (source === "api") return say("API", "API");
  return source || say("未知", "Unknown");
}

/** "Nov 18, 14:05" or "11月18日 14:05" in the visitor's language. */
function formatWhen(ms: number, language: string): string {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleString(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

/** Clock time only, for chat bubbles. */
function formatClock(ms: number, language: string): string {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString(language, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

/** "12 conversations in the last 30 days". */
export function countSummary(count: number, say: (zh: string, en: string) => string): string {
  return say(
    `最近 30 天有 ${count} 段对话`,
    `${count} ${count === 1 ? "conversation" : "conversations"} in the last 30 days`
  );
}

/** One line for a tool turn: "✓ check_order · 412 ms" or "✗ check_order failed: reason". */
export function toolLine(
  turn: Pick<ConversationTurn, "text" | "ok" | "ms">,
  say: (zh: string, en: string) => string
): string {
  const text = turn.text.trim() || say("工具", "tool");
  if (turn.ok === false) {
    // The server stores a failed call as "name: reason".
    const cut = text.indexOf(": ");
    const name = cut < 0 ? text : text.slice(0, cut);
    return `✗ ${name} ${say("失败", "failed")}${cut < 0 ? "" : text.slice(cut)}`;
  }
  return `✓ ${text}${typeof turn.ms === "number" ? ` · ${Math.round(turn.ms)} ms` : ""}`;
}

type Say = (zh: string, en: string) => string;

function Turn({ turn, language, say }: { turn: ConversationTurn; language: string; say: Say }) {
  if (turn.speaker === "tool") {
    return (
      <li className={`cxsHistoryTool ${turn.ok === false ? "bad" : "ok"}`}>
        <span>{toolLine(turn, say)}</span>
      </li>
    );
  }
  return (
    <li className={`cxsHistoryBubble ${turn.speaker}`}>
      <span className="cxsHistoryWho">
        {turn.speaker === "user" ? say("访客", "Visitor") : say("助手", "Agent")} · {formatClock(turn.at, language)}
      </span>
      <p>{turn.text}</p>
    </li>
  );
}

/** "Delivered · HTTP 200" or "Not delivered after 4 tries: HTTP 500". */
export function deliveryLine(
  delivery: Pick<WebhookDelivery, "ok" | "attempts" | "status" | "error">,
  say: Say
): string {
  if (delivery.ok) return say(`已送达 · HTTP ${delivery.status ?? 200}`, `Delivered · HTTP ${delivery.status ?? 200}`);
  const why = delivery.error ?? (delivery.status ? `HTTP ${delivery.status}` : say("未知原因", "unknown reason"));
  return delivery.attempts > 1
    ? say(`试了 ${delivery.attempts} 次仍未送达：${why}`, `Not delivered after ${delivery.attempts} tries: ${why}`)
    : say(`未送达：${why}`, `Not delivered: ${why}`);
}

/** Where each conversation is sent when it ends: the address, a test request, and how the last delivery went. */
function WebhookSetting({ session, project, draft, updateStudio, goTo }: StudioTabProps) {
  const say = useSay();
  const { language } = useLanguage();
  const url = draft.studio.conversationWebhook ?? "";
  const saved = project.studio.conversationWebhook ?? "";
  const unsaved = url.trim() !== saved;
  const problem = url.trim() ? toolUrlProblem(url.trim()) : undefined;
  // Each with the address it is about: what is known of one address says nothing of the next.
  const [last, setLast] = useState<{ of: string; delivery: WebhookDelivery | null } | null>(null);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ of: string; result: WebhookTestResult } | null>(null);
  const result = tested?.of === saved ? tested.result : null;
  const delivery = last?.of === saved ? last.delivery : null;
  const [error, setError] = useState("");
  const alive = useRef(true);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    alive.current = true;
    if (saved) {
      const { api, token } = sessionRef.current;
      api
        .conversationWebhook(token, project.id)
        .then((answer) => {
          if (alive.current) setLast({ of: saved, delivery: answer.last });
        })
        // The address works without this line: an older relay has no such route.
        .catch(() => undefined);
    }
    return () => {
      alive.current = false;
    };
  }, [project.id, saved]);

  async function test() {
    setTesting(true);
    setTested(null);
    setError("");
    try {
      const answer = await session.api.testConversationWebhook(session.token, project.id);
      if (alive.current) setTested({ of: saved, result: answer });
    } catch (caught) {
      if (alive.current) setError(session.fail(caught));
    } finally {
      if (alive.current) setTesting(false);
    }
  }

  return (
    <div className="cxsHistorySetting">
      <label className="cxField" htmlFor="cxsHistoryWebhook">
        <span>{say("对话结束时发送到你的服务器", "Send each conversation to your server when it ends")}</span>
        <input
          id="cxsHistoryWebhook"
          type="url"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://example.com/max/conversations"
          maxLength={STUDIO_LIMITS.url}
          aria-invalid={problem ? true : undefined}
          aria-describedby="cxsHistoryWebhookHint"
          value={url}
          onChange={(event) => updateStudio({ conversationWebhook: event.target.value })}
        />
        <small id="cxsHistoryWebhookHint">
          {say(
            "留空则不发送。Max 把最终文字和工具结果用 POST 发到这个地址（JSON，conversation.ended），用项目的签名密钥签名，失败时最多再试 3 次。它和“保存对话记录”互不影响。",
            "Leave empty to send nothing. Max POSTs the final text and tool outcomes to this address (JSON, conversation.ended), signed with the project's signing secret, and tries up to 3 more times when it fails. It is separate from keeping transcripts."
          )}
        </small>
      </label>
      {problem ? (
        <p className="cxWarn" role="status">
          {say("这个地址不能用：", "This address cannot be used: it ")}
          {problem}
        </p>
      ) : null}
      {unsaved && !problem ? (
        <p className="cxWarn" role="status">
          {say("请保存以生效", "Save to apply")}
        </p>
      ) : null}
      {saved ? (
        <div className="cxsHistoryWebhookActions">
          <button
            type="button"
            className="siteButton secondary small"
            onClick={() => void test()}
            disabled={testing || unsaved}
            aria-busy={testing}
          >
            {testing ? say("发送中…", "Sending…") : say("发送测试请求", "Send test request")}
          </button>
          <button type="button" className="siteButton secondary small" onClick={() => goTo("tools")}>
            {say("查看签名密钥", "Show the signing secret")}
          </button>
        </div>
      ) : null}
      <div aria-live="polite">
        {result && !unsaved ? (
          <p className={result.ok ? "cxMuted" : "cxWarn"}>
            {result.ok
              ? say(
                  `你的服务器收到了测试对话（HTTP ${result.status ?? 200}，${result.ms} ms）。`,
                  `Your server took the test conversation (HTTP ${result.status ?? 200}, ${result.ms} ms).`
                )
              : say(`测试没有送达：${result.error ?? ""}`, `The test did not arrive: ${result.error ?? ""}`)}
          </p>
        ) : null}
        {saved && delivery && !unsaved ? (
          <p className={delivery.ok ? "cxMuted" : "cxWarn"}>
            {say("最近一次对话：", "Last conversation: ")}
            {deliveryLine(delivery, say)} · {formatWhen(delivery.at, language)}
          </p>
        ) : null}
      </div>
      <p className="cxError" role="alert">
        {error}
      </p>
    </div>
  );
}

export function HistoryTab(props: StudioTabProps) {
  const { session, project, draft, updateStudio, dirty, goTo } = props;
  const say = useSay();
  const { language } = useLanguage();
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState("");
  const [open, setOpen] = useState<Conversation | null>(null);
  const alive = useRef(true);
  const scrollBack = useRef(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { api, token } = sessionRef.current;
      const result = await api.conversations(token, project.id);
      if (alive.current) setList(result.conversations);
    } catch (caught) {
      if (alive.current) setError(sessionRef.current.fail(caught));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  async function show(id: string) {
    setOpening(id);
    setError("");
    scrollBack.current = window.scrollY;
    try {
      const result = await session.api.conversation(session.token, id);
      if (!alive.current) return;
      setOpen(result.conversation);
      window.scrollTo(0, 0);
    } catch (caught) {
      if (alive.current) setError(session.fail(caught));
    } finally {
      if (alive.current) setOpening("");
    }
  }

  function back() {
    setOpen(null);
    const y = scrollBack.current;
    requestAnimationFrame(() => window.scrollTo(0, y));
  }

  const keep = draft.studio.keepConversations;
  const needsSave = dirty && keep !== project.studio.keepConversations;

  const setting = (
    <div className="cxsHistorySetting">
      <label className="cxsHistoryCheck">
        <input
          type="checkbox"
          checked={keep}
          onChange={(event) => updateStudio({ keepConversations: event.target.checked })}
        />
        <span>{say("保存对话记录 30 天", "Keep transcripts for 30 days")}</span>
      </label>
      <p className="cxMuted">
        {say(
          "点“保存”后生效。关闭后不再保存新的对话；已有的会在 30 天后过期，或在删除项目时一并删除。只保存最终文字和工具结果。",
          "Takes effect after you Save. Turning it off stops saving new ones; existing ones expire after 30 days or when the project is deleted. Only final text and tool results are kept."
        )}
      </p>
      {needsSave ? (
        <p className="cxWarn" role="status">
          {say("请保存以生效", "Save to apply")}
        </p>
      ) : null}
    </div>
  );

  if (open) {
    return (
      <div className="cxsHistory">
        <div className="cxsHistoryHead">
          <button type="button" className="siteButton secondary small" onClick={back}>
            {say("← 返回", "← Back")}
          </button>
          <span className="cxsHistoryBadge">{sourceLabel(open.source, say)}</span>
          <AnalysisMarks sentiment={open.sentiment} success={open.success} />
          <span className="cxMuted">
            {formatWhen(open.startedAt, language)} · {formatDuration(open.seconds)}
          </span>
        </div>
        {open.analysis ? <AnalysisView analysis={open.analysis} /> : null}
        {open.turns.length === 0 ? (
          <p className="cxMuted">{say("这段对话没有文字。", "This conversation has no words.")}</p>
        ) : (
          <ol className="cxsHistoryTurns" aria-label={say("对话内容", "Conversation")}>
            {open.turns.map((turn, index) => (
              <Turn key={index} turn={turn} language={language} say={say} />
            ))}
          </ol>
        )}
      </div>
    );
  }

  return (
    <div className="cxsHistory">
      <div className="cxsHistoryHead">
        <h3 className="cxsHistoryTitle">{say("对话", "Conversations")}</h3>
        <button type="button" className="siteButton secondary small" onClick={() => void load()} disabled={loading}>
          {say("刷新", "Refresh")}
        </button>
      </div>
      <div aria-live="polite" aria-busy={loading}>
        {loading && !list ? <p className="cxMuted">{say("加载中…", "Loading…")}</p> : null}
        {list ? <p className="cxMuted">{countSummary(list.length, say)}</p> : null}
      </div>
      <p className="cxError" role="alert">
        {error}
      </p>
      {list && list.length === 0 && !error ? (
        <div className="cxsHistoryEmpty">
          <p>{say("还没有对话。去“测试”里和你的助手聊聊。", "No conversations yet. Talk to your agent in Test.")}</p>
          <button type="button" className="siteButton small" onClick={() => goTo("test")}>
            {say("去测试", "Go to Test")}
          </button>
        </div>
      ) : null}
      {list && list.length > 0 ? (
        <ul className="cxsHistoryList">
          {list.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="cxsHistoryRow"
                onClick={() => void show(item.id)}
                disabled={opening !== ""}
                aria-busy={opening === item.id}
              >
                <span className="cxsHistoryMeta">
                  <span>{formatWhen(item.startedAt, language)}</span>
                  <span className="cxsHistoryDuration">{formatDuration(item.seconds)}</span>
                  <span className="cxsHistoryBadge">{sourceLabel(item.source, say)}</span>
                  <AnalysisMarks sentiment={item.sentiment} success={item.success} />
                  {opening === item.id ? <span className="cxMuted">{say("打开中…", "Opening…")}</span> : null}
                </span>
                <span className="cxsHistoryPreview">{item.preview.trim() || say("（没有文字）", "(no words)")}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {setting}
      <WebhookSetting {...props} />
      <AnalysisSetting {...props} />
    </div>
  );
}
