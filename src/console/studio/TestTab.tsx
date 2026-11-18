import "./test-tab.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceAgent, VoiceAgentError } from "../../../sdk/src/index";
import type { VoiceAgentStatus } from "../../../sdk/src/index";
import { useSay } from "../hooks";
import { applyAgentEvent, EMPTY_TEST_STATE, formatElapsed } from "./test-helpers";
import type { TimelineEntry } from "./test-helpers";
import { rememberStep } from "./types";
import type { StudioTabProps } from "./types";

type Say = (zh: string, en: string) => string;

/** The status in words. `started` is false before the first start. */
function statusText(say: Say, status: VoiceAgentStatus, started: boolean, muted: boolean): string {
  if (!started) return say("还没开始", "Not started yet");
  if (muted && status !== "connecting" && status !== "error" && status !== "closed" && status !== "idle") {
    return say("已静音", "Muted");
  }
  switch (status) {
    case "connecting":
      return say("正在连接…", "Connecting…");
    case "ready":
    case "listening":
    case "hearing":
      return say("正在听", "Listening");
    case "thinking":
      return say("正在思考", "Thinking");
    case "speaking":
      return say("正在说话", "Speaking");
    case "error":
      return say("出错了", "Something went wrong");
    default:
      return say("已结束", "Ended");
  }
}

function errorText(say: Say, error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof VoiceAgentError && error.code === "microphone") {
    return say(
      "麦克风被挡住了。请点地址栏左边的锁形图标，把麦克风设为“允许”，然后再试一次。",
      "The microphone is blocked. Click the lock icon next to the address bar, set Microphone to Allow, then try again."
    );
  }
  if (error instanceof VoiceAgentError && error.code === "token") {
    return message || say("无法开始测试。", "Could not start the test.");
  }
  return message || say("连接失败，请再试一次。", "The connection failed. Please try again.");
}

function TimelineRow({ entry, say }: { entry: TimelineEntry; say: Say }) {
  if (entry.kind === "tool") {
    let text = say(`正在使用 ${entry.name}…`, `Using ${entry.name}…`);
    if (entry.state === "succeeded") {
      text =
        entry.durationMs !== undefined
          ? say(
              `${entry.name} 成功了，用时 ${Math.round(entry.durationMs)} 毫秒`,
              `${entry.name} worked in ${Math.round(entry.durationMs)} ms`
            )
          : say(`${entry.name} 成功了`, `${entry.name} worked`);
    } else if (entry.state === "failed") {
      text = say(
        `${entry.name} 失败了：${entry.error ?? "未知原因"}`,
        `${entry.name} failed: ${entry.error ?? "unknown reason"}`
      );
    }
    return (
      <p className="cxsTestTool" data-state={entry.state}>
        {text}
      </p>
    );
  }
  const who = entry.role === "user" ? say("你", "You") : say("助手", "Agent");
  const classes = [
    "cxsTestBubble",
    entry.role === "user" ? "cxsTestBubbleUser" : "cxsTestBubbleAgent",
    entry.final ? "" : "cxsTestBubblePartial"
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <p className={classes}>
      <strong className="cxMuted">{who}: </strong>
      {entry.text}
    </p>
  );
}

