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
import { patchFromDraft } from "../src/console/studio/Studio";
import { minutesCapFromDraft, draftFromProject, type StudioTabProps } from "../src/console/studio/types";

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
    savedProject: saved,
    release: null,
    releaseBusy: false,
    prepareTest: async () => null,
    refreshRelease: async () => {},
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
  it("validates whole minutes independently of the release configuration", () => {
    expect(patchFromDraft(draftFromProject(project))).not.toHaveProperty("monthlyMinutesCap");
    expect(minutesCapFromDraft("")).toBeNull();
    expect(minutesCapFromDraft(" 800 ")).toBe(800);
    expect(minutesCapFromDraft("250000")).toBe(250000);
    for (const value of ["250001", "lots", "0", "1.5"]) expect(minutesCapFromDraft(value)).toBeUndefined();
  });

  it("applies a valid cap immediately without saving a draft", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const pending = Promise.withResolvers<{ project: Project }>();
    const updateProject = vi.fn(() => pending.promise);
    const onProjectChanged = vi.fn();
    const options = props(project);
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <LanguageProvider>
            <SettingsTab
              {...options}
              session={{ api: { ...api, updateProject }, token: "t", fail: String }}
              onProjectChanged={onProjectChanged}
              onKeyRotated={() => undefined}
              onDeleted={() => undefined}
            />
          </LanguageProvider>
        );
      });
      const cap = () => renderer!.root.findByProps({ id: "cxs-p1-minutes-cap" });
      const apply = () => renderer!.root.findByProps({ children: "立即应用上限" });
      await act(async () => cap().props.onChange({ target: { value: "1.5" } }));
      expect(apply().props.disabled).toBe(true);
      expect(updateProject).not.toHaveBeenCalled();
      await act(async () => cap().props.onChange({ target: { value: "600" } }));
      await act(async () => apply().props.onClick());
      expect(updateProject).toHaveBeenCalledWith("t", "p1", { monthlyMinutesCap: 600 });
      expect(apply().props.disabled).toBe(true);
      const updated = { ...project, monthlyMinutesCap: 600 };
      await act(async () => pending.resolve({ project: updated }));
      expect(onProjectChanged).toHaveBeenCalledWith(updated);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
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

it("requires explicit confirmation to remove stored model keys and refreshes the release controls", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const updated = { ...project, hasModelKey: false };
  const updateProject = vi.fn(async () => ({ project: updated }));
  const onProjectChanged = vi.fn();
  const refreshRelease = vi.fn(async () => {});
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <LanguageProvider>
          <SettingsTab
            {...props(project)}
            session={{ api: { ...api, updateProject }, token: "t", fail: String }}
            onProjectChanged={onProjectChanged}
            refreshRelease={refreshRelease}
            onKeyRotated={() => undefined}
            onDeleted={() => undefined}
          />
        </LanguageProvider>
      );
    });
    const press = (children: string) => act(async () => renderer!.root.findByProps({ children }).props.onClick());
    await press("移除模型密钥");
    expect(updateProject).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain("回退版本将被清除");
    await press("取消");
    await press("移除模型密钥");
    await press("是，移除密钥");
    expect(updateProject).toHaveBeenCalledWith("t", "p1", { modelKey: "" });
    expect(onProjectChanged).toHaveBeenCalledWith(updated);
    expect(refreshRelease).toHaveBeenCalledOnce();
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});
