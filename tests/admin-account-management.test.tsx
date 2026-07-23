import { act, StrictMode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManagement } from "../src/components/admin/AccountManagement";
import type { ApiResult } from "../src/lib/api-client";
import { adminAccountApi, type AdminOverview, type AuthUser, type InviteInfo } from "../src/lib/auth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function success<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function failure(kind: "unauthorized" | "forbidden" | "server" | "unavailable", message: string): ApiResult<never> {
  return { ok: false, error: { kind, message } };
}

function user(username: string, role: AuthUser["role"] = "admin"): AuthUser {
  return {
    id: username,
    username,
    displayName: `用户 ${username}`,
    role,
    createdAt: 1,
    lastLoginAt: 1
  };
}

function invite(code = "invite_123456789"): InviteInfo {
  return {
    code,
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 86_400_000,
    createdBy: "admin"
  };
}

function overview(
  users: AuthUser[] = [user("admin"), user("alice", "tester")],
  invites: InviteInfo[] = [invite()]
): AdminOverview {
  return { users, invites };
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.find((node) => node.type === "button" && text(node) === label);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("location", { origin: "https://max.example" });
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
  });
  const originalConsoleError = console.error;
  vi.spyOn(console, "error").mockImplementation((message: unknown, ...optionalParams: unknown[]) => {
    if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") return;
    originalConsoleError(message, ...optionalParams);
  });
  vi.spyOn(adminAccountApi, "fetchOverview").mockResolvedValue(success(overview()));
  vi.spyOn(adminAccountApi, "createInvite").mockResolvedValue(success(invite("invite_created")));
  vi.spyOn(adminAccountApi, "revokeInvite").mockResolvedValue(success({ removed: true }));
  vi.spyOn(adminAccountApi, "deleteUser").mockResolvedValue(success(user("alice", "tester")));
  vi.spyOn(adminAccountApi, "updateRole").mockResolvedValue(success(user("alice", "reviewer")));
});

