import { useState } from "react";
import { STUDIO_LIMITS, toolUrlProblem, type StudioParameter, type StudioTool } from "../../../shared/cloud-studio";
import { useLanguage } from "../../components/LanguageToggle";
import { findTemplate } from "../../lib/agent-templates";
import { CopyButton } from "../CopyButton";
import { useSay } from "../hooks";
import type { StudioTabProps } from "./types";
import {
  EXPRESS_EXAMPLE,
  blankParameter,
  blankTool,
  coerceSampleArgs,
  exampleRequest,
  parseOptions,
  sanitizeToolName,
  savedUnchanged,
  toolFromSuggestion,
  truncateJson
} from "./tools-helpers";
import "./tools-tab.css";

const DOCS_URL = "https://github.com/HenryCooper86/Max/blob/main/docs/tools.md#client-tools";

type TestState = { busy: boolean; ok?: boolean; text?: string; ms?: number };

function NameInput({
  value,
  label,
  hint,
  onCommit
}: {
  value: string;
  label: string;
  hint?: string;
  onCommit: (next: string) => void;
}) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value);
  }
  return (
    <label className="cxField">
      <span>{label}</span>
      <input
        value={text}
        spellCheck={false}
        autoCapitalize="none"
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const next = sanitizeToolName(text);
          setText(next);
          onCommit(next);
        }}
      />
      {hint ? <small className="cxMuted">{hint}</small> : null}
    </label>
  );
}

