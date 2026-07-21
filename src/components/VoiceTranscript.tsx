import { Flag } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { HelmetAgent } from "../hooks/useHelmetAgent";
import { formatClockTime } from "../lib/utils";
import type { TranscriptItem } from "../types";

const TURN_FLAG_REASONS = ["听错了", "回答不对", "太慢", "不安全"] as const;

export function VoiceTranscript({ agent }: { agent: HelmetAgent }) {
  const [flagTargetId, setFlagTargetId] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const visibleItems = agent.transcript.slice(-8);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [visibleItems.length]);

  const flagTurn = (item: TranscriptItem, reason: string) => {
    if (agent.sendTurnFeedback(item, reason)) setFlagTargetId(null);
  };

  return (
    <section className="voiceTranscript" aria-label="实时字幕">
      <div className="voiceTranscriptHead">
        <div>
          <span aria-hidden="true" />
          <strong>实时字幕</strong>
        </div>
        <small>{visibleItems.length ? `${visibleItems.length} 条` : "等待对话"}</small>
      </div>
      <div className="voiceTranscriptList" ref={listRef} aria-live="polite">
        {visibleItems.length ? (
          visibleItems.map((item) => (
            <article className={`voiceMessage ${item.speaker}`} key={item.id}>
              <div>
                <strong>{item.speaker === "rider" ? "你" : "Max"}</strong>
                <time dateTime={new Date(item.at).toISOString()}>{formatClockTime(item.at)}</time>
                {!item.final ? <small>实时</small> : null}
                {agent.canFlagTurn(item) ? (
                  <button
                    type="button"
                    className="voiceFlagButton"
                    aria-expanded={flagTargetId === item.id}
                    aria-label="标记这条对话"
                    onClick={() => setFlagTargetId((id) => (id === item.id ? null : item.id))}
                  >
                    <Flag size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <p>{item.text}</p>
              {item.feedback ? <span className="voiceFeedback">已标记 · {item.feedback}</span> : null}
              {flagTargetId === item.id && agent.canFlagTurn(item) ? (
                <div className="voiceFlagReasons" role="group" aria-label="反馈原因">
                  {TURN_FLAG_REASONS.map((reason) => (
                    <button type="button" key={reason} onClick={() => flagTurn(item, reason)}>
                      {reason}
                    </button>
                  ))}
                </div>
              ) : null}
            </article>
          ))
        ) : (
          <div className="voiceTranscriptEmpty">
            <strong>你好，我是 Max。</strong>
            <p>开启免提后直接讲话。我可以帮你查看天气、路线和骑行状态。</p>
          </div>
        )}
      </div>
    </section>
  );
}
