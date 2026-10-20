import { useSyncExternalStore } from "react";
import type { AdminSection } from "./admin-model";

const SECTIONS: readonly AdminSection[] = ["overview", "releases", "evidence", "accounts", "governance"];

function locationHash(): string {
  return typeof window === "undefined" ? "" : (window.location?.hash ?? "");
}

function parseLocation(hash: string) {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?", 2);
  const candidate = path.split("/")[2] as AdminSection;
  return {
    isAdmin: path === "/admin" || path.startsWith("/admin/"),
    section: SECTIONS.includes(candidate) ? candidate : ("overview" as AdminSection),
    params: new URLSearchParams(query)
  };
}

export function readAdminLocation() {
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

export function setAdminLocation(
  section: AdminSection,
  updates: Record<string, string | null> = {},
  replace = false
): void {
  if (typeof window === "undefined" || !window.location || !window.history) return;
  const current = readAdminLocation();
  const params = current.isAdmin && current.section === section ? current.params : new URLSearchParams();
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  const hash = `#/admin/${section}${query ? `?${query}` : ""}`;
  if (hash === locationHash()) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", hash);
  window.dispatchEvent(new Event("hashchange"));
}

export function leaveAdminLocation(): void {
  if (typeof window === "undefined" || !window.location || !window.history) return;
  window.history.pushState(null, "", window.location.pathname + window.location.search);
  window.dispatchEvent(new Event("hashchange"));
}

export function useAdminLocation() {
  const hash = useSyncExternalStore(subscribe, locationHash, () => "");
  return { ...parseLocation(hash), navigate: setAdminLocation };
}
