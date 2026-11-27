import { MAX_MONTHLY_MINUTES_CAP } from "../../../shared/cloud-studio";
import type { Backend, Project, ProjectStudio, StudioRelease } from "../api";
import type { Session } from "../hooks";

export type StudioTab =
  "agent" | "knowledge" | "tools" | "flow" | "test" | "install" | "history" | "usage" | "settings";

/** Everything the Studio edits before it is saved. `modelKey` is "" unless the person typed a new one. */
export type StudioDraft = {
  name: string;
  backend: Backend;
  modelKey: string;
  /** The trace collector's headers: "" unless the person typed new ones (the saved ones are never shown). */
  tracesHeaders: string;
  removeTracesHeaders?: boolean;
  assistantName: string;
  instructions: string;
  greeting: string;
  studio: ProjectStudio;
};

/** What every Studio tab receives. */
export type StudioTabProps = {
  session: Session;
  /** The live project, used for operational controls. */
  project: Project;
  /** The saved draft configuration, or the live configuration when no draft exists. */
  savedProject: Project;
  release: StudioRelease | null;
  releaseBusy: boolean;
  draft: StudioDraft;
  update: (patch: Partial<StudioDraft>) => void;
  updateStudio: (patch: Partial<ProjectStudio>) => void;
  /** True when the draft differs from the saved project. */
  dirty: boolean;
  /** Saves the draft; resolves true when it was saved. */
  save: () => Promise<boolean>;
  prepareTest: () => Promise<{ draftRevision?: string; expectedLiveRevision?: string; language: string } | null>;
  refreshRelease: () => Promise<void>;
  /** The relay's address for snippets, like https://max.bionicloud.net. */
  origin: string;
  goTo: (tab: StudioTab) => void;
  /** Replaces the project after a server change made outside save (secret rotation, …). */
  onProjectChanged: (project: Project) => void;
};

export function draftFromProject(project: Project): StudioDraft {
  return {
    name: project.name,
    backend: project.backend,
    modelKey: "",
    tracesHeaders: "",
    assistantName: project.assistantName,
    instructions: project.instructions,
    greeting: project.greeting,
    studio: structuredClone(project.studio)
  };
}

/** The typed limit as saved: whole minutes, null for none, undefined when it is not a whole number. */
export function minutesCapFromDraft(typed: string): number | null | undefined {
  const text = typed.trim();
  if (!text) return null;
  const minutes = Number(text);
  return /^\d+$/.test(text) && minutes >= 1 && minutes <= MAX_MONTHLY_MINUTES_CAP ? minutes : undefined;
}

/** True when the draft has changes worth saving. */
export function draftChanged(draft: StudioDraft, project: Project): boolean {
  const saved = draftFromProject(project);
  return (
    Boolean(draft.modelKey) ||
    Boolean(draft.tracesHeaders) ||
    Boolean(draft.removeTracesHeaders) ||
    JSON.stringify({
      ...draft,
      modelKey: "",

      tracesHeaders: "",
      removeTracesHeaders: undefined
    }) !== JSON.stringify(saved)
  );
}

/** Per-browser memory of onboarding steps the server cannot know about. */
export function rememberStudioTest(projectId: string): void {
  try {
    window.localStorage.setItem(`max-cloud:tested:${projectId}`, "1");
  } catch {
    /* private mode: the checklist just forgets */
  }
}

export function studioTestDone(projectId: string): boolean {
  try {
    return window.localStorage.getItem(`max-cloud:tested:${projectId}`) === "1";
  } catch {
    return false;
  }
}
