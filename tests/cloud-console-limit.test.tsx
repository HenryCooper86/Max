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

describe("the per-user monthly minutes limit", () => {
  /** Studio → Settings with `updateProject` in place of the API, and what its answer will be. */
  async function settings(saved: Project = project) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const answer = Promise.withResolvers<{ project: Project }>();
    const updateProject = vi.fn(() => answer.promise);
    const onProjectChanged = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <LanguageProvider>
          <SettingsTab
            {...props(saved)}
            session={{ api: { ...api, updateProject }, token: "t", fail: String }}
            onProjectChanged={onProjectChanged}
            onKeyRotated={() => undefined}
            onDeleted={() => undefined}
          />
        </LanguageProvider>
      );
    });
    const field = (id: string) => renderer!.root.findByProps({ id });
    return {
      updateProject,
      onProjectChanged,
      answer,
      field,
      apply: () => renderer!.root.findByProps({ children: "立即应用上限" }),
      type: (id: string, value: string) => act(async () => field(id).props.onChange({ target: { value } })),
      shown: () => JSON.stringify(renderer!.toJSON()),
      close: async () => {
        await act(async () => renderer?.unmount());
        vi.unstubAllGlobals();
      }
    };
  }

  it("is typed by the project limit's rule, and keeps Apply closed while it is not a whole number or nothing changed", async () => {
    const view = await settings();
    try {
      expect(view.apply().props.disabled).toBe(true); // nothing changed
      await view.type("cxs-p1-user-minutes-cap", "1.5");
      expect(view.apply().props.disabled).toBe(true);
      expect(view.shown()).toContain("请填写 1 至 250,000 之间的整数分钟");
      // A valid project limit next to it does not get past the invalid one.
      await view.type("cxs-p1-minutes-cap", "600");
      expect(view.apply().props.disabled).toBe(true);
      expect(view.updateProject).not.toHaveBeenCalled();
      await view.type("cxs-p1-user-minutes-cap", "60");
      expect(view.field("cxs-p1-user-minutes-cap").props["aria-invalid"]).toBeUndefined();
      expect(view.apply().props.disabled).toBe(false);
      await act(async () => view.apply().props.onClick());
      // Both limits that changed go in one save; each one by itself when it is the only change.
      expect(view.updateProject).toHaveBeenCalledWith("t", "p1", { monthlyMinutesCap: 600, perUserMonthlyMinutes: 60 });
      const updated = { ...project, monthlyMinutesCap: 600, perUserMonthlyMinutes: 60 };
      await act(async () => view.answer.resolve({ project: updated }));
      expect(view.onProjectChanged).toHaveBeenCalledWith(updated);
    } finally {
      await view.close();
    }
  });

  it("is applied on its own when only it changed", async () => {
    const view = await settings();
    try {
      await view.type("cxs-p1-user-minutes-cap", " 60 ");
      await act(async () => view.apply().props.onClick());
      expect(view.updateProject).toHaveBeenLastCalledWith("t", "p1", { perUserMonthlyMinutes: 60 });
      await act(async () => view.answer.resolve({ project: { ...project, perUserMonthlyMinutes: 60 } }));
      expect(view.onProjectChanged).toHaveBeenLastCalledWith({ ...project, perUserMonthlyMinutes: 60 });
    } finally {
      await view.close();
    }
  });

  it("is taken off by emptying its field", async () => {
    const view = await settings({ ...project, perUserMonthlyMinutes: 60 });
    try {
      expect(view.field("cxs-p1-user-minutes-cap").props.value).toBe("60");
      await view.type("cxs-p1-user-minutes-cap", "");
      expect(view.apply().props.disabled).toBe(false);
      await act(async () => view.apply().props.onClick());
      expect(view.updateProject).toHaveBeenLastCalledWith("t", "p1", { perUserMonthlyMinutes: null });
      await act(async () => view.answer.resolve({ project }));
      expect(view.onProjectChanged).toHaveBeenLastCalledWith(project);
    } finally {
      await view.close();
    }
  });

  it("has its own field in Settings under the project's, saying it holds only sessions with a user ID", () => {
    const html = wrap(<SettingsTab {...props(project)} onKeyRotated={() => undefined} onDeleted={() => undefined} />);
    expect(html.indexOf('id="cxs-p1-minutes-cap"')).toBeLessThan(html.indexOf('id="cxs-p1-user-minutes-cap"'));
    expect(html).toContain("每个用户的每月分钟上限");
    expect(html).toContain("传入 userId");
    expect(html).toContain("网站嵌入和 Studio 测试没有用户 ID");
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
