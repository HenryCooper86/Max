import { afterEach, describe, expect, it, vi } from "vitest";
import {
  leaveWorkspaceLocation,
  readWorkspaceLocation,
  setWorkspaceLocation
} from "../src/components/admin/workspace-location";

function installLocation(hash: string) {
  let url = new URL(`https://max.example/app?language=en${hash}`);
  const events = new EventTarget();
  const history: string[] = [];
  vi.stubGlobal("window", {
    get location() {
      return url;
    },
    history: {
      pushState: (_state: unknown, _title: string, next: string) => {
        url = new URL(next, url);
        history.push(url.href);
      },
      replaceState: (_state: unknown, _title: string, next: string) => {
        url = new URL(next, url);
      }
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events)
  });
  return { current: () => url, history, events };
}

afterEach(() => vi.unstubAllGlobals());

describe("separate testing and administration routes", () => {
  it("does not carry administration diagnostics or build filters into testing sessions", () => {
    installLocation("#/admin/evidence?session=private-old&build=deadbeef&tab=diagnostics");
    setWorkspaceLocation("evidence", { session: "chosen-session" }, false, "testing");
    const location = readWorkspaceLocation();
    expect(location.workspace).toBe("testing");
    expect(location.params.get("session")).toBe("chosen-session");
    expect(location.params.has("build")).toBe(false);
    expect(location.params.has("tab")).toBe(false);
  });

  it("keeps unrelated filters when editing the same session view, and explicitly clears removed ones", () => {
    installLocation("#/testing/evidence?tester=kim&quality=fail&q=old");
    setWorkspaceLocation("evidence", { q: "rider & traffic?", quality: null });
    const location = readWorkspaceLocation();
    expect(location.workspace).toBe("testing");
    expect(location.params.get("tester")).toBe("kim");
    expect(location.params.get("q")).toBe("rider & traffic?");
    expect(location.params.has("quality")).toBe(false);
  });

  it("opens management-only sections in administration without carrying testing filters", () => {
    installLocation("#/testing/evidence?tester=kim&quality=fail");
    setWorkspaceLocation("governance", { tab: "audit" });
    const location = readWorkspaceLocation();
    expect(location.isAdmin).toBe(true);
    expect(location.section).toBe("governance");
    expect([...location.params.keys()]).toEqual(["tab"]);
  });

  it("opens test plans in testing even when leaving an administrative page", () => {
    installLocation("#/admin/releases?run=release-a");
    setWorkspaceLocation("plans");
    const location = readWorkspaceLocation();
    expect(location.isTesting).toBe(true);
    expect(location.section).toBe("plans");
    expect(location.params.has("run")).toBe(false);
  });

  it("does not treat an administrative section below the testing root as an admin route", () => {
    installLocation("#/testing/accounts");
    const location = readWorkspaceLocation();
    expect(location.isTesting).toBe(true);
    expect(location.isAdmin).toBe(false);
    expect(location.section).toBe("overview");
  });

  it("does not recognize similarly prefixed application paths as a workspace", () => {
    installLocation("#/administrator/accounts");
    expect(readWorkspaceLocation().isWorkspace).toBe(false);
  });

  it("notifies consumers only after the complete new workspace URL is installed", () => {
    const location = installLocation("#/testing/evidence?session=a");
    const observed: string[] = [];
    location.events.addEventListener("hashchange", () => observed.push(location.current().hash));
    setWorkspaceLocation("overview", {}, false, "admin");
    expect(observed).toEqual(["#/admin/overview"]);
    expect(location.history).toHaveLength(1);
  });

  it("leaves both workspace roots without losing the application's path and query", () => {
    const location = installLocation("#/testing/plans");
    leaveWorkspaceLocation();
    expect(location.current().pathname).toBe("/app");
    expect(location.current().search).toBe("?language=en");
    expect(location.current().hash).toBe("");
    expect(readWorkspaceLocation().isWorkspace).toBe(false);
  });
});
