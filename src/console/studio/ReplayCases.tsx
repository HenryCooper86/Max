import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { REPLAY_LIMITS, type ReplayCase, type ReplayCaseInput, type ReplayRun } from "../../../shared/studio-replay";
import { SECTION_LEAVE_EVENT } from "../../lib/section-leave";
import { ApiError } from "../api";
import { useSay, type Session } from "../hooks";
import "./replay-cases.css";

type Props = {
  session: Session;
  projectId: string;
  revision: string | null;
  canReplay: boolean;
  seed: ReplayCaseInput | null;
  onSeedConsumed: () => void;
  onDraftMayBeStale?: () => void;
};

type Fields = { prompt: string; expected: string; fixtures: string };
type Editor = { saved: ReplayCase | null; fields: Fields; fromHistory: boolean; edited?: boolean };
type Say = ReturnType<typeof useSay>;

function fieldsFor(input: ReplayCaseInput): Fields {
  return { prompt: input.prompt, expected: input.expected, fixtures: JSON.stringify(input.fixtures, null, 2) };
}

function readFixtures(raw: string, say: Say): ReplayCaseInput["fixtures"] {
  let fixtures: unknown;
  try {
    fixtures = JSON.parse(raw, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Nonfinite JSON number");
      return value;
    });
  } catch {
    throw new Error(say("请输入有效的 JSON 对象。", "Enter a valid JSON object."));
  }
  if (!fixtures || typeof fixtures !== "object" || Array.isArray(fixtures)) {
    throw new Error(say("请输入有效的 JSON 对象。", "Enter a valid JSON object."));
  }
  if (
    Object.keys(fixtures).length > REPLAY_LIMITS.fixtures ||
    new TextEncoder().encode(JSON.stringify(fixtures)).length > REPLAY_LIMITS.fixtureBytes
  ) {
    throw new Error(
      say(
        `模拟响应最多包含 ${REPLAY_LIMITS.fixtures} 项，共 ${REPLAY_LIMITS.fixtureBytes} 字节。`,
        `Use up to ${REPLAY_LIMITS.fixtures} mock responses and ${REPLAY_LIMITS.fixtureBytes} bytes total.`
      )
    );
  }
  return fixtures as ReplayCaseInput["fixtures"];
}

function changed(editor: Editor): boolean {
  if (!editor.saved) return true;
  const savedFields = fieldsFor(editor.saved);
  return Object.keys(savedFields).some(
    (key) => editor.fields[key as keyof Fields] !== savedFields[key as keyof Fields]
  );
}

