import { Flag } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { HelmetAgent } from "../hooks/useHelmetAgent";
import { deviceCopyKey } from "../lib/i18n";
import { formatClockTime } from "../lib/utils";
import type { TranscriptItem } from "../types";
import { useAssistant } from "./AssistantContext";
import { useLanguage } from "./LanguageToggle";

const TURN_FLAG_REASONS = ["听错了", "回答不对", "太慢", "不安全"] as const;

export function VoiceTranscript({ agent }: { agent: HelmetAgent }) {
  const { t } = useLanguage();
  const assistant = useAssistant();
  const [flagTargetId, setFlagTargetId] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const visibleItems = agent.transcript.slice(-8);

  useEffect(() => {
    if (visibleItems.length > 0) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [visibleItems.length]);

  const flagTurn = (item: TranscriptItem, reason: string) => {
    if (agent.sendTurnFeedback(item, reason)) setFlagTargetId(null);
  };

  return (
    <section className="voiceTranscript" aria-label={t("transcript.aria")}>
      <div className="voiceTranscriptHead">
        <strong>{t("transcript.title")}</strong>
        <small>
          {visibleItems.length ? t("transcript.items", { count: visibleItems.length }) : t("transcript.waiting")}
        </small>
      </div>
      <div className="voiceTranscriptList" ref={listRef} aria-live="polite">
        {visibleItems.length ? (
          visibleItems.map((item) => (
            <article className={`voiceMessage ${item.speaker}`} key={item.id}>
              <div>
                <strong>{item.speaker === "rider" ? t("transcript.you") : assistant.name}</strong>
                <time dateTime={new Date(item.at).toISOString()}>{formatClockTime(item.at)}</time>
                {!item.final ? <small>{t("transcript.live")}</small> : null}
                {agent.canFlagTurn(item) ? (
                  <button
                    type="button"
                    className="voiceFlagButton"
                    aria-expanded={flagTargetId === item.id}
                    aria-label={t("transcript.flag")}
                    onClick={() => setFlagTargetId((id) => (id === item.id ? null : item.id))}
                  >
                    <Flag size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <p>{item.text}</p>
              {item.feedback ? <span className="voiceFeedback">已标记 · {item.feedback}</span> : null}
              {flagTargetId === item.id && agent.canFlagTurn(item) ? (
                <div className="voiceFlagReasons" role="group" aria-label={t("transcript.feedbackReasons")}>
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
            <strong>{t("transcript.greeting")}</strong>
            <p>{t(deviceCopyKey("transcript.help", assistant.device))}</p>
          </div>
        )}
      </div>
    </section>
  );
}
