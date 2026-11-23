import { useSyncExternalStore } from "react";
import type { Workspace, WorkspaceSection } from "./admin-model";

const TESTING_SECTIONS: readonly WorkspaceSection[] = [
  "overview",
  "plans",
  "evidence",
  "quality",
  "releases",
  "diagnostics",
  "policies"
];
const ADMIN_SECTIONS: readonly WorkspaceSection[] = ["overview", "studio", "flow", "accounts", "audit"];

function locationHash(): string {
  return typeof window === "undefined" ? "" : (window.location?.hash ?? "");
}

function parseLocation(hash: string) {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?", 2);
  const root = path.split("/")[1];
  const workspace: Workspace | null = root === "testing" || root === "admin" ? root : null;
  const candidate = path.split("/")[2] as WorkspaceSection;
  const sections = workspace === "admin" ? ADMIN_SECTIONS : TESTING_SECTIONS;
  return {
    workspace,
    isWorkspace: workspace !== null,
    isTesting: workspace === "testing",
    isAdmin: workspace === "admin",
    section: sections.includes(candidate) ? candidate : ("overview" as WorkspaceSection),
    params: new URLSearchParams(query)
  };
}

export function readWorkspaceLocation() {
  return parseLocation(locationHash());
}

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || !window.addEventListener) return () => {};
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
  };
}

export function setWorkspaceLocation(
  section: WorkspaceSection,
  updates: Record<string, string | null> = {},
  replace = false,
  workspace?: Workspace
): void {
  if (typeof window === "undefined" || !window.location || !window.history) return;
  const current = readWorkspaceLocation();
  const target =
    workspace ??
    (section === "accounts" || section === "audit" || section === "studio" || section === "flow"
      ? "admin"
      : section === "overview"
        ? (current.workspace ?? "testing")
        : "testing");
  const allowed = target === "admin" ? ADMIN_SECTIONS : TESTING_SECTIONS;
  const targetSection = allowed.includes(section) ? section : "overview";
  const params =
    current.workspace === target && current.section === targetSection ? current.params : new URLSearchParams();
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  const hash = `#/${target}/${targetSection}${query ? `?${query}` : ""}`;
  if (hash === locationHash()) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", hash);
  window.dispatchEvent(new Event("hashchange"));
}

export function leaveWorkspaceLocation(): void {
  if (typeof window === "undefined" || !window.location || !window.history) return;
  window.history.pushState(null, "", window.location.pathname + window.location.search);
  window.dispatchEvent(new Event("hashchange"));
}

export function useWorkspaceLocation() {
  const hash = useSyncExternalStore(subscribe, locationHash, () => "");
  return { ...parseLocation(hash), navigate: setWorkspaceLocation };
}
