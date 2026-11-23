import { useEffect, useRef, useState } from "react";
import { DEFAULT_TRACES, STUDIO_LIMITS, toolUrlProblem, type StudioTraces } from "../../../shared/cloud-studio";
import type { TracesTestResult } from "../api";
import { useSay } from "../hooks";
import type { StudioTabProps } from "./types";

function hostOf(address: string): string {
  try {
    return new URL(address).origin;
  } catch {
    return "";
  }
}

/**
 * Where each conversation is traced: the address of the project's own OpenTelemetry collector, the headers it
 * wants (a secret: only ever typed in, never shown), whether what was said goes with it, and a test.
 */
export function TracesSetting({
  session,
  project,
  savedProject = project,
  release,
  releaseBusy,
  draft,
  update,
  updateStudio
}: StudioTabProps) {
  const say = useSay();
  const traces: StudioTraces = draft.studio.traces ?? DEFAULT_TRACES;
  const saved = (savedProject.studio.traces ?? DEFAULT_TRACES).endpoint;
  const endpoint = traces.endpoint;
  const unsaved = endpoint.trim() !== saved;
  const problem = endpoint.trim() ? toolUrlProblem(endpoint.trim()) : undefined;
  const hasHeaders = savedProject.hasTracesHeaders === true && !draft.removeTracesHeaders;
  // The relay removes saved headers when the traces go to another host: one collector's key is not sent to the next.
  const headersLeft =
    hasHeaders && unsaved && !(draft.tracesHeaders ?? "") && hostOf(endpoint.trim()) !== hostOf(saved);
  const [testing, setTesting] = useState(false);
  const revision = release?.draft?.id ?? release?.liveRevision;
  // Each with the endpoint it is about: what is known of one says nothing of the next.
  const [tested, setTested] = useState<{ of: string; result: TracesTestResult } | null>(null);

  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const result = tested?.of === (revision ?? saved) ? tested.result : null;
  const id = (suffix: string) => `cxsTraces-${project.id}-${suffix}`;

  async function test() {
    setTesting(true);
    setTested(null);
    setError("");
    try {
      const answer = await session.api.testTraces(
        session.token,
        project.id,
        ...(revision ? ([revision] as const) : [])
      );
      if (alive.current) setTested({ of: revision ?? saved, result: answer });
    } catch (caught) {
      if (alive.current) setError(session.fail(caught));
    } finally {
      if (alive.current) setTesting(false);
    }
  }

  return (
    <div className="cxsHistorySetting">
      <label className="cxField" htmlFor={id("endpoint")}>
        <span>
          {say("把对话的追踪发送到你的 OpenTelemetry 收集器", "Send traces of each conversation to your collector")}
        </span>
        <input
          id={id("endpoint")}
          type="url"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://cloud.langfuse.com/api/public/otel/v1/traces"
          maxLength={STUDIO_LIMITS.url}
          aria-invalid={problem ? true : undefined}
          aria-describedby={id("hint")}
          value={endpoint}
          onChange={(event) => updateStudio({ traces: { ...traces, endpoint: event.target.value } })}
        />
        <small id={id("hint")}>
          {say(
            "留空则不发送。每段对话一条追踪：每一轮一个 span（含各阶段耗时），每次工具调用一个 span。填收集器的完整地址（OTLP/HTTP，Langfuse、Honeycomb、Grafana Tempo、Datadog 等都可以）。",
            "Leave empty to send nothing. One trace per conversation: a span per turn with its timings, and a span per tool call. Enter the collector's full address (OTLP/HTTP: Langfuse, Honeycomb, Grafana Tempo, Datadog and others take it)."
          )}
        </small>
      </label>
      {problem ? (
        <p className="cxWarn" role="status">
          {say("这个地址不能用：", "This address cannot be used: it ")}
          {problem}
        </p>
      ) : null}
      <div className="cxField">
        <label htmlFor={id("headers")}>
          <span>{say("收集器的请求头", "The collector's request headers")}</span>
        </label>
        <div className="cxRow">
          <input
            id={id("headers")}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={2000}
            placeholder={hasHeaders ? say("•••• 已保存", "•••• saved") : "Authorization=Basic%20abc123,x-team=prod"}
            aria-describedby={id("headers-hint")}
            value={draft.tracesHeaders ?? ""}
            onChange={(event) => update({ tracesHeaders: event.target.value, removeTracesHeaders: false })}
          />
          {hasHeaders ? (
            <button
              type="button"
              className="siteButton secondary small"
              onClick={() => update({ tracesHeaders: "", removeTracesHeaders: true })}
            >
              {say("移除", "Remove")}
            </button>
          ) : null}
        </div>
        <small id={id("headers-hint")}>
          {hasHeaders
            ? say(
                "请求头已保存。输入新的内容会替换它们，留空表示不改。它们加密存放，不会再显示。",
                "Headers are saved. Typing here replaces them; leave empty to keep them. They are stored encrypted and never shown again."
              )
            : say(
                "通常是 API 密钥，写成 名称=值，多个用逗号分隔，值要 URL 编码。保存后加密存放，不会再显示。",
                "Usually an API key, written name=value, several separated by commas, values URL-encoded. Stored encrypted once saved and never shown again."
              )}
        </small>
      </div>
      <label className="cxsHistoryCheck">
        <input
          type="checkbox"
          checked={traces.content}
          onChange={(event) => updateStudio({ traces: { ...traces, content: event.target.checked } })}
        />
        <span>{say("包含对话内容", "Include what was said")}</span>
      </label>
      <p className="cxMuted">
        {say(
          "开启后，访客和助手说的话（每段最多 2000 字）会随追踪一起发送到这个收集器；关闭时只发送时间、工具名称和出错信息。",
          "With this on, transcripts (what the visitor and the agent said, up to 2,000 characters each) are sent to that collector; with it off, only timings, tool names and error messages are."
        )}
      </p>
      {headersLeft ? (
        <p className="cxWarn" role="status">
          {say(
            "已保存的请求头属于原来的收集器，保存新地址时会被移除。请在上面填写新收集器的请求头。",
            "The saved headers belong to the collector they were given for and are removed when this address is saved. Enter the new collector's headers above."
          )}
        </p>
      ) : null}
      {unsaved && !problem ? (
        <p className="cxWarn" role="status">
          {say("请发布以生效", "Publish to apply")}
        </p>
      ) : null}
      {saved ? (
        <div className="cxsHistoryWebhookActions">
          <button
            type="button"
            className="siteButton secondary small"
            onClick={() => void test()}
            disabled={
              releaseBusy || testing || unsaved || draft.removeTracesHeaders || (draft.tracesHeaders ?? "") !== ""
            }
            aria-busy={testing}
          >
            {testing ? say("发送中…", "Sending…") : say("发送测试追踪", "Send test trace")}
          </button>
        </div>
      ) : null}
      <div aria-live="polite">
        {result && !unsaved ? (
          <p className={result.ok ? "cxMuted" : "cxWarn"}>
            {result.ok
              ? say("收集器收到了测试追踪。", "Your collector took the test trace.")
              : say(`测试没有送达：${result.error}`, `The test did not arrive: ${result.error}`)}
          </p>
        ) : null}
        {draft.removeTracesHeaders ? (
          <p className="cxMuted">{say("发布后将移除请求头。", "Publishing will remove the headers.")}</p>
        ) : null}
      </div>
      <p className="cxError" role="alert">
        {error}
      </p>
    </div>
  );
}
