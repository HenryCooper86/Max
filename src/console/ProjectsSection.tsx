import { useState, type FormEvent } from "react";
import { useLanguage } from "../components/LanguageToggle";
import { AGENT_TEMPLATES, findTemplate, type AgentTemplate } from "../lib/agent-templates";
import type { Language } from "../lib/i18n";
import type { Project, ProjectStart } from "./api";
import { useSay, type Session } from "./hooks";
import { KeyReveal } from "./KeyReveal";
import { BACKENDS } from "./studio/AgentTab";
import { Studio } from "./studio/Studio";
import type { StudioTab } from "./studio/types";

const backendLabel = (id: string) => BACKENDS.find((option) => option.id === id)?.label ?? id;

/** What a new project starts with when made from `template`, in the visitor's language. */
export function startFromTemplate(template: AgentTemplate, name: string, language: Language): ProjectStart {
  const pick = (text: { zh: string; en: string }) => (language === "en-US" ? text.en : text.zh);
  return {
    name,
    assistantName: pick(template.assistantName),
    instructions: pick(template.instructions),
    greeting: pick(template.greeting),
    studio: { template: template.id, knowledge: pick(template.knowledge) }
  };
}

function NewProject({
  session,
  onCreated
}: {
  session: Session;
  onCreated: (project: Project, apiKey: string) => void;
}) {
  const say = useSay();
  const { language } = useLanguage();
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState<AgentTemplate | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setTemplate(null);
    setName("");
    setError("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!template) return;
    setBusy(true);
    setError("");
    try {
      const result = await session.api.createProject(session.token, startFromTemplate(template, name.trim(), language));
      close();
      onCreated(result.project, result.apiKey);
    } catch (caught) {
      setError(session.fail(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="siteButton" onClick={() => setOpen(true)}>
        {say("新建助手", "New agent")}
      </button>
    );
  }
  return (
    <form className="cxCard cxInline" onSubmit={(event) => void submit(event)} aria-labelledby="cx-new-title">
      <h3 id="cx-new-title">{say("你想做什么样的助手？", "What kind of agent do you want?")}</h3>
      <p className="cxMuted">
        {say("选一个起点。之后都能改。", "Pick a starting point. You can change everything later.")}
      </p>
      <ul className="cxsTemplates">
        {AGENT_TEMPLATES.map((option) => (
          <li key={option.id}>
            <button
              type="button"
              aria-pressed={template?.id === option.id}
              onClick={() => {
                setTemplate(option);
                if (!name.trim() || AGENT_TEMPLATES.some((other) => say(other.title.zh, other.title.en) === name)) {
                  setName(say(option.title.zh, option.title.en));
                }
              }}
            >
              <span className="cxsTemplateIcon" aria-hidden="true">
                {option.icon}
              </span>
              <strong>{say(option.title.zh, option.title.en)}</strong>
              <span>{say(option.blurb.zh, option.blurb.en)}</span>
            </button>
          </li>
        ))}
      </ul>
      {template ? (
        <label className="cxField">
          <span>{say("项目名称", "Project name")}</span>
          <input autoFocus required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      ) : null}
      <div className="cxRow">
        <button className="siteButton" type="submit" disabled={busy || !template || !name.trim()}>
          {busy ? say("正在创建…", "Creating…") : say("创建", "Create")}
        </button>
        <button type="button" className="siteButton quiet" onClick={close}>
          {say("取消", "Cancel")}
        </button>
      </div>
      <p className="cxError" aria-live="polite">
        {error}
      </p>
    </form>
  );
}

function StatusChips({ project }: { project: Project }) {
  const say = useSay();
  const template = findTemplate(project.studio.template);
  return (
    <div className="cxsChips">
      {template ? (
        <span className="cxsChip">
          {template.icon} {say(template.title.zh, template.title.en)}
        </span>
      ) : null}
      <span className="cxsChip">{backendLabel(project.backend)}</span>
      {project.hasModelKey ? null : <span className="cxsChip">{say("需要模型密钥", "Needs a model key")}</span>}
      {project.studio.tools.length ? (
        <span className="cxsChip">
          {say(
            `${project.studio.tools.length} 个工具`,
            project.studio.tools.length === 1 ? "1 tool" : `${project.studio.tools.length} tools`
          )}
        </span>
      ) : null}
      {project.studio.publicEmbed.enabled ? (
        <span className="cxsChip ok">{say("已上线网站", "Live on your site")}</span>
      ) : null}
    </div>
  );
}

export function ProjectsSection({
  session,
  projects,
  setProjects,
  origin,
  onMoney
}: {
  session: Session;
  projects: Project[] | null;
  setProjects: (projects: Project[]) => void;
  origin: string;
  onMoney: () => void;
}) {
  const say = useSay();
  const [open, setOpen] = useState<{ id: string; tab: StudioTab } | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; apiKey: string } | null>(null);

  const replace = (project: Project) => setProjects((projects ?? []).map((p) => (p.id === project.id ? project : p)));

  return (
    <section className="cxSection" id="projects" aria-labelledby="cx-projects">
      <div className="cxRow spread">
        <h2 id="cx-projects">{say("你的助手", "Your agents")}</h2>
        <NewProject
          session={session}
          onCreated={(project, apiKey) => {
            setProjects([project, ...(projects ?? [])]);
            setRevealed({ name: project.name, apiKey });
            setOpen({ id: project.id, tab: "agent" });
          }}
        />
      </div>
      {revealed ? (
        <KeyReveal projectName={revealed.name} apiKey={revealed.apiKey} onDismiss={() => setRevealed(null)} />
      ) : null}
      {!projects ? (
        <p className="cxMuted">…</p>
      ) : projects.length === 0 ? (
        <p className="cxMuted">
          {say(
            "还没有助手。点“新建助手”，选一个模板，几分钟就能和它说上话。",
            "No agents yet. Click New agent, pick a template, and you'll be talking to it in a few minutes."
          )}
        </p>
      ) : (
        <ul className="cxProjects">
          {projects.map((project) => {
            const isOpen = open?.id === project.id;
            return (
              <li key={project.id} className="cxCard">
                <div className="cxProjectHead">
                  <div>
                    <h3>{project.name}</h3>
                    <StatusChips project={project} />
                  </div>
                  <button
                    type="button"
                    className={`siteButton small${isOpen ? " secondary" : ""}`}
                    aria-expanded={isOpen}
                    aria-controls={`cx-panel-${project.id}`}
                    onClick={() => setOpen(isOpen ? null : { id: project.id, tab: "agent" })}
                  >
                    {isOpen ? say("收起", "Close") : say("打开工作室", "Open studio")}
                  </button>
                </div>
                {isOpen ? (
                  <div id={`cx-panel-${project.id}`}>
                    <Studio
                      session={session}
                      project={project}
                      origin={origin}
                      initialTab={open.tab}
                      onChanged={replace}
                      onKeyRotated={(next, apiKey) => {
                        replace(next);
                        setRevealed({ name: next.name, apiKey });
                      }}
                      onDeleted={(gone) => {
                        setProjects((projects ?? []).filter((p) => p.id !== gone.id));
                        setOpen(null);
                        onMoney();
                      }}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
