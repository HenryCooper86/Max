import { useState, type FormEvent } from "react";
import type { Project } from "./api";
import { useSay, type Session } from "./hooks";
import { KeyReveal } from "./KeyReveal";
import { BACKENDS, ProjectEditor } from "./ProjectEditor";
import { Snippets } from "./Snippets";

const backendLabel = (id: string) => BACKENDS.find((option) => option.id === id)?.label ?? id;

function NewProject({
  session,
  onCreated
}: {
  session: Session;
  onCreated: (project: Project, apiKey: string) => void;
}) {
  const say = useSay();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await session.api.createProject(session.token, name.trim());
      setName("");
      setOpen(false);
      onCreated(result.project, result.apiKey);
    } catch (caught) {
      setError(session.fail(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="siteButton secondary" onClick={() => setOpen(true)}>
        {say("新建项目", "New project")}
      </button>
    );
  }
  return (
    <form className="cxInline" onSubmit={(event) => void submit(event)}>
      <label className="cxField">
        <span>{say("项目名称", "Project name")}</span>
        <input autoFocus required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="cxRow">
        <button className="siteButton" type="submit" disabled={busy || !name.trim()}>
          {say("创建", "Create")}
        </button>
        <button type="button" className="siteButton quiet" onClick={() => setOpen(false)}>
          {say("取消", "Cancel")}
        </button>
      </div>
      <p className="cxError" aria-live="polite">
        {error}
      </p>
    </form>
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
  const [openId, setOpenId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; apiKey: string } | null>(null);

  const replace = (project: Project) => setProjects((projects ?? []).map((p) => (p.id === project.id ? project : p)));

  return (
    <section className="cxSection" id="projects" aria-labelledby="cx-projects">
      <div className="cxRow spread">
        <h2 id="cx-projects">{say("项目", "Projects")}</h2>
        <NewProject
          session={session}
          onCreated={(project, apiKey) => {
            setProjects([project, ...(projects ?? [])]);
            setRevealed({ name: project.name, apiKey });
            setOpenId(project.id);
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
            "还没有项目。新建一个，贴上模型密钥，就能开始。",
            "No projects yet. Create one, paste your model key, and you're set."
          )}
        </p>
      ) : (
        <ul className="cxProjects">
          {projects.map((project) => {
            const open = openId === project.id;
            return (
              <li key={project.id} className="cxCard">
                <div className="cxProjectHead">
                  <div>
                    <h3>{project.name}</h3>
                    <p className="cxMuted">
                      {backendLabel(project.backend)} · <code>{project.keyPrefix}…</code>
                    </p>
                    {!project.hasModelKey ? (
                      <p className="cxWarn">{say("需要填写模型密钥", "Needs a model key")}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="siteButton secondary small"
                    aria-expanded={open}
                    aria-controls={`cx-panel-${project.id}`}
                    onClick={() => setOpenId(open ? null : project.id)}
                  >
                    {open ? say("收起", "Close") : say("设置", "Settings")}
                  </button>
                </div>
                {open ? (
                  <div id={`cx-panel-${project.id}`}>
                    <ProjectEditor
                      session={session}
                      project={project}
                      onChanged={replace}
                      onKeyRotated={(next, apiKey) => {
                        replace(next);
                        setRevealed({ name: next.name, apiKey });
                      }}
                      onDeleted={(gone) => {
                        setProjects((projects ?? []).filter((p) => p.id !== gone.id));
                        setOpenId(null);
                        onMoney();
                      }}
                    />
                    <Snippets origin={origin} />
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
