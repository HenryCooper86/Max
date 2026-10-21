import { act, StrictMode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionControls } from "../src/components/AccountBar";
import * as auth from "../src/lib/auth";
import type { AuthUser } from "../src/lib/auth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function user(role: AuthUser["role"], username = role): AuthUser {
  return {
    id: username,
    username,
    displayName: `用户 ${username}`,
    role,
    createdAt: 1,
    lastLoginAt: 1
  };
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.find((node) => node.type === "button" && text(node) === label);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

let renderer: ReactTestRenderer | null = null;
let visibilityHandler: (() => void) | undefined;
const removeVisibilityListener = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === "max.authToken" ? "sess_admin" : null),
    removeItem: vi.fn()
  });
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
  });
  vi.stubGlobal("document", {
    hidden: false,
    addEventListener: vi.fn((event: string, handler: () => void) => {
      if (event === "visibilitychange") visibilityHandler = handler;
    }),
    removeEventListener: removeVisibilityListener
  });
  const originalConsoleError = console.error;
  vi.spyOn(console, "error").mockImplementation((message: unknown, ...optionalParams: unknown[]) => {
    if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") return;
    originalConsoleError(message, ...optionalParams);
  });
  vi.spyOn(auth, "fetchUserMemorySummary").mockResolvedValue({
    enabled: true,
    turnCount: 4,
    factCount: 1
  });
  vi.spyOn(auth, "forgetUserMemory").mockResolvedValue(true);
  vi.spyOn(auth, "changePasswordAccount").mockResolvedValue({ ok: true });
  vi.spyOn(auth, "logoutAccount").mockResolvedValue();
});

