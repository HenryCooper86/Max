import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Project, ProjectPatch, ProjectStudio } from "../api";
import { useSay, type Session } from "../hooks";
import { AgentTab } from "./AgentTab";
import { mayLeaveSection, SECTION_LEAVE_EVENT } from "../../lib/section-leave";
import { FlowTab } from "./FlowTab";
import { HistoryTab } from "./HistoryTab";
import { InstallTab } from "./InstallTab";
import { KnowledgeTab } from "./KnowledgeTab";
import { SettingsTab } from "./SettingsTab";
import { TestTab } from "./TestTab";
import { ToolsTab } from "./ToolsTab";
import {
  draftChanged,
  draftFromProject,
  minutesCapFromDraft,
  stepDone,
  type StudioDraft,
  type StudioTab,
  type StudioTabProps
} from "./types";
import "./studio.css";

const TABS: { id: StudioTab; zh: string; en: string }[] = [
  { id: "agent", zh: "助手", en: "Agent" },
  { id: "knowledge", zh: "知识", en: "Knowledge" },
  { id: "tools", zh: "工具", en: "Tools" },
  { id: "flow", zh: "流程", en: "Flow" },
  { id: "test", zh: "测试", en: "Test" },
  { id: "install", zh: "安装", en: "Install" },
  { id: "history", zh: "对话", en: "Conversations" },
  { id: "settings", zh: "设置", en: "Settings" }
];

/** What a save sends: everything the Studio edits, the model key only when typed, and the minutes
 *  limit only when it is a whole number or empty (Settings says when it is not). */
export function patchFromDraft(draft: StudioDraft): ProjectPatch {
  const cap = minutesCapFromDraft(draft.monthlyMinutesCap);
  // The flow has a save of its own (the Flow tab): this one says nothing of it, and the relay leaves it as it is.
  const studio: ProjectPatch["studio"] = { ...draft.studio, flow: undefined };
  return {
    name: draft.name,
    backend: draft.backend,
    assistantName: draft.assistantName,
    instructions: draft.instructions,
    greeting: draft.greeting,
    studio,
    ...(cap !== undefined ? { monthlyMinutesCap: cap } : {}),
    ...(draft.modelKey.trim() ? { modelKey: draft.modelKey.trim() } : {}),
    ...(draft.tracesHeaders.trim() ? { tracesHeaders: draft.tracesHeaders.trim() } : {})
  };
}