function ToolTest({ tool, props, saved }: { tool: StudioTool; props: StudioTabProps; saved: boolean }) {
  const say = useSay();
  const { session, project } = props;
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, setState] = useState<TestState>({ busy: false });

  async function run() {
    const { args, missing, invalid } = coerceSampleArgs(tool.parameters, values);
    if (missing.length || invalid.length) {
      setState({
        busy: false,
        ok: false,
        text: missing.length
          ? say(`请填写：${missing.join("、")}`, `Fill in: ${missing.join(", ")}`)
          : say(`需要数字：${invalid.join("、")}`, `Needs a number: ${invalid.join(", ")}`)
      });
      return;
    }
    setState({ busy: true });
    try {
      const result = await session.api.testTool(session.token, project.id, tool.name, args);
      setState(
        result.ok
          ? { busy: false, ok: true, text: truncateJson(result.result), ms: result.ms }
          : { busy: false, ok: false, text: result.error, ms: result.ms }
      );
    } catch (error) {
      setState({ busy: false, ok: false, text: session.fail(error) });
    }
  }

  return (
    <div className="cxsToolsTest">
      <strong>{say("发送测试请求", "Send a test request")}</strong>
      {saved ? (
        <>
          {tool.parameters.map((parameter) => (
            <label className="cxField" key={parameter.name}>
              <span>
                {parameter.name}
                {parameter.type === "number"
                  ? say("（数字）", " (number)")
                  : parameter.type === "boolean"
                    ? say("（是/否）", " (yes or no)")
                    : ""}
              </span>
              {parameter.type === "boolean" ? (
                <select
                  value={values[parameter.name] ?? ""}
                  onChange={(event) => setValues({ ...values, [parameter.name]: event.target.value })}
                >
                  <option value="">{say("不填", "Leave out")}</option>
                  <option value="true">{say("是", "Yes")}</option>
                  <option value="false">{say("否", "No")}</option>
                </select>
              ) : (
                <input
                  value={values[parameter.name] ?? ""}
                  inputMode={parameter.type === "number" ? "decimal" : undefined}
                  onChange={(event) => setValues({ ...values, [parameter.name]: event.target.value })}
                />
              )}
            </label>
          ))}
          <div className="cxsToolsActions">
            <button
              type="button"
              className="siteButton secondary small"
              disabled={state.busy}
              onClick={() => void run()}
            >
              {state.busy ? say("发送中…", "Sending…") : say("发送测试", "Send test")}
            </button>
          </div>
        </>
      ) : (
        <p className="cxMuted">{say("保存后才能测试这个工具。", "Save to test this tool.")}</p>
      )}
      <div aria-live="polite">
        {state.text !== undefined ? (
          <>
            <p className={state.ok ? "cxStatus cxsToolsOk" : "cxError"}>
              {state.ok ? say("成功", "It worked") : say("没成功", "It failed")}
              {state.ms !== undefined ? ` · ${state.ms} ms` : ""}
            </p>
            <pre className="cxsToolsResult">{state.text}</pre>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ParameterRow({
  parameter,
  index,
  toolName,
  onChange,
  onRemove
}: {
  parameter: StudioParameter;
  index: number;
  toolName: string;
  onChange: (patch: Partial<StudioParameter>) => void;
  onRemove: () => void;
}) {
  const say = useSay();
  const [options, setOptions] = useState(parameter.options.join(", "));
  const id = `${toolName}-p${index}`;
  return (
    <div className="cxsToolsParam" role="group" aria-label={say(`参数 ${index + 1}`, `Parameter ${index + 1}`)}>
      <label className="cxField" htmlFor={`${id}-name`}>
        <span>{say("名称", "Name")}</span>
        <input
          id={`${id}-name`}
          value={parameter.name}
          spellCheck={false}
          autoCapitalize="none"
          onChange={(event) => onChange({ name: event.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 40) })}
        />
      </label>
      <label className="cxField" htmlFor={`${id}-type`}>
        <span>{say("类型", "Type")}</span>
        <select
          id={`${id}-type`}
          value={parameter.type}
          onChange={(event) => {
            const type = event.target.value as StudioParameter["type"];
            onChange(type === "string" ? { type } : { type, options: [] });
            if (type !== "string") setOptions("");
          }}
        >
          <option value="string">{say("文字", "Text")}</option>
          <option value="number">{say("数字", "Number")}</option>
          <option value="boolean">{say("是或否", "Yes or no")}</option>
        </select>
      </label>
      <label className="cxField" htmlFor={`${id}-desc`}>
        <span>{say("说明", "Description")}</span>
        <input
          id={`${id}-desc`}
          value={parameter.description}
          maxLength={STUDIO_LIMITS.parameterDescription}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </label>
      {parameter.type === "string" ? (
        <label className="cxField" htmlFor={`${id}-options`}>
          <span>{say("可选值（用逗号分隔，可不填）", "Allowed values (comma-separated, optional)")}</span>
          <input
            id={`${id}-options`}
            value={options}
            onChange={(event) => {
              setOptions(event.target.value);
              onChange({ options: parseOptions(event.target.value) });
            }}
          />
        </label>
      ) : null}
      <label className="cxsToolsCheck">
        <input
          type="checkbox"
          checked={parameter.required}
          onChange={(event) => onChange({ required: event.target.checked })}
        />
        <span>{say("必填", "Required")}</span>
      </label>
      <div className="cxsToolsActions">
        <button type="button" className="siteButton quiet small" onClick={onRemove}>
          {say("删除参数", "Remove parameter")}
        </button>
      </div>
    </div>
  );
}

function ToolCard({
  tool,
  index,
  props,
  onChange,
  onRemove
}: {
  tool: StudioTool;
  index: number;
  props: StudioTabProps;
  onChange: (next: StudioTool) => void;
  onRemove: () => void;
}) {
  const say = useSay();
  const [confirm, setConfirm] = useState(false);
  const problem = tool.url.trim() ? toolUrlProblem(tool.url.trim()) : undefined;
  const saved = savedUnchanged(tool, props.project.studio.tools);
  const id = `cxsTool${index}`;
  const patchParameter = (at: number, patch: Partial<StudioParameter>) =>
    onChange({ ...tool, parameters: tool.parameters.map((item, i) => (i === at ? { ...item, ...patch } : item)) });
  return (
    <li className="cxsToolsCard">
      <NameInput
        label={say("工具名称", "Tool name")}
        hint={say("小写字母，例如 check_order", "Lowercase, like check_order")}
        value={tool.name}
        onCommit={(name) => onChange({ ...tool, name })}
      />
      <label className="cxField" htmlFor={`${id}-desc`}>
        <span>
          {say("智能体什么时候该用它？智能体会读这段话。", "When should the agent use it? The agent reads this.")}
        </span>
        <textarea
          id={`${id}-desc`}
          value={tool.description}
          maxLength={STUDIO_LIMITS.toolDescription}
          onChange={(event) => onChange({ ...tool, description: event.target.value })}
        />
      </label>
      <label className="cxField" htmlFor={`${id}-url`}>
        <span>{say("你的服务器地址（https）", "Your server's address (https)")}</span>
        <input
          id={`${id}-url`}
          type="url"
          inputMode="url"
          value={tool.url}
          placeholder="https://example.com/my-tool"
          maxLength={STUDIO_LIMITS.url}
          spellCheck={false}
          onChange={(event) => onChange({ ...tool, url: event.target.value })}
        />
        {problem ? (
          <small className="cxError" role="alert">
            {problem}
          </small>
        ) : null}
      </label>
      <div className="cxsToolsParams">
        <strong>{say("参数（智能体要传给你的信息）", "Parameters (what the agent sends you)")}</strong>
        {tool.parameters.map((parameter, at) => (
          <ParameterRow
            key={at}
            parameter={parameter}
            index={at}
            toolName={id}
            onChange={(patch) => patchParameter(at, patch)}
            onRemove={() => onChange({ ...tool, parameters: tool.parameters.filter((_, i) => i !== at) })}
          />
        ))}
        <div className="cxsToolsActions">
          <button
            type="button"
            className="siteButton secondary small"
            disabled={tool.parameters.length >= STUDIO_LIMITS.parameters}
            onClick={() => onChange({ ...tool, parameters: [...tool.parameters, blankParameter(tool.parameters)] })}
          >
            {say("添加参数", "Add a parameter")}
          </button>
        </div>
      </div>
      <ToolTest tool={tool} props={props} saved={saved} />
      <div className="cxsToolsActions">
        {confirm ? (
          <>
            <span>{say("删除这个工具？", "Remove this tool?")}</span>
            <button type="button" className="siteButton small cxDangerButton" onClick={onRemove}>
              {say("确认删除", "Yes, remove")}
            </button>
            <button type="button" className="siteButton quiet small" onClick={() => setConfirm(false)}>
              {say("取消", "Cancel")}
            </button>
          </>
        ) : (
          <button type="button" className="siteButton quiet small" onClick={() => setConfirm(true)}>
            {say("删除工具", "Remove tool")}
          </button>
        )}
      </div>
    </li>
  );
}

function SigningSecret({ props }: { props: StudioTabProps }) {
  const say = useSay();
  const { session, project } = props;
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");

  async function run(action: "show" | "rotate") {
    setBusy(true);
    setMessage("");
    try {
      const result =
        action === "show"
          ? await session.api.webhookSecret(session.token, project.id)
          : await session.api.rotateWebhookSecret(session.token, project.id);
      setSecret(result.secret);
      setConfirm(false);
      if (action === "rotate")
        setMessage(
          say(
            "已换新密钥。旧密钥已失效，请更新你的服务器。",
            "New secret ready. The old one no longer works. Update your server."
          )
        );
    } catch (error) {
      setMessage(session.fail(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cxsToolsSection cxCard" aria-labelledby="cxsToolsSecretTitle">
      <h3 id="cxsToolsSecretTitle">{say("签名密钥", "Signing secret")}</h3>
      <p className="cxMuted">
        {say(
          "用它确认请求真的来自 Max。请保密。",
          "Use it to check that a request really came from Max. Keep it private."
        )}
      </p>
      {!project.hasWebhookSecret ? (
        <p className="cxMuted">
          {say("保存第一个工具后，你会得到签名密钥。", "Save your first tool to get a signing secret.")}
        </p>
      ) : (
        <>
          {secret ? (
            <div className="cxsToolsSecret">
              <code className="cxCode">{secret}</code>
              <CopyButton text={secret} />
            </div>
          ) : null}
          <div className="cxsToolsActions">
            {!secret ? (
              <button
                type="button"
                className="siteButton secondary small"
                disabled={busy}
                onClick={() => void run("show")}
              >
                {say("显示密钥", "Show secret")}
              </button>
            ) : (
              <button type="button" className="siteButton quiet small" onClick={() => setSecret("")}>
                {say("隐藏", "Hide")}
              </button>
            )}
            {confirm ? (
              <>
                <span>
                  {say("换新后，旧密钥立刻失效。继续？", "The old secret stops working right away. Continue?")}
                </span>
                <button
                  type="button"
                  className="siteButton small cxDangerButton"
                  disabled={busy}
                  onClick={() => void run("rotate")}
                >
                  {say("确认更换", "Yes, rotate")}
                </button>
                <button type="button" className="siteButton quiet small" onClick={() => setConfirm(false)}>
                  {say("取消", "Cancel")}
                </button>
              </>
            ) : (
              <button type="button" className="siteButton quiet small" onClick={() => setConfirm(true)}>
                {say("更换密钥", "Rotate")}
              </button>
            )}
          </div>
        </>
      )}
      <p className="cxMuted" aria-live="polite">
        {message}
      </p>
    </section>
  );
}

export function ToolsTab(props: StudioTabProps) {
  const say = useSay();
  const { language } = useLanguage();
  const { draft, updateStudio } = props;
  const tools = draft.studio.tools;
  const atLimit = tools.length >= STUDIO_LIMITS.tools;
  const suggestions = (findTemplate(draft.studio.template)?.tools ?? []).filter(
    (suggestion) => !tools.some((tool) => tool.name === suggestion.name)
  );
  const setTools = (next: StudioTool[]) => updateStudio({ tools: next });

  return (
    <div className="cxsTools">
      <div className="cxsToolsHead">
        <h2>{say("工具", "Tools")}</h2>
        <p className="cxMuted">
          {say(
            "工具让智能体能做事，比如查订单、约时间。需要时，Max 会向你服务器的地址发送一个 POST 请求，带上用户的需求，并加上签名，让你知道它来自 Max。",
            "Tools let the agent do things, like look up an order or book a time. When it needs one, Max sends a POST to your server's address with what the user asked for. The request is signed, so you know it came from Max."
          )}
        </p>
      </div>

      {suggestions.length > 0 ? (
        <section className="cxsToolsSection" aria-labelledby="cxsToolsSuggestTitle">
          <h3 id="cxsToolsSuggestTitle">{say("适合你模板的工具", "Suggested for your template")}</h3>
          <ul className="cxsToolsSuggest">
            {suggestions.map((suggestion) => (
              <li key={suggestion.name}>
                <span>{suggestion.name}</span>
                <button
                  type="button"
                  className="siteButton secondary small"
                  disabled={atLimit}
                  aria-label={say(`添加 ${suggestion.name}`, `Add ${suggestion.name}`)}
                  onClick={() =>
                    setTools([...tools, toolFromSuggestion(suggestion, language === "en-US" ? "en" : "zh")])
                  }
                >
                  {say("添加", "Add")}
                </button>
              </li>
            ))}
          </ul>
          <p className="cxMuted">
            {say("添加后，你只需要填写 https 地址。", "After you add one, you only need to enter the https address.")}
          </p>
        </section>
      ) : null}

      {tools.length > 0 ? (
        <ul className="cxsToolsList">
          {tools.map((tool, index) => (
            <ToolCard
              key={index}
              tool={tool}
              index={index}
              props={props}
              onChange={(next) => setTools(tools.map((item, i) => (i === index ? next : item)))}
              onRemove={() => setTools(tools.filter((_, i) => i !== index))}
            />
          ))}
        </ul>
      ) : (
        <p className="cxMuted">{say("还没有工具。", "No tools yet.")}</p>
      )}

      <div className="cxsToolsActions">
        <button
          type="button"
          className="siteButton secondary"
          disabled={atLimit}
          onClick={() => setTools([...tools, blankTool(tools)])}
        >
          {say("添加工具", "Add a tool")}
        </button>
        <span className="cxMuted" aria-live="polite">
          {atLimit
            ? say(`最多 ${STUDIO_LIMITS.tools} 个工具。`, `At most ${STUDIO_LIMITS.tools} tools.`)
            : `${tools.length} / ${STUDIO_LIMITS.tools}`}
        </span>
      </div>
      {props.dirty ? (
        <p className="cxMuted">{say("改动要保存后才会生效。", "Changes take effect after you save.")}</p>
      ) : null}

      {tools.length > 0 ? <SigningSecret props={props} /> : null}

      <details className="cxsToolsDocs cxCard">
        <summary>{say("你的服务器会收到什么", "What your server receives")}</summary>
        <p>{say("Max 会发送这样的 POST 请求：", "Max sends a POST request like this:")}</p>
        <pre>{exampleRequest(tools[0])}</pre>
        <p>{say("请求头：", "Headers:")}</p>
        <pre>{`x-voice-agent-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">\nx-voice-agent-timestamp: <epoch ms>`}</pre>
        <p>
          {say(
            "Node.js（Express）示例，验证签名并返回 JSON：",
            "Node.js (Express) example that checks the signature and replies with JSON:"
          )}
        </p>
        <pre>{EXPRESS_EXAMPLE}</pre>
        <p>
          <strong>
            {say("请在 10 秒内返回智能体能读懂的 JSON。", "Reply with JSON the agent can read, within 10 seconds.")}
          </strong>
        </p>
      </details>

      <p className="cxMuted">
        {say(
          "想在网页里直接操作（打开页面、填表单）？请在 SDK 里使用客户端工具：",
          "To act inside the web page itself (open a page, fill a form), use client tools in the SDK: "
        )}
        <a href={DOCS_URL} target="_blank" rel="noreferrer">
          {say("查看说明", "read how")}
        </a>
      </p>
    </div>
  );
}