export function TestTab({ session, project, draft, dirty, save, origin, goTo }: StudioTabProps) {
  const say = useSay();
  const agentRef = useRef<VoiceAgent | undefined>(undefined);
  const offRef = useRef<Array<() => void>>([]);
  const testedRef = useRef(false);
  const [state, setState] = useState(EMPTY_TEST_STATE);
  const [status, setStatus] = useState<VoiceAgentStatus>("idle");
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [connectedAt, setConnectedAt] = useState<number | undefined>();
  const [now, setNow] = useState(() => Date.now());
  const [saving, setSaving] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const release = useCallback(() => {
    offRef.current.forEach((off) => off());
    offRef.current = [];
    agentRef.current?.destroy();
    agentRef.current = undefined;
  }, []);

  useEffect(() => release, [release]);

  const live = started && status !== "idle" && status !== "closed" && status !== "error";
  const active = live && status !== "connecting";

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [state]);

  const stop = useCallback(() => {
    release();
    setStatus("closed");
    setMuted(false);
    setConnectedAt(undefined);
  }, [release]);

  const start = useCallback(async () => {
    release();
    setError("");
    setState(EMPTY_TEST_STATE);
    setMuted(false);
    setConnectedAt(undefined);
    const language = draft.studio.language || undefined;
    const agent = new VoiceAgent({
      url: origin,
      token: async () => (await session.api.testSession(session.token, project.id)).token,
      ...(language ? { language } : {})
    });
    agentRef.current = agent;
    offRef.current = [
      agent.on("status", (next) => {
        setStatus(next);
        setMuted(agent.muted);
        if (next === "ready" || next === "listening") {
          setConnectedAt((current) => current ?? Date.now());
          if (!testedRef.current) {
            testedRef.current = true;
            rememberStep(project.id, "tested");
          }
        }
      }),
      agent.on("transcript", ({ transcript }) =>
        setState((s) => applyAgentEvent(s, { type: "transcript", transcript }))
      ),
      agent.on("toolactivity", (event) =>
        setState((s) => applyAgentEvent(s, { type: "toolactivity", event, at: Date.now() }))
      ),
      agent.on("error", (problem) => setError(errorText(say, problem)))
    ];
    setStarted(true);
    setStatus("connecting");
    setNow(Date.now());
    try {
      await agent.start();
    } catch (problem) {
      if (agentRef.current === agent) setError(errorText(say, problem));
    }
  }, [release, draft.studio.language, origin, session, project.id, say]);

  const saveAndStart = async () => {
    setSaving(true);
    try {
      if (await save()) await start();
    } finally {
      setSaving(false);
    }
  };

  const send = (event: React.FormEvent) => {
    event.preventDefault();
    if (agentRef.current?.sendText(text)) setText("");
  };

  const toggleMute = () => {
    const agent = agentRef.current;
    if (!agent) return;
    if (agent.muted) agent.unmute();
    else agent.mute();
    setMuted(agent.muted);
  };

  if (!project.hasModelKey) {
    return (
      <div className="cxsTest">
        <p className="cxStatus">
          {say("测试前需要先添加模型密钥，助手要靠它来回答。", "Add a model key first. Your agent needs it to answer.")}
        </p>
        <div>
          <button type="button" className="siteButton" onClick={() => goTo("agent")}>
            {say("去添加模型密钥", "Add a model key")}
          </button>
        </div>
      </div>
    );
  }

  const elapsed = connectedAt !== undefined ? formatElapsed(now - connectedAt) : "00:00";
  const statusLine = statusText(say, status, started, muted);
  const micLabel = live ? say("停止测试", "Stop the test") : say("开始测试，对着麦克风说话", "Start the test and talk");

  return (
    <div className="cxsTest">
      {dirty ? (
        <div className="cxWarn" role="status">
          <p>
            {say(
              "你有没保存的修改。测试用的是已保存的版本。",
              "You have unsaved changes; the test uses the saved version."
            )}
          </p>
          <button
            type="button"
            className="siteButton small"
            disabled={saving || live}
            onClick={() => void saveAndStart()}
          >
            {say("保存并开始", "Save and start")}
          </button>
        </div>
      ) : null}

      <div className="cxsTestStage">
        <button
          type="button"
          className="cxsTestMic"
          aria-pressed={live}
          aria-label={micLabel}
          title={micLabel}
          disabled={saving}
          onClick={() => (live ? stop() : void start())}
        >
          <span aria-hidden="true">{live ? "■" : "🎤"}</span>
        </button>
        <p className="cxsTestStatus" role="status" aria-live="polite">
          <span>{statusLine}</span>
          {active ? <span className="cxsTestTimer">{elapsed}</span> : null}
        </p>
        <div className="cxsTestControls">
          {active ? (
            <button type="button" className="siteButton secondary small" aria-pressed={muted} onClick={toggleMute}>
              {muted ? say("取消静音", "Unmute") : say("静音", "Mute")}
            </button>
          ) : null}
          <button
            type="button"
            className="siteButton quiet small"
            disabled={state.entries.length === 0}
            onClick={() => setState((s) => applyAgentEvent(s, { type: "clear" }))}
          >
            {say("清空", "Clear")}
          </button>
        </div>
      </div>

      {error ? (
        <p className="cxError" role="alert">
          {error}
        </p>
      ) : null}

      <div
        className="cxsTestLog"
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-label={say("对话记录", "Conversation")}
      >
        {state.entries.length === 0 ? (
          <p className="cxsTestEmpty">
            {say(
              "点上面的麦克风，然后开口说话。你说的话会显示在这里。",
              "Press the microphone above and start talking. What you say shows up here."
            )}
          </p>
        ) : (
          state.entries.map((entry) => <TimelineRow key={entry.id} entry={entry} say={say} />)
        )}
      </div>

      <form className="cxsTestSend" onSubmit={send}>
        <label className="cxField" style={{ flex: 1, margin: 0 }}>
          <span className="cxMuted">{say("或者打字发送", "Or type a message")}</span>
          <input
            value={text}
            maxLength={2000}
            disabled={!active}
            placeholder={say("开始测试后可以打字", "Available once the test has started")}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="siteButton secondary"
          disabled={!active || !text.trim()}
          style={{ alignSelf: "end" }}
        >
          {say("发送", "Send")}
        </button>
      </form>

      <p className="cxsTestNote">
        {say("测试的分钟数会算进你的免费分钟。", "Test minutes count toward your free minutes.")}
      </p>
      <p className="cxsTestNote">
        {say(
          "在你自己网页里运行的工具（客户端工具）在这里不会运行；服务器工具会运行。",
          "Tools that run in your own web page (client tools) don't run here; server tools do."
        )}
      </p>
    </div>
  );
}
