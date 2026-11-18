import { useState, type FormEvent } from "react";
import type { Backend, Project } from "./api";
import { useSay, type Session } from "./hooks";

export const BACKENDS: { id: Backend; label: string }[] = [
  { id: "openai", label: "OpenAI Realtime" },
  { id: "gemini", label: "Gemini Live" },
  { id: "grok", label: "Grok Voice" }
];

type Confirm = "none" | "rotate" | "delete";

export function ProjectEditor({
  session,
  project,
  onChanged,
  onKeyRotated,
  onDeleted
}: {
  session: Session;
  project: Project;
  onChanged: (project: Project) => void;
  onKeyRotated: (project: Project, apiKey: string) => void;
  onDeleted: (project: Project) => void;
}) {
  const say = useSay();
  const { api, token, fail } = session;
  const [name, setName] = useState(project.name);
  const [backend, setBackend] = useState<Backend>(project.backend);
  const [modelKey, setModelKey] = useState("");
  const [assistantName, setAssistantName] = useState(project.assistantName);
  const [instructions, setInstructions] = useState(project.instructions);
  const [greeting, setGreeting] = useState(project.greeting);
  const [confirm, setConfirm] = useState<Confirm>("none");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const field = (suffix: string) => `cx-${project.id}-${suffix}`;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await work();
    } catch (caught) {
      setError(fail(caught));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const patch = { name, backend, assistantName, instructions, greeting, ...(modelKey ? { modelKey } : {}) };
      const result = await api.updateProject(token, project.id, patch);
      setModelKey("");
      onChanged(result.project);
      setStatus(say("已保存。", "Saved."));
    });
  };

  const removeKey = () =>
    void run(async () => {
      const result = await api.updateProject(token, project.id, { modelKey: "" });
      setModelKey("");
      onChanged(result.project);
      setStatus(say("模型密钥已移除。", "Model key removed."));
    });

  const rotate = () =>
    void run(async () => {
      const result = await api.rotateKey(token, project.id);
      setConfirm("none");
      onKeyRotated(result.project, result.apiKey);
    });

  const remove = () =>
    void run(async () => {
      await api.deleteProject(token, project.id);
      onDeleted(project);
    });

  return (
    <div className="cxEditor">
      <form onSubmit={save}>
        <label className="cxField" htmlFor={field("name")}>
          <span>{say("项目名称", "Project name")}</span>
          <input id={field("name")} maxLength={60} required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="cxField" htmlFor={field("backend")}>
          <span>{say("语音后端", "Voice backend")}</span>
          <select id={field("backend")} value={backend} onChange={(e) => setBackend(e.target.value as Backend)}>
            {BACKENDS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="cxField">
          <label htmlFor={field("key")}>
            <span>{say("模型密钥", "Model key")}</span>
          </label>
          <div className="cxRow">
            <input
              id={field("key")}
              type="password"
              autoComplete="off"
              maxLength={400}
              placeholder={project.hasModelKey ? "•••• saved" : ""}
              aria-describedby={field("key-hint")}
              value={modelKey}
              onChange={(e) => setModelKey(e.target.value)}
            />
            {project.hasModelKey ? (
              <button type="button" className="siteButton secondary small" disabled={busy} onClick={removeKey}>
                {say("移除密钥", "Remove key")}
              </button>
            ) : null}
          </div>
          <small id={field("key-hint")}>
            {project.hasModelKey
              ? say("留空表示不改。保存后不会再显示。", "Leave empty to keep it. It is never shown again.")
              : say("粘贴你的 OpenAI、Gemini 或 xAI 密钥。", "Paste your OpenAI, Gemini or xAI key.")}
          </small>
        </div>
        <label className="cxField" htmlFor={field("assistant")}>
          <span>{say("助手名称", "Assistant name")}</span>
          <input
            id={field("assistant")}
            maxLength={24}
            value={assistantName}
            onChange={(e) => setAssistantName(e.target.value)}
          />
        </label>
        <label className="cxField" htmlFor={field("instructions")}>
          <span>{say("指令", "Instructions")}</span>
          <textarea
            id={field("instructions")}
            rows={5}
            maxLength={8000}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>
        <label className="cxField" htmlFor={field("greeting")}>
          <span>{say("开场白", "Greeting")}</span>
          <input
            id={field("greeting")}
            maxLength={300}
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
          />
        </label>
        <div className="cxRow">
          <button className="siteButton" type="submit" disabled={busy}>
            {say("保存", "Save")}
          </button>
          <span className="cxStatus" aria-live="polite">
            {status}
          </span>
        </div>
        <p className="cxError" aria-live="polite">
          {error}
        </p>
      </form>

      <div className="cxDanger">
        {confirm === "none" ? (
          <div className="cxRow">
            <button type="button" className="siteButton secondary small" onClick={() => setConfirm("rotate")}>
              {say("更换项目密钥", "Rotate key")}
            </button>
            <button type="button" className="siteButton secondary small" onClick={() => setConfirm("delete")}>
              {say("删除项目", "Delete project")}
            </button>
          </div>
        ) : (
          <div role="group" aria-label={say("确认", "Confirm")}>
            <p>
              {confirm === "rotate"
                ? say("旧密钥会立刻失效。确定要更换吗？", "The old key stops working immediately. Rotate it?")
                : say(
                    "项目会被删除，它的密钥也会失效。确定吗？",
                    "This deletes the project and its key stops working. Delete it?"
                  )}
            </p>
            <div className="cxRow">
              <button
                type="button"
                className="siteButton small cxDangerButton"
                disabled={busy}
                onClick={confirm === "rotate" ? rotate : remove}
              >
                {confirm === "rotate" ? say("是，更换", "Yes, rotate") : say("是，删除", "Yes, delete")}
              </button>
              <button type="button" className="siteButton quiet small" onClick={() => setConfirm("none")}>
                {say("取消", "Cancel")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
