import type { Backend, Project, ProjectStudio } from "../api";
import type { Session } from "../hooks";

export type StudioTab = "agent" | "knowledge" | "tools" | "flow" | "test" | "install" | "history" | "settings";

/** Everything the Studio edits before it is saved. `modelKey` is "" unless the person typed a new one. */
export type StudioDraft = {
  name: string;
  backend: Backend;
  modelKey: string;
  /** The trace collector's headers: "" unless the person typed new ones (the saved ones are never shown). */
  tracesHeaders: string;
  assistantName: string;
  instructions: string;
  greeting: string;
  studio: ProjectStudio;
  /** As typed: whole minutes, or "" for no limit. */
  monthlyMinutesCap: string;
};

/** What every Studio tab receives. */
export type StudioTabProps = {
  session: Session;
  /** The project as last saved on the server. */
  project: Project;
  draft: StudioDraft;
  update: (patch: Partial<StudioDraft>) => void;
  updateStudio: (patch: Partial<ProjectStudio>) => void;
  /** True when the draft differs from the saved project. */
  dirty: boolean;
  /** Saves the draft; resolves true when it was saved. */
  save: () => Promise<boolean>;
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
    studio: structuredClone(project.studio),
    monthlyMinutesCap: project.monthlyMinutesCap ? String(project.monthlyMinutesCap) : ""
  };
}

/** The typed limit as saved: whole minutes, null for none, undefined when it is not a whole number. */
export function minutesCapFromDraft(typed: string): number | null | undefined {
  const text = typed.trim();
  if (!text) return null;
  return /^\d{1,7}$/.test(text) && Number(text) > 0 ? Number(text) : undefined;
}

/** True when the draft has changes worth saving. */
export function draftChanged(draft: StudioDraft, project: Project): boolean {
  const saved = draftFromProject(project);
  return (
    Boolean(draft.modelKey) ||
    Boolean(draft.tracesHeaders) ||
    JSON.stringify({ ...draft, modelKey: "", tracesHeaders: "" }) !== JSON.stringify(saved)
  );
}

/** Per-browser memory of onboarding steps the server cannot know about. */
export function rememberStep(projectId: string, step: "tested" | "installed"): void {
  try {
    window.localStorage.setItem(`max-cloud:${step}:${projectId}`, "1");
  } catch {
    /* private mode: the checklist just forgets */
  }
}

export function stepDone(projectId: string, step: "tested" | "installed"): boolean {
  try {
    return window.localStorage.getItem(`max-cloud:${step}:${projectId}`) === "1";
  } catch {
    return false;
  }
}
