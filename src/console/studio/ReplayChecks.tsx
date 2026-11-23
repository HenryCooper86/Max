import { useEffect, useRef, useState } from "react";
import type { ReplayCheck } from "../../../shared/studio-replay";
import { ApiError } from "../api";
import { useSay, type Session } from "../hooks";

/** Rate-limited requests have not started a paid replay. Allow one sliding window to clear. */
function waitForCapacity(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 60_100);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

export function ReplayChecks({
  checks,
  session,
  projectId,
  revision,
  disabled,
  refresh
}: {
  checks: ReplayCheck[];
  session: Session;
  projectId: string;
  revision: string;
  disabled: boolean;
  refresh: () => Promise<void>;
}) {
  const say = useSay();
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [projectId, revision, session.token]
  );
  const runAll = async () => {
    if (active.current || disabled || !checks.length) return;
    const controller = new AbortController();
    active.current = controller;
    const signal = controller.signal;
    setError("");
    try {
      for (const [i, item] of checks.entries()) {
        if (signal.aborted) break;
        const play = () =>
          session.api.runReplayCase(session.token, projectId, item.id, { version: item.version, revision }, signal);
        setProgress(say(`正在运行 ${i + 1}/${checks.length}`, `Running ${i + 1} of ${checks.length}`));
        try {
          try {
            await play();
          } catch (cause) {
            if (!(cause instanceof ApiError && cause.status === 429) || signal.aborted) throw cause;
            setProgress(say("已达到请求上限，一分钟后继续。", "Rate limit reached. Resuming in one minute."));
            await waitForCapacity(signal);
            if (signal.aborted) break;
            await play();
          }
        } catch (cause) {
          // Completed execution errors are recorded by the relay. Continue checking the other cases.
          if (!(cause instanceof ApiError && [422, 502, 504].includes(cause.status))) throw cause;
        }
      }
    } catch (cause) {
      if (!signal.aborted) setError(session.fail(cause));
    } finally {
      if (active.current === controller) {
        try {
          await refresh();
        } finally {
          if (active.current === controller) {
            active.current = null;
            setProgress("");
          }
        }
      }
    }
  };
  if (!checks.length) return null;
  const passed = checks.filter((c) => c.outcome?.status === "passed").length;
  return (
    <section className="cxsReplay" aria-label={say("发布前回放检查", "Pre-publish replay checks")}>
      <h4>{say("已保存的回放测试", "Saved replay tests")}</h4>
      <p>
        {say(
          `当前草稿通过 ${passed}/${checks.length} 项。回放使用账户分钟数和模拟工具响应。`,
          `${passed} of ${checks.length} passed for this draft. Replays use account minutes and simulated tool responses.`
        )}
      </p>
      <button
        type="button"
        className="siteButton secondary small"
        disabled={!!progress || disabled}
        onClick={() => void runAll()}
      >
        {say(`运行全部 ${checks.length} 项测试`, `Run all ${checks.length} tests`)}
      </button>
      {progress && (
        <>
          <span role="status"> {progress} </span>
          <button type="button" className="siteButton quiet small" onClick={() => active.current?.abort()}>
            {say("停止回放", "Stop replays")}
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {checks.map((c) => (
        <details key={c.id}>
          <summary>
            {c.prompt} ·{" "}
            {c.outcome?.status === "passed"
              ? say("通过", "Passed")
              : c.outcome?.status === "failed"
                ? say("未通过", "Failed")
                : c.outcome?.status === "error"
                  ? say("运行出错", "Execution error")
                  : c.stale
                    ? say("需要重新运行", "Needs rerun")
                    : say("尚未运行", "Not run")}
          </summary>
          <p>
            {say("预期短语", "Expected phrase")} · {c.expected}
          </p>
          {c.outcome &&
            (c.outcome.status === "error" ? (
              <p>{c.outcome.message}</p>
            ) : (
              <>
                <p>
                  {say("实际回答", "Actual answer")} · {c.outcome.answer || say("没有回答", "No answer")}
                </p>
                {c.outcome.missingTools.length > 0 && (
                  <p>
                    {say("缺少模拟响应", "Missing simulated response")} · {c.outcome.missingTools.join(", ")}
                  </p>
                )}
              </>
            ))}
        </details>
      ))}
    </section>
  );
}
