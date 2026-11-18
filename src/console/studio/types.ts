import type { Backend, Project, ProjectStudio } from "../api";
import type { Session } from "../hooks";

export type StudioTab = "agent" | "knowledge" | "tools" | "test" | "install" | "history" | "settings";

/** Everything the Studio edits before it is saved. `modelKey` is "" unless the person typed a new one. */
export type StudioDraft = {
  name: string;
  backend: Backend;
  modelKey: string;
  assistantName: string;
  instructions: string;
  greeting: string;
  studio: ProjectStudio;
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
    assistantName: project.assistantName,
    instructions: project.instructions,
    greeting: project.greeting,
    studio: structuredClone(project.studio)
  };
}

/** True when the draft has changes worth saving. */
export function draftChanged(draft: StudioDraft, project: Project): boolean {
  const saved = draftFromProject(project);
  return Boolean(draft.modelKey) || JSON.stringify({ ...draft, modelKey: "" }) !== JSON.stringify(saved);
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
