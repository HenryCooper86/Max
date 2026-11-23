// @vitest-environment happy-dom
// The console side of a project's monthly minutes limit: the Settings field,
// what a save sends, and the embed copy that points owners to it.
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_STUDIO } from "../shared/cloud-studio";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { createCloudApi, type Project } from "../src/console/api";
import { InstallTab } from "../src/console/studio/InstallTab";
import { SettingsTab } from "../src/console/studio/SettingsTab";
import { patchFromDraft, Studio } from "../src/console/studio/Studio";
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

  it("accepts the relay's maximum and rejects a higher limit", () => {
    const draft = draftFromProject(project);
    expect(patchFromDraft({ ...draft, monthlyMinutesCap: "250000" }).monthlyMinutesCap).toBe(250000);
    expect(patchFromDraft({ ...draft, monthlyMinutesCap: "250001" })).not.toHaveProperty("monthlyMinutesCap");
  });

  it("keeps an invalid limit in the editor when Save is pressed", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const pending = Promise.withResolvers<{ project: Project }>();
    const updateProject = vi.fn(() => pending.promise);
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <Studio
            session={{ api: { ...api, updateProject }, token: "t", fail: String }}
            project={project}
            initialTab="settings"
            origin="https://max.example"
            onChanged={() => undefined}
            onKeyRotated={() => undefined}
            onDeleted={() => undefined}
          />
        );
      });
      const cap = () => renderer!.root.findByProps({ id: "cxs-p1-minutes-cap" });
      await act(async () => cap().props.onChange({ target: { value: "1.5" } }));
      const save = renderer!.root.findByProps({ children: "保存" });
      if (!save.props.disabled) await act(async () => save.props.onClick());
      expect(updateProject).not.toHaveBeenCalled();
      expect(cap().props.value).toBe("1.5");

      await act(async () => cap().props.onChange({ target: { value: "600" } }));
      await act(async () => renderer!.root.findByProps({ children: "保存" }).props.onClick());
      expect(updateProject).toHaveBeenCalledOnce();
      expect(renderer!.root.findByProps({ role: "tabpanel" }).props.inert).toBe(true);
      await act(async () => pending.resolve({ project: { ...project, monthlyMinutesCap: 600 } }));
      expect(renderer!.root.findByProps({ role: "tabpanel" }).props.inert).toBeFalsy();
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("reads a relay that does not know about limits as having none", () => {
    const older: Project = { ...project };
    delete older.monthlyMinutesCap;
    expect(draftFromProject(older).monthlyMinutesCap).toBe("");
  });

  it("has its own field in Settings", () => {
    const html = wrap(<SettingsTab {...props(project)} onKeyRotated={() => undefined} onDeleted={() => undefined} />);
    expect(html).toContain("每月分钟上限");
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('value="500"');
  });

  it("is pointed to from the embed settings, which state the real limit of 3 conversations", () => {
    const html = wrap(<InstallTab {...props(project)} />);
    expect(html).toContain("同时最多 3 场对话");
    expect(html).not.toContain("同时最多 5 场对话");
    expect(html).toContain("每月分钟上限");
  });
});
