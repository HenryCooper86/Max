import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, type Project, type ProjectPatch, type ProjectStudio, type StudioRelease } from "../api";
import { useSay, type Session } from "../hooks";
import { AgentTab } from "./AgentTab";
import { mayLeaveSection, SECTION_LEAVE_EVENT } from "../../lib/section-leave";
import { FlowTab } from "./FlowTab";
import { HistoryTab } from "./HistoryTab";
import { InstallTab } from "./InstallTab";
import { KnowledgeTab } from "./KnowledgeTab";
import { ReleasePanel } from "./ReleasePanel";
import { SettingsTab } from "./SettingsTab";
import { TestTab } from "./TestTab";
import { ToolsTab } from "./ToolsTab";
import {
  draftChanged,
  draftFromProject,
  studioTestDone,
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

/** Save the edited configuration and any explicitly changed credentials. */
export function patchFromDraft(draft: StudioDraft): ProjectPatch {
  return {
    name: draft.name,
    backend: draft.backend,
    assistantName: draft.assistantName,
    instructions: draft.instructions,
    greeting: draft.greeting,
    studio: draft.studio,
    ...(draft.modelKey.trim() ? { modelKey: draft.modelKey.trim() } : {}),
    ...(draft.removeTracesHeaders
      ? { tracesHeaders: "" }
      : draft.tracesHeaders.trim()
        ? { tracesHeaders: draft.tracesHeaders.trim() }
        : {})
  };
}

/** The three steps from an empty project to an agent on a website. */
function Checklist({ project, goTo }: { project: Project; goTo: (tab: StudioTab) => void }) {
  const say = useSay();
  const steps: { done: boolean; tab: StudioTab; title: ReactNode }[] = [
    { done: project.hasModelKey, tab: "agent", title: say("填写模型密钥", "Add your model key") },
    { done: studioTestDone(project.id), tab: "test", title: say("和它说说话", "Talk to it") },
    {
      done: project.firstWebsiteConversationAt != null,
      tab: "install",
      title: say("在网站上完成一次对话", "Have a conversation on your site")
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
      if (next === tab) return true;
      if (!mayLeaveSection()) return false;
      showTab(next);
      return true;
    },
    [tab]
  );
  const [draft, setDraft] = useState<StudioDraft>(() => draftFromProject(project));
  const [release, setRelease] = useState<StudioRelease | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);
  const refreshQueued = useRef(false);
  const readRelease = useRef<() => Promise<void>>(async () => {});
  const liveProject = release?.project ?? project;
  const savedProject = release?.draft?.project ?? liveProject;
  const dirty = useMemo(() => draftChanged(draft, savedProject), [draft, savedProject]);
  const latest = useRef({ savedProject, onChanged, fail: session.fail });
  latest.current = { savedProject, onChanged, fail: session.fail };
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

  const { api, token } = session;

  const acceptRelease = useCallback((next: StudioRelease, preserveEdits: boolean) => {
    const previous = latest.current.savedProject;
    const saved = next.draft?.project ?? next.project;
    setDraft((current) => {
      const updated = draftFromProject(saved);
      if (!preserveEdits) return updated;
      const baseline = draftFromProject(previous);
      for (const key of ["name", "backend", "assistantName", "instructions", "greeting"] as const) {
        if (current[key] !== baseline[key]) Object.assign(updated, { [key]: current[key] });
      }
      for (const key of Object.keys(baseline.studio) as (keyof ProjectStudio)[]) {
        if (JSON.stringify(current.studio[key]) !== JSON.stringify(baseline.studio[key])) {
          Object.assign(updated.studio, { [key]: current.studio[key] });
        }
      }
      updated.modelKey = current.modelKey;
      updated.tracesHeaders = current.tracesHeaders;
      updated.removeTracesHeaders = current.removeTracesHeaders;
      return updated;
    });
    setRelease(next);
    latest.current.onChanged(next.project);
  }, []);

  const reportReleaseError = useCallback(
    (error: unknown) => {
      const stale = error instanceof ApiError && error.status === 409;
      if (stale) setConflict(true);
      setSaveError(
        stale
          ? say(
              "版本已更改。刷新版本状态以保留并检查你的编辑。",
              "The revision changed. Refresh versions to keep and review your edits."
            )
          : latest.current.fail(error)
      );
    },
    [say]
  );

  const finishOperation = useCallback(() => {
    inFlight.current = false;
    if (refreshQueued.current) {
      refreshQueued.current = false;
      void readRelease.current();
    } else {
      setSaving(false);
    }
  }, []);

  const refreshRelease = useCallback(async () => {
    if (inFlight.current) {
      refreshQueued.current = true;
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      const next = await api.studioRelease(token, project.id);
      acceptRelease(next, true);
      setConflict(false);
      setSaveError("");
    } catch (error) {
      reportReleaseError(error);
    } finally {
      finishOperation();
    }
  }, [acceptRelease, api, finishOperation, project.id, reportReleaseError, token]);

  readRelease.current = refreshRelease;
  useEffect(() => {
    void readRelease.current();
    return () => {
      refreshQueued.current = false;
    };
  }, [api, project.id, token]);

  const saveDraft = async (): Promise<StudioRelease | null> => {
    if (!release || conflict || inFlight.current) return null;
    if (!dirty) return release;
    if (tab === "flow" && !mayLeaveSection()) return null;
    inFlight.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const next = await api.saveStudioDraft(token, project.id, {
        baseRevision: release.liveRevision,
        draftRevision: release.draft?.id ?? null,
        patch: patchFromDraft(draft)
      });
      acceptRelease(next, false);
      setSavedNote(say("草稿已保存。", "Draft saved."));
      return next;
    } catch (error) {
      reportReleaseError(error);
      return null;
    } finally {
      finishOperation();
    }
  };

  const prepareTest: StudioTabProps["prepareTest"] = async () => {
    const next = await saveDraft();
    if (!next) return null;
    return {
      ...(next.draft ? { draftRevision: next.draft.id } : { expectedLiveRevision: next.liveRevision }),
      language: (next.draft?.project ?? next.project).studio.language
    };
  };

  const changeLive = async (action: "publish" | "restore") => {
    if (!release || inFlight.current || conflict || (action === "publish" && dirty)) return;
    const revision = action === "publish" ? release.draft?.id : release.previousRevision;
    if (!revision || (action === "publish" && !release.draft?.tested)) return;
    if (tab === "flow" && !mayLeaveSection()) return;
    if (action === "restore") {
      const message =
        release.draft || dirty
          ? say(
              "恢复上一发布版本？这会丢弃当前草稿及未保存的编辑，并影响新开启的线上对话。",
              "Restore the previous release? This discards the current draft and unsaved edits and affects new live conversations."
            )
          : say(
              "将上一发布版本恢复为线上版本？这会影响新开启的线上对话。",
              "Restore the previous release? This will affect new live conversations."
            );
      if (!window.confirm(message)) return;
    }
    inFlight.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const request = { baseRevision: release.liveRevision, revision };
      const next =
        action === "publish"
          ? await api.publishStudioRevision(token, project.id, request)
          : await api.restoreStudioRevision(token, project.id, {
              ...request,
              draftRevision: release.draft?.id ?? null
            });
      acceptRelease(next, false);
      setSavedNote(action === "publish" ? say("已发布。", "Published.") : say("已恢复。", "Restored."));
    } catch (error) {
      reportReleaseError(error);
    } finally {
      finishOperation();
    }
  };

  const tabProps: StudioTabProps = {
    session,
    project,
    savedProject,
    release,
    releaseBusy: saving || conflict || !release,
    draft,
    update,
    updateStudio,
    dirty,
    save: async () => Boolean(await saveDraft()),
    prepareTest,
    refreshRelease,
    origin,
    goTo: setTab,
    onProjectChanged: onChanged
  };
  const tabId = (id: StudioTab) => `cxs-${project.id}-tab-${id}`;

  const onTabKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: StudioTab;
    switch (event.key) {
      case "ArrowRight":
        next = TABS[(index + 1) % TABS.length]!.id;
        break;
      case "ArrowLeft":
        next = TABS[(index + TABS.length - 1) % TABS.length]!.id;
        break;
      case "Home":
        next = TABS[0]!.id;
        break;
      case "End":
        next = TABS[TABS.length - 1]!.id;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (setTab(next)) document.getElementById(tabId(next))?.focus();
  };

  return (
    <div className="cxsStudio">
      <Checklist
        project={{
          ...savedProject,
          firstWebsiteConversationAt: project.firstWebsiteConversationAt ?? liveProject.firstWebsiteConversationAt
        }}
        goTo={setTab}
      />
      <ReleasePanel
        release={release}
        dirty={dirty}
        busy={saving}
        conflict={conflict}
        refresh={refreshRelease}
        publish={() => void changeLive("publish")}
        restore={() => void changeLive("restore")}
        goToTest={() => setTab("test")}
      />
      <div className="cxsTabs" role="tablist" aria-label={say("工作室", "Studio")}>
        {TABS.map((item, index) => (
          <button
            key={item.id}
            id={tabId(item.id)}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onKeyDown={(event) => onTabKey(event, index)}
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
                  setDraft(draftFromProject(savedProject));
                  setSaveError("");
                }}
              >
                {say("放弃", "Discard")}
              </button>
              <button
                type="button"
                className="siteButton small"
                disabled={saving || !dirty || !release || conflict}
                onClick={() => void saveDraft()}
              >
                {saving ? say("正在保存…", "Saving…") : say("保存草稿", "Save draft")}
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
