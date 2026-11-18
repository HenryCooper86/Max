import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "../../components/LanguageToggle";
import type { Conversation, ConversationSummary, ConversationTurn } from "../api";
import { useSay } from "../hooks";
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

export function HistoryTab({ session, project, draft, updateStudio, dirty, goTo }: StudioTabProps) {
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
          <span className="cxMuted">
            {formatWhen(open.startedAt, language)} · {formatDuration(open.seconds)}
          </span>
        </div>
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
                  {opening === item.id ? <span className="cxMuted">{say("打开中…", "Opening…")}</span> : null}
                </span>
                <span className="cxsHistoryPreview">{item.preview.trim() || say("（没有文字）", "(no words)")}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {setting}
    </div>
  );
}