function Result({ run, expected, say }: { run: ReplayRun; expected: string; say: Say }) {
  return (
    <div className="cxsReplayResult" aria-live="polite">
      <strong>{run.passed ? say("通过", "Passed") : say("失败", "Failed")}</strong>
      <p className="cxMuted">{say(`运行草稿版本 ${run.revision}`, `Ran draft revision ${run.revision}`)}</p>
      <dl>
        <dt>{say("预期包含", "Expected to contain")}</dt>
        <dd>{expected}</dd>
        <dt>{say("实际回答", "Actual answer")}</dt>
        <dd>{run.answer || say("无回答", "No answer")}</dd>
      </dl>
      {run.tools.length > 0 && (
        <ul aria-label={say("工具调用", "Tool calls")}>
          {run.tools.map(({ name, mocked }, index) => (
            <li key={index}>
              <code>{name}</code> ·{" "}
              {mocked ? say("已使用模拟响应", "Used mock response") : say("缺少模拟响应", "Missing mock response")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ReplayCases(props: Props) {
  return <ProjectReplayCases key={props.projectId} {...props} />;
}

function ProjectReplayCases({
  session: { api, token, fail },
  projectId,
  revision,
  canReplay,
  seed,
  onSeedConsumed,
  onDraftMayBeStale
}: Props) {
  const say = useSay();
  const headingId = useId();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const activeRun = useRef<AbortController | null>(null);
  const lastFocusRequest = useRef(0);
  const [focusRequest, setFocusRequest] = useState(0);
  const [cases, setCases] = useState<ReplayCase[] | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [run, setRun] = useState<ReplayRun | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | "run" | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.replayCases(token, projectId).then(
      ({ cases }) => {
        if (!active) return;
        setCases(cases);
        setListError(null);
      },
      (cause: unknown) => {
        if (active) setListError(fail(cause));
      }
    );
    return () => {
      active = false;
    };
  }, [api, token, projectId, fail, reload]);

  useEffect(() => {
    // A replaced draft makes the previously submitted replay obsolete.
    if (activeRun.current?.signal.aborted) {
      activeRun.current = null;
      setBusy(null);
    }
    return () => activeRun.current?.abort();
  }, [api, token, revision]);

  useEffect(() => {
    if (!seed) return;
    setEditor({ saved: null, fields: fieldsFor(seed), fromHistory: true });
    setFocusRequest((current) => current + 1);
    setConfirm(null);
    setError("");
    onSeedConsumed();
  }, [seed, onSeedConsumed]);

  useEffect(() => {
    if (!busy && focusRequest !== lastFocusRequest.current) {
      lastFocusRequest.current = focusRequest;
      promptRef.current?.focus();
    }
  }, [busy, focusRequest]);

  const unsaved = !!editor?.edited && changed(editor);
  const discardMessage = say("放弃未保存的用例编辑？", "Discard the unsaved test case edits?");
  useEffect(() => {
    if (!unsaved) return;
    const leave = (event: Event) => {
      if (!event.defaultPrevented && !window.confirm(discardMessage)) event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener(SECTION_LEAVE_EVENT, leave);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener(SECTION_LEAVE_EVENT, leave);
      window.removeEventListener("beforeunload", unload);
    };
  }, [unsaved, discardMessage]);

  function open(saved: ReplayCase | null) {
    if (unsaved && !window.confirm(discardMessage)) return;
    setEditor({
      saved,
      fields: fieldsFor(saved ?? { prompt: "", expected: "", fixtures: {} }),
      fromHistory: false
    });
    setFocusRequest((current) => current + 1);
    setConfirm(null);
    setError("");
  }

  function edit(field: keyof Fields, value: string) {
    setEditor((current) => current && { ...current, edited: true, fields: { ...current.fields, [field]: value } });
  }

  function report(cause: unknown, action: "create" | "save" | "delete" | "run") {
    if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404)) {
      setCases(null);
      if (action === "run" && cause.status === 409) onDraftMayBeStale?.();
      setReload((current) => current + 1);
      setError(
        action === "run"
          ? say(
              "用例或草稿版本已更改。请核对最新版本后重试。",
              "The case or draft revision changed. Check the latest versions and try again."
            )
          : action === "create"
            ? fail(cause)
            : say("此用例已更改。请打开最新版本后重试。", "This case changed. Open its latest version and try again.")
      );
    } else {
      setError(fail(cause) || say("操作失败，请重试。", "The request failed. Try again."));
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || !cases || busy || editorStale || !changed(editor) || (!editor.saved && limitReached)) return;
    const { prompt, expected } = editor.fields;
    setError("");
    if (
      !prompt.trim() ||
      prompt.length > REPLAY_LIMITS.prompt ||
      !expected.trim() ||
      expected.length > REPLAY_LIMITS.expected
    ) {
      setError(
        say(
          "请在字符限制内填写用户消息和预期文本。",
          "Enter a user message and expected text within the character limits."
        )
      );
      return;
    }
    let fixtures: ReplayCaseInput["fixtures"];
    try {
      fixtures = readFixtures(editor.fields.fixtures, say);
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    const input = { prompt: prompt.trim(), expected: expected.trim(), fixtures };
    setBusy("save");
    try {
      const { testCase } = editor.saved
        ? await api.updateReplayCase(token, projectId, editor.saved.id, { ...input, version: editor.saved.version })
        : await api.createReplayCase(token, projectId, input);
      setCases((current) =>
        editor.saved
          ? (current?.map((item) => (item.id === testCase.id ? testCase : item)) ?? null)
          : [...(current ?? []), testCase]
      );
      setEditor((current) =>
        current === editor ? { saved: testCase, fields: fieldsFor(testCase), fromHistory: false } : current
      );
      setRun((current) => (current?.caseId === testCase.id ? null : current));
    } catch (cause) {
      report(cause, editor.saved ? "save" : "create");
    } finally {
      setBusy(null);
    }
  }

  async function remove(item: ReplayCase) {
    if (busy || confirm !== item.id) return;
    setError("");
    setBusy("delete");
    try {
      await api.deleteReplayCase(token, projectId, item.id, item.version);
      setCases((current) => current?.filter((candidate) => candidate.id !== item.id) ?? null);
      setEditor((current) => (current?.saved?.id === item.id ? null : current));
      setRun((current) => (current?.caseId === item.id ? null : current));
    } catch (cause) {
      report(cause, "delete");
    } finally {
      setConfirm(null);
      setBusy(null);
    }
  }

  async function runCase(item: ReplayCase) {
    if (busy || activeRun.current || !revision || !canReplay || (editor?.saved?.id === item.id && changed(editor)))
      return;
    const controller = new AbortController();
    activeRun.current = controller;
    setError("");
    setRun(null);
    setBusy("run");
    try {
      const result = await api.runReplayCase(
        token,
        projectId,
        item.id,
        { version: item.version, revision },
        controller.signal
      );
      if (controller.signal.aborted) return;
      if (
        result.run.caseId === item.id &&
        result.run.caseVersion === item.version &&
        result.run.revision === revision
      ) {
        setRun(result.run);
      } else {
        report(new ApiError("request", "Replay target changed", 409), "run");
      }
    } catch (cause) {
      if (!controller.signal.aborted) report(cause, "run");
    } finally {
      if (!controller.signal.aborted) {
        activeRun.current = null;
        setBusy(null);
      }
    }
  }

  const limitReached = (cases?.length ?? 0) >= REPLAY_LIMITS.cases;
  const editorStale =
    !!editor?.saved && !cases?.some((item) => item.id === editor.saved?.id && item.version === editor.saved.version);
  return (
    <section className="cxsReplay" aria-labelledby={headingId}>
      <div className="cxsReplayHeader">
        <h3 id={headingId}>{say("文本回放用例", "Text replay cases")}</h3>
        <button
          type="button"
          className="siteButton secondary small"
          disabled={!cases || !!busy || limitReached}
          onClick={() => open(null)}
        >
          {say("新建用例", "New case")}
        </button>
      </div>
      <p className="cxMuted">
        {say(
          "回放使用草稿的模型并消耗账户分钟数，只使用模拟工具响应。发布前仍需通过语音或文字与草稿对话。",
          "Replay uses the draft’s model and account minutes, with simulated tool responses only. Before publishing, test the draft interactively by voice or text."
        )}
      </p>
      <p className="cxMuted">
        {revision && canReplay
          ? say(`运行目标是已保存的草稿版本 ${revision}。`, `Runs target saved draft revision ${revision}.`)
          : say("回放需要已保存且配置了模型的草稿。", "Replay requires a saved draft with a configured model.")}
      </p>
      {error && (
        <p className="cxError" role="alert">
          {error}
        </p>
      )}
      {listError !== null && (
        <div className="cxsReplayActions">
          <p className="cxError" role="alert">
            {listError || say("无法加载用例。", "Could not load cases.")}
          </p>
          <button
            type="button"
            className="siteButton secondary small"
            onClick={() => {
              setListError(null);
              setReload((current) => current + 1);
            }}
          >
            {say("重试", "Retry")}
          </button>
        </div>
      )}
      {limitReached && (
        <p className="cxMuted">
          {say(
            `已达到 ${REPLAY_LIMITS.cases} 个用例的上限。`,
            `The limit of ${REPLAY_LIMITS.cases} cases has been reached.`
          )}
        </p>
      )}
      {editor && (
        <form className="cxsReplayEditor" onSubmit={(event) => void save(event)}>
          {editor.fromHistory && (
            <p className="cxMuted">
              {say(
                "保存前请检查并删除用户消息里的敏感信息。",
                "Review the user message and remove sensitive information before saving."
              )}
            </p>
          )}
          <label className="cxField">
            <span>{say("用户消息", "User message")}</span>
            <textarea
              ref={promptRef}
              value={editor.fields.prompt}
              maxLength={REPLAY_LIMITS.prompt}
              rows={4}
              required
              disabled={!!busy}
              onChange={(event) => edit("prompt", event.target.value)}
            />
          </label>
          <label className="cxField">
            <span>{say("预期包含的文本（忽略大小写）", "Expected text (case-insensitive substring)")}</span>
            <input
              value={editor.fields.expected}
              maxLength={REPLAY_LIMITS.expected}
              required
              disabled={!!busy}
              onChange={(event) => edit("expected", event.target.value)}
            />
          </label>
          <label className="cxField">
            <span>{say("模拟工具响应（JSON）", "Mock tool responses (JSON)")}</span>
            <textarea
              value={editor.fields.fixtures}
              rows={4}
              spellCheck={false}
              disabled={!!busy}
              onChange={(event) => edit("fixtures", event.target.value)}
            />
            <span className="cxMuted">
              {say(
                "用工具名称作为键，模拟响应作为值。缺少响应时用例会失败。",
                "Use tool names as keys and simulated responses as values. A missing response fails the case."
              )}
            </span>
          </label>
          <div className="cxsReplayActions">
            <button
              type="submit"
              className="siteButton primary small"
              disabled={!!busy || !cases || editorStale || !changed(editor) || (!editor.saved && limitReached)}
            >
              {busy === "save" ? say("正在保存…", "Saving…") : say("保存用例", "Save case")}
            </button>
            <button
              type="button"
              className="siteButton quiet small"
              disabled={!!busy}
              onClick={() => {
                setEditor(null);
                setError("");
              }}
            >
              {say("取消", "Cancel")}
            </button>
          </div>
        </form>
      )}
      {cases ? (
        cases.length > 0 ? (
          <ul className="cxsReplayList">
            {cases.map((item) => {
              const promptId = `${headingId}-${item.id}`;
              const expectedId = `${promptId}-expected`;
              const dirty = editor?.saved?.id === item.id && changed(editor);
              return (
                <li key={item.id} className="cxsReplayCase">
                  <p id={promptId} className="cxsReplayPrompt">
                    {item.prompt}
                  </p>
                  <p id={expectedId} className="cxMuted">
                    {say("预期包含：", "Expected to contain ")}
                    {item.expected}
                  </p>
                  <div className="cxsReplayActions">
                    <button
                      type="button"
                      className="siteButton secondary small"
                      disabled={!!busy || !canReplay || !revision || dirty}
                      aria-describedby={`${promptId} ${expectedId}`}
                      onClick={() => void runCase(item)}
                    >
                      {say("运行", "Run")}
                    </button>
                    <button
                      type="button"
                      className="siteButton quiet small"
                      disabled={!!busy}
                      aria-describedby={`${promptId} ${expectedId}`}
                      onClick={() => open(item)}
                    >
                      {say("编辑", "Edit")}
                    </button>
                    <button
                      type="button"
                      className="siteButton quiet small"
                      disabled={!!busy || confirm === item.id}
                      aria-describedby={`${promptId} ${expectedId}`}
                      onClick={() => {
                        setConfirm(item.id);
                        setError("");
                      }}
                    >
                      {say("删除", "Delete")}
                    </button>
                  </div>
                  {confirm === item.id && (
                    <div className="cxsReplayActions">
                      <span role="status">{say("永久删除此用例？", "Permanently delete this case?")}</span>
                      <button
                        type="button"
                        className="siteButton secondary small"
                        disabled={!!busy}
                        onClick={() => void remove(item)}
                      >
                        {say("确认删除", "Confirm delete")}
                      </button>
                      <button
                        type="button"
                        className="siteButton quiet small"
                        disabled={!!busy}
                        onClick={() => setConfirm(null)}
                      >
                        {say("取消删除", "Cancel deletion")}
                      </button>
                    </div>
                  )}
                  {!dirty &&
                    run &&
                    run.caseId === item.id &&
                    run.caseVersion === item.version &&
                    run.revision === revision && <Result run={run} expected={item.expected} say={say} />}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="cxMuted">{say("还没有保存的用例。", "No saved cases yet.")}</p>
        )
      ) : (
        listError === null && <p role="status">{say("正在加载用例…", "Loading cases…")}</p>
      )}
      {busy === "run" && <p role="status">{say("正在运行回放…", "Running replay…")}</p>}
    </section>
  );
}