afterEach(async () => {
  if (renderer) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
  visibilityHandler = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(role: AuthUser["role"] = "admin", onSignedOut = vi.fn(), showConnectionToken = false) {
  await act(async () => {
    renderer = create(
      <AccountSessionControls user={user(role)} onSignedOut={onSignedOut} showConnectionToken={showConnectionToken} />
    );
  });
  await flush();
  return { renderer, onSignedOut };
}

describe("AccountSessionControls", () => {
  it("does not claim token-copy success when the clipboard rejects", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }
    });
    await mount("admin", vi.fn(), true);

    await act(async () => button(renderer!, "复制令牌（App 用）").props.onClick());
    await flush();

    expect(text(renderer!.root)).not.toContain("已复制 ✓");
    expect(text(renderer!.root)).toContain("无法复制会话令牌。");
    expect(renderer!.root.find((node) => node.type === "p" && text(node) === "无法复制会话令牌。").props.role).toBe(
      "alert"
    );

    await act(async () => {
      renderer!.update(
        <AccountSessionControls user={user("tester", "replacement")} onSignedOut={vi.fn()} showConnectionToken />
      );
      await Promise.resolve();
    });
    expect(text(renderer!.root)).not.toContain("无法复制会话令牌。");
  });

  it("preserves password change, memory polling, four-second clear confirmation, and logout", async () => {
    const onSignedOut = vi.fn();
    await mount("reviewer", onSignedOut);

    act(() => button(renderer!, "修改密码").props.onClick());
    const passwordInputs = renderer!.root.findAllByType("input");
    act(() => {
      passwordInputs[0].props.onChange({ target: { value: "current-password" } });
      passwordInputs[1].props.onChange({ target: { value: "new-password" } });
    });
    await act(async () =>
      renderer!.root.findByProps({ "aria-label": "修改密码" }).props.onSubmit({
        preventDefault: vi.fn()
      })
    );
    await flush();
    expect(auth.changePasswordAccount).toHaveBeenCalledWith("current-password", "new-password");
    expect(text(renderer!.root)).toContain("密码已修改 ✓");

    act(() => button(renderer!, "记忆 4 段 · 1 条重点").props.onClick());
    expect(button(renderer!, "确认清除记忆?")).toBeDefined();
    act(() => vi.advanceTimersByTime(3_999));
    expect(button(renderer!, "确认清除记忆?")).toBeDefined();
    act(() => vi.advanceTimersByTime(1));
    expect(button(renderer!, "记忆 4 段 · 1 条重点")).toBeDefined();

    act(() => button(renderer!, "记忆 4 段 · 1 条重点").props.onClick());
    await act(async () => button(renderer!, "确认清除记忆?").props.onClick());
    await flush();
    expect(auth.forgetUserMemory).toHaveBeenCalledTimes(1);
    expect(text(renderer!.root)).toContain("记忆已清除 ✓");
    expect(renderer!.root.find((node) => node.type === "p" && text(node) === "记忆已清除 ✓").props.role).toBe("status");

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    visibilityHandler?.();
    await flush();
    expect(auth.fetchUserMemorySummary).toHaveBeenCalledTimes(3);

    await act(async () => button(renderer!, "退出登录").props.onClick());
    await flush();
    expect(auth.logoutAccount).toHaveBeenCalledTimes(1);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("cleans polling, confirmation, and feedback timers on unmount", async () => {
    await mount("admin", vi.fn(), true);
    await act(async () => button(renderer!, "复制令牌（App 用）").props.onClick());
    act(() => button(renderer!, "记忆 4 段 · 1 条重点").props.onClick());
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await act(async () => renderer?.unmount());
    renderer = null;
    expect(vi.getTimerCount()).toBe(0);
    expect(removeVisibilityListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("locks the app immediately while remote logout finishes after unmount", async () => {
    const pendingLogout = deferred<void>();
    vi.mocked(auth.logoutAccount).mockReturnValueOnce(pendingLogout.promise);
    const onSignedOut = vi.fn();
    await mount("tester", onSignedOut);

    act(() => button(renderer!, "退出登录").props.onClick());
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    await act(async () => renderer?.unmount());
    renderer = null;
    await act(async () => {
      pendingLogout.resolve();
      await pendingLogout.promise;
    });

    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("continues memory and password async writes after StrictMode effect replay", async () => {
    await act(async () => {
      renderer = create(
        <StrictMode>
          <AccountSessionControls user={user("admin")} onSignedOut={vi.fn()} />
        </StrictMode>
      );
    });
    await flush();
    expect(button(renderer, "记忆 4 段 · 1 条重点")).toBeDefined();

    act(() => button(renderer!, "修改密码").props.onClick());
    const passwordInputs = renderer!.root.findAllByType("input");
    act(() => {
      passwordInputs[0].props.onChange({ target: { value: "current-password" } });
      passwordInputs[1].props.onChange({ target: { value: "new-password" } });
    });
    await act(async () =>
      renderer!.root.findByProps({ "aria-label": "修改密码" }).props.onSubmit({
        preventDefault: vi.fn()
      })
    );
    await flush();
    expect(text(renderer.root)).toContain("密码已修改 ✓");
  });

  it("remounts password state and ignores an old password completion when the user changes", async () => {
    const pendingPassword = deferred<{ ok: boolean; error?: string }>();
    vi.mocked(auth.changePasswordAccount).mockReturnValueOnce(pendingPassword.promise);
    await mount("admin");

    act(() => button(renderer!, "修改密码").props.onClick());
    const passwordInputs = renderer!.root.findAllByType("input");
    act(() => {
      passwordInputs[0].props.onChange({ target: { value: "admin-current-secret" } });
      passwordInputs[1].props.onChange({ target: { value: "admin-new-secret" } });
    });
    act(() =>
      renderer!.root.findByProps({ "aria-label": "修改密码" }).props.onSubmit({
        preventDefault: vi.fn()
      })
    );

    await act(async () => {
      renderer!.update(<AccountSessionControls user={user("reviewer", "replacement")} onSignedOut={vi.fn()} />);
      await Promise.resolve();
    });
    expect(text(renderer!.root)).toContain("@replacement");
    expect(renderer!.root.findAllByProps({ "aria-label": "修改密码" })).toHaveLength(0);
    expect(text(renderer!.root)).not.toContain("admin-current-secret");
    expect(text(renderer!.root)).not.toContain("admin-new-secret");

    await act(async () => {
      pendingPassword.resolve({ ok: true });
      await pendingPassword.promise;
    });
    expect(text(renderer!.root)).not.toContain("密码已修改 ✓");
    expect(text(renderer!.root)).toContain("@replacement");
  });

  it("clears an armed memory confirmation when the user changes", async () => {
    await mount("admin");
    act(() => button(renderer!, "记忆 4 段 · 1 条重点").props.onClick());
    expect(button(renderer!, "确认清除记忆?")).toBeDefined();

    await act(async () => {
      renderer!.update(<AccountSessionControls user={user("tester", "replacement")} onSignedOut={vi.fn()} />);
      await Promise.resolve();
    });
    await flush();

    expect(text(renderer!.root)).toContain("@replacement");
    expect(renderer!.root.findAll((node) => node.type === "button" && text(node) === "确认清除记忆?")).toHaveLength(0);
    expect(button(renderer!, "记忆 4 段 · 1 条重点").props.disabled).toBe(false);
  });

  it("does not let an old memory clear keep a replacement user busy or alter their summary", async () => {
    const pendingClear = deferred<boolean>();
    vi.mocked(auth.forgetUserMemory).mockReturnValueOnce(pendingClear.promise);
    await mount("admin");
    act(() => button(renderer!, "记忆 4 段 · 1 条重点").props.onClick());
    act(() => button(renderer!, "确认清除记忆?").props.onClick());

    await act(async () => {
      renderer!.update(<AccountSessionControls user={user("reviewer", "replacement")} onSignedOut={vi.fn()} />);
      await Promise.resolve();
    });
    await flush();
    expect(button(renderer!, "记忆 4 段 · 1 条重点").props.disabled).toBe(false);

    await act(async () => {
      pendingClear.resolve(true);
      await pendingClear.promise;
    });
    expect(button(renderer!, "记忆 4 段 · 1 条重点").props.disabled).toBe(false);
    expect(text(renderer!.root)).not.toContain("记忆已清除 ✓");
    expect(text(renderer!.root)).toContain("@replacement");
  });

  it("resets copied, password-success, memory-summary, and memory-notice state for a replacement user", async () => {
    await mount("admin", vi.fn(), true);
    await act(async () => button(renderer!, "复制令牌（App 用）").props.onClick());
    await flush();
    expect(text(renderer!.root)).toContain("已复制 ✓");

    act(() => button(renderer!, "修改密码").props.onClick());
    const passwordInputs = renderer!.root.findAllByType("input");
    act(() => {
      passwordInputs[0].props.onChange({ target: { value: "current-password" } });
      passwordInputs[1].props.onChange({ target: { value: "new-password" } });
    });
    await act(async () =>
      renderer!.root.findByProps({ "aria-label": "修改密码" }).props.onSubmit({
        preventDefault: vi.fn()
      })
    );
    await flush();
    expect(text(renderer!.root)).toContain("密码已修改 ✓");

    act(() => button(renderer!, "记忆 4 段 · 1 条重点").props.onClick());
    await act(async () => button(renderer!, "确认清除记忆?").props.onClick());
    await flush();
    expect(text(renderer!.root)).toContain("记忆已清除 ✓");

    await act(async () => {
      renderer!.update(
        <AccountSessionControls user={user("reviewer", "replacement")} onSignedOut={vi.fn()} showConnectionToken />
      );
      await Promise.resolve();
    });
    await flush();

    expect(text(renderer!.root)).toContain("@replacement");
    expect(text(renderer!.root)).not.toContain("已复制 ✓");
    expect(text(renderer!.root)).not.toContain("密码已修改 ✓");
    expect(text(renderer!.root)).not.toContain("记忆已清除 ✓");
    expect(button(renderer!, "记忆 4 段 · 1 条重点").props.disabled).toBe(false);
    expect(auth.fetchUserMemorySummary).toHaveBeenCalledTimes(2);
  });
});