afterEach(async () => {
  if (renderer) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(currentUser = user("admin"), onAuthenticationExpired = vi.fn()) {
  await act(async () => {
    renderer = create(<AccountManagement user={currentUser} onAuthenticationExpired={onAuthenticationExpired} />);
  });
  await flush();
  return { renderer, onAuthenticationExpired };
}

describe("AccountManagement", () => {
  it("routes an explicit 401 to authentication expiry and shows a typed 403 message", async () => {
    const onAuthenticationExpired = vi.fn();
    vi.mocked(adminAccountApi.fetchOverview).mockResolvedValueOnce(failure("unauthorized", "会话已过期。"));
    await mount(user("admin"), onAuthenticationExpired);
    expect(onAuthenticationExpired).toHaveBeenCalledTimes(1);

    await act(async () => renderer?.unmount());
    renderer = null;
    vi.mocked(adminAccountApi.fetchOverview).mockResolvedValueOnce(failure("forbidden", "只有管理员可以查看账号。"));
    await mount();
    expect(text(renderer!.root)).toContain("只有管理员可以查看账号。");
  });

  it("keeps loaded account data visible and marks it stale after refresh failure", async () => {
    await mount();
    vi.mocked(adminAccountApi.fetchOverview).mockResolvedValueOnce(failure("server", "账号服务暂时不可用。"));

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    await flush();

    expect(text(renderer!.root)).toContain("@alice");
    expect(text(renderer!.root)).toContain("数据可能已过期");
    expect(text(renderer!.root)).toContain("账号服务暂时不可用。");
  });

  it("does not report revoked or already-used invites as newly removed", async () => {
    vi.mocked(adminAccountApi.revokeInvite).mockResolvedValueOnce(success({ removed: false }));
    await mount();

    await act(async () => button(renderer!, "撤销").props.onClick());
    await flush();

    expect(text(renderer!.root)).toContain("邀请已不存在，无需再次撤销。");
  });

  it("reports clipboard failure after authoritative invite creation without claiming it copied", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }
    });
    await mount();

    await act(async () => button(renderer!, "生成邀请链接").props.onClick());
    await flush();

    expect(text(renderer!.root)).toContain("链接已生成，但无法写入剪贴板。");
    expect(text(renderer!.root)).not.toContain("邀请链接已复制 ✓");
    expect(adminAccountApi.fetchOverview).toHaveBeenCalledTimes(2);
  });

  it("keeps authoritative invite and clipboard outcomes visible when the follow-up refresh fails", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }
    });
    vi.mocked(adminAccountApi.fetchOverview)
      .mockResolvedValueOnce(success(overview()))
      .mockResolvedValueOnce(failure("server", "刷新账号列表失败。"));
    await mount();

    await act(async () => button(renderer!, "生成邀请链接").props.onClick());
    await flush();

    expect(text(renderer!.root)).toContain("链接已生成，但无法写入剪贴板。");
    expect(text(renderer!.root)).toContain("刷新账号列表失败。");
    expect(text(renderer!.root)).toContain("数据可能已过期");
  });

  it("uses Chinese role options and target-specific deletion confirmation", async () => {
    await mount();
    const roleSelect = renderer!.root.find(
      (node) => node.type === "select" && node.props["aria-label"] === "alice 的角色"
    );
    expect(roleSelect.findAllByType("option").map((option) => [option.props.value, text(option)])).toEqual([
      ["tester", "测试员"],
      ["reviewer", "审核员"],
      ["admin", "管理员"]
    ]);

    act(() => button(renderer!, "删除").props.onClick());
    expect(button(renderer!, "确认删除 @alice？")).toBeDefined();
    act(() => vi.advanceTimersByTime(3_999));
    expect(button(renderer!, "确认删除 @alice？")).toBeDefined();
    act(() => vi.advanceTimersByTime(1));
    expect(button(renderer!, "删除")).toBeDefined();
  });

  it("clears an earlier mutation error after an authoritative success and refresh", async () => {
    vi.mocked(adminAccountApi.updateRole)
      .mockResolvedValueOnce(failure("forbidden", "不能修改这个账号。"))
      .mockResolvedValueOnce(success(user("alice", "reviewer")));
    await mount();
    const roleSelect = () =>
      renderer!.root.find((node) => node.type === "select" && node.props["aria-label"] === "alice 的角色");

    await act(async () => roleSelect().props.onChange({ target: { value: "reviewer" } }));
    await flush();
    expect(text(renderer!.root)).toContain("不能修改这个账号。");

    await act(async () => roleSelect().props.onChange({ target: { value: "reviewer" } }));
    await flush();
    expect(text(renderer!.root)).not.toContain("不能修改这个账号。");
    expect(text(renderer!.root)).toContain("@alice 现在是审核员。");
  });

  it("does not let an older invite clipboard completion erase a newer mutation result", async () => {
    const clipboardWrite = deferred<void>();
    vi.mocked(navigator.clipboard.writeText).mockReturnValueOnce(clipboardWrite.promise);
    await mount();

    act(() => button(renderer!, "复制链接").props.onClick());
    const roleSelect = renderer!.root.find(
      (node) => node.type === "select" && node.props["aria-label"] === "alice 的角色"
    );
    await act(async () => roleSelect.props.onChange({ target: { value: "reviewer" } }));
    await flush();
    expect(text(renderer!.root)).toContain("@alice 现在是审核员。");

    await act(async () => {
      clipboardWrite.resolve();
      await clipboardWrite.promise;
    });
    expect(text(renderer!.root)).toContain("@alice 现在是审核员。");
  });

  it("ignores a superseded account load and cleans timers on unmount", async () => {
    const older = deferred<ApiResult<AdminOverview>>();
    vi.mocked(adminAccountApi.fetchOverview)
      .mockReset()
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(success(overview([user("admin-b"), user("bob", "reviewer")], [])));
    await act(async () => {
      renderer = create(<AccountManagement user={user("admin-a")} onAuthenticationExpired={vi.fn()} />);
    });
    await act(async () => {
      renderer!.update(<AccountManagement user={user("admin-b")} onAuthenticationExpired={vi.fn()} />);
      await Promise.resolve();
    });
    expect(text(renderer!.root)).toContain("@bob");

    await act(async () => {
      older.resolve(success(overview([user("admin-a"), user("alice", "tester")], [])));
      await older.promise;
    });
    expect(text(renderer!.root)).toContain("@bob");
    expect(text(renderer!.root)).not.toContain("@alice");

    await act(async () => renderer?.unmount());
    renderer = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues accepting async account loads after StrictMode effect replay", async () => {
    await act(async () => {
      renderer = create(
        <StrictMode>
          <AccountManagement user={user("admin")} onAuthenticationExpired={vi.fn()} />
        </StrictMode>
      );
    });
    await flush();

    expect(text(renderer.root)).toContain("@alice");
    expect(renderer.root.findByProps({ "data-load-status": "ready" })).toBeDefined();
  });
});