/** The three steps from an empty project to an agent on a website. */
function Checklist({ project, goTo }: { project: Project; goTo: (tab: StudioTab) => void }) {
  const say = useSay();
  const steps: { done: boolean; tab: StudioTab; title: ReactNode }[] = [
    { done: project.hasModelKey, tab: "agent", title: say("填写模型密钥", "Add your model key") },
    { done: stepDone(project.id, "tested"), tab: "test", title: say("和它说说话", "Talk to it") },
    {
      done: stepDone(project.id, "installed") || project.studio.publicEmbed.enabled,
      tab: "install",
      title: say("放到你的网站上", "Put it on your site")
    }
  ];
  if (steps.every((step) => step.done)) return null;
  return (
    <ol className="cxsChecklist" aria-label={say("开始使用", "Getting started")}>
      {steps.map((step, index) => (
        <li key={step.tab} className={step.done ? "done" : undefined}>
          <button type="button" onClick={() => goTo(step.tab)}>
            <span className="cxsStepMark" aria-hidden="true">
              {step.done ? "✓" : index + 1}
            </span>
            <span>
              {step.title}
              <span className="cxsSrOnly">{step.done ? say("（已完成）", " (done)") : ""}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

export function Studio({
  session,
  project,
  origin,
  initialTab = "agent",
  onChanged,
  onKeyRotated,
  onDeleted
}: {
  session: Session;
  project: Project;
  origin: string;
  initialTab?: StudioTab;
  onChanged: (project: Project) => void;
  onKeyRotated: (project: Project, apiKey: string) => void;
  onDeleted: (project: Project) => void;
}) {
  const say = useSay();
  const [tab, showTab] = useState<StudioTab>(initialTab);
  // The flow has unsaved changes of its own, apart from the draft: it is asked before its tab gives way.
  const setTab = useCallback(
    (next: StudioTab) => {
      if (next !== tab && mayLeaveSection()) showTab(next);
    },
    [tab]
  );
  const [draft, setDraft] = useState<StudioDraft>(() => draftFromProject(project));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const dirty = useMemo(() => draftChanged(draft, project), [draft, project]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    const onLeave = (event: Event) => {
      if ((event as CustomEvent).detail !== "project" || event.defaultPrevented) return;
      if (!window.confirm(say("放弃这个项目未保存的更改？", "Discard the unsaved changes to this project?"))) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener(SECTION_LEAVE_EVENT, onLeave);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener(SECTION_LEAVE_EVENT, onLeave);
    };
  }, [dirty, say]);

  useEffect(() => {
    if (!savedNote) return;
    const timer = window.setTimeout(() => setSavedNote(""), 2500);
    return () => window.clearTimeout(timer);
  }, [savedNote]);

  const update = useCallback((patch: Partial<StudioDraft>) => setDraft((current) => ({ ...current, ...patch })), []);
  const updateStudio = useCallback(
    (patch: Partial<ProjectStudio>) => setDraft((current) => ({ ...current, studio: { ...current.studio, ...patch } })),
    []
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (saving) return false;
    if (minutesCapFromDraft(draft.monthlyMinutesCap) === undefined) {
      setSaveError(say("请检查设置中的每月分钟上限。", "Check the monthly minutes limit in Settings."));
      return false;
    }
    setSaving(true);
    setSaveError("");
    try {
      const result = await session.api.updateProject(session.token, project.id, patchFromDraft(draft));
      onChanged(result.project);
      setDraft(draftFromProject(result.project));
      setSavedNote(say("已保存。", "Saved."));
      return true;
    } catch (error) {
      setSaveError(session.fail(error));
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, onChanged, project.id, saving, say, session]);

  const tabProps: StudioTabProps = {
    session,
    project,
    draft,
    update,
    updateStudio,
    dirty,
    save,
    origin,
    goTo: setTab,
    onProjectChanged: onChanged
  };
  const tabId = (id: StudioTab) => `cxs-${project.id}-tab-${id}`;

  return (
    <div className="cxsStudio">
      <Checklist project={project} goTo={setTab} />
      <div className="cxsTabs" role="tablist" aria-label={say("工作室", "Studio")}>
        {TABS.map((item) => (
          <button
            key={item.id}
            id={tabId(item.id)}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`${tabId(item.id)}-panel`}
            className={tab === item.id ? "active" : undefined}
            onClick={() => setTab(item.id)}
          >
            {say(item.zh, item.en)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${tabId(tab)}-panel`}
        aria-labelledby={tabId(tab)}
        inert={saving && tab !== "test"}
        aria-busy={saving}
      >
        {tab === "agent" ? <AgentTab {...tabProps} /> : null}
        {tab === "knowledge" ? <KnowledgeTab {...tabProps} /> : null}
        {tab === "tools" ? <ToolsTab {...tabProps} /> : null}
        {tab === "flow" ? <FlowTab {...tabProps} /> : null}
        {tab === "test" ? <TestTab {...tabProps} /> : null}
        {tab === "install" ? <InstallTab {...tabProps} /> : null}
        {tab === "history" ? <HistoryTab {...tabProps} /> : null}
        {tab === "settings" ? <SettingsTab {...tabProps} onKeyRotated={onKeyRotated} onDeleted={onDeleted} /> : null}
      </div>
      <div className={`cxsSaveBar${dirty || saveError ? " visible" : ""}`} aria-live="polite">
        {dirty || saveError ? (
          <>
            <span className={saveError ? "cxsSaveError" : undefined}>
              {saveError || say("有未保存的更改", "You have unsaved changes")}
            </span>
            <div className="cxRow">
              <button
                type="button"
                className="siteButton quiet small"
                disabled={saving}
                onClick={() => {
                  setDraft(draftFromProject(project));
                  setSaveError("");
                }}
              >
                {say("放弃", "Discard")}
              </button>
              <button
                type="button"
                className="siteButton small"
                disabled={saving || !dirty}
                onClick={() => void save()}
              >
                {saving ? say("正在保存…", "Saving…") : say("保存", "Save")}
              </button>
            </div>
          </>
        ) : (
          <span className="cxStatus">{savedNote}</span>
        )}
      </div>
    </div>
  );
}
