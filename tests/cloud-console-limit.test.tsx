// The console side of a project's monthly minutes limit: the Settings field,
// what a save sends, and the embed copy that points owners to it.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_STUDIO } from "../shared/cloud-studio";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { createCloudApi, type Project } from "../src/console/api";
import { InstallTab } from "../src/console/studio/InstallTab";
import { SettingsTab } from "../src/console/studio/SettingsTab";
import { patchFromDraft } from "../src/console/studio/Studio";
import { draftChanged, draftFromProject, type StudioTabProps } from "../src/console/studio/types";

const wrap = (node: React.ReactNode) => renderToStaticMarkup(<LanguageProvider>{node}</LanguageProvider>);
const api = createCloudApi(async () => new Response("{}"));

const project: Project = {
  id: "p1",
  name: "Demo",
  keyPrefix: "mpk_abcd",
  backend: "openai",
  hasModelKey: true,
  assistantName: "Max",
  instructions: "",
  greeting: "",
  studio: DEFAULT_STUDIO,
  publicId: "pub_0123456789abcdef01234567",
  hasWebhookSecret: false,
  monthlyMinutesCap: 500,
  createdAt: 1
};

function props(saved: Project): StudioTabProps {
  return {
    session: { api, token: "t", fail: () => "" },
    project: saved,
    draft: draftFromProject(saved),
    update: () => undefined,
    updateStudio: () => undefined,
    dirty: false,
    save: async () => true,
    origin: "https://max.example",
    goTo: () => undefined,
    onProjectChanged: () => undefined
  };
}

describe("the monthly minutes limit", () => {
  it("is edited as text and saved as whole minutes, or null for none", () => {
    const draft = draftFromProject(project);
    expect(draft.monthlyMinutesCap).toBe("500");
    expect(draftChanged(draft, project)).toBe(false);
    expect(patchFromDraft(draft).monthlyMinutesCap).toBe(500);
    expect(draftChanged({ ...draft, monthlyMinutesCap: "800" }, project)).toBe(true);
    expect(patchFromDraft({ ...draft, monthlyMinutesCap: " 800 " }).monthlyMinutesCap).toBe(800);
    expect(patchFromDraft({ ...draft, monthlyMinutesCap: "" }).monthlyMinutesCap).toBeNull();
    // Not a whole number: left out, so a save never clears the limit by accident.
    expect(patchFromDraft({ ...draft, monthlyMinutesCap: "1.5" })).not.toHaveProperty("monthlyMinutesCap");
    expect(patchFromDraft({ ...draft, monthlyMinutesCap: "lots" })).not.toHaveProperty("monthlyMinutesCap");
  });

  it("reads a relay that does not know about limits as having none", () => {
    const older: Project = { ...project };
    delete older.monthlyMinutesCap;
    expect(draftFromProject(older).monthlyMinutesCap).toBe("");
  });

  it("has its own field in Settings", () => {
    const html = wrap(<SettingsTab {...props(project)} onKeyRotated={() => undefined} onDeleted={() => undefined} />);
    expect(html).toContain("每月分钟上限");
    expect(html).toContain('type="number"');
    expect(html).toContain('value="500"');
  });

  it("is pointed to from the embed settings, which state the real limit of 3 conversations", () => {
    const html = wrap(<InstallTab {...props(project)} />);
    expect(html).toContain("同时最多 3 场对话");
    expect(html).not.toContain("同时最多 5 场对话");
    expect(html).toContain("每月分钟上限");
  });
});
