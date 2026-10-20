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

type AccountLocationStub = { hash: () => string; back: () => void; forward: () => void; restore: () => void };

/** react-test-renderer has no DOM history; stand in for location/history so
 * URL-driven filter hydration and Back/Forward navigation can be exercised. */
function stubAccountLocation(initialHash = "#/admin/accounts"): AccountLocationStub {
  const listeners = new Set<() => void>();
  const stack = [initialHash];
  let index = 0;
  const location = { origin: "https://max.example", hash: initialHash };
  const fire = () => {
    for (const listener of [...listeners]) listener();
  };
  const history = {
    pushState: (_state: unknown, _title: string, url: string) => {
      stack.splice(index + 1);
      stack.push(url);
      index = stack.length - 1;
      location.hash = url;
    },
    replaceState: (_state: unknown, _title: string, url: string) => {
      stack[index] = url;
      location.hash = url;
    },
    back: () => {
      if (index <= 0) return;
      index -= 1;
      location.hash = stack[index];
    },
    forward: () => {
      if (index >= stack.length - 1) return;
      index += 1;
      location.hash = stack[index];
    }
  };
  const scope = globalThis as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>([
    ["location", scope.location],
    ["history", scope.history],
    ["addEventListener", scope.addEventListener],
    ["removeEventListener", scope.removeEventListener],
    ["dispatchEvent", scope.dispatchEvent]
  ]);
  scope.location = location;
  scope.history = history;
  scope.addEventListener = (type: string, listener: () => void) => {
    if (type === "hashchange" || type === "popstate") listeners.add(listener);
  };
  scope.removeEventListener = (type: string, listener: () => void) => {
    listeners.delete(listener);
  };
  scope.dispatchEvent = (event: Event) => {
    if (event.type === "hashchange" || event.type === "popstate") fire();
    return true;
  };
  return {
    hash: () => location.hash,
    back: () => {
      history.back();
      fire();
    },
    forward: () => {
      history.forward();
      fire();
    },
    restore: () => {
      for (const [key, value] of originals) {
        if (value === undefined) delete scope[key];
        else scope[key] = value;
      }
    }
  };
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

    act(() => button(renderer!, "撤销").props.onClick());
    await act(async () => button(renderer!, "确认撤销 invite_123456789？").props.onClick());
    await flush();

    expect(text(renderer!.root)).toContain("邀请已不存在，无需再次撤销。");
  });

  it("requires target-specific confirmation before revoking an invite and expires the armed state", async () => {
    await mount();

    act(() => button(renderer!, "撤销").props.onClick());

    expect(adminAccountApi.revokeInvite).not.toHaveBeenCalled();
    expect(button(renderer!, "确认撤销 invite_123456789？")).toBeDefined();
    act(() => vi.advanceTimersByTime(3_999));
    expect(button(renderer!, "确认撤销 invite_123456789？")).toBeDefined();
    act(() => vi.advanceTimersByTime(1));
    expect(button(renderer!, "撤销")).toBeDefined();
    expect(adminAccountApi.revokeInvite).not.toHaveBeenCalled();
  });

  it("moves invite confirmation ownership to a newly selected target", async () => {
    const firstCode = "invite_first_123456";
    const secondCode = "invite_second_654321";
    vi.mocked(adminAccountApi.fetchOverview).mockResolvedValueOnce(
      success(overview(undefined, [invite(firstCode), invite(secondCode)]))
    );
    await mount();
    const inviteRow = (code: string) =>
      renderer!.root.find(
        (node) => node.props.className === "accountAdminRow invite" && text(node).includes(code.slice(4, 12))
      );
    const revokeButton = (code: string, label: string) =>
      inviteRow(code).find((node) => node.type === "button" && text(node) === label);

    act(() => revokeButton(firstCode, "撤销").props.onClick());
    expect(revokeButton(firstCode, `确认撤销 ${firstCode}？`)).toBeDefined();

    act(() => revokeButton(secondCode, "撤销").props.onClick());
    expect(revokeButton(firstCode, "撤销")).toBeDefined();
    expect(revokeButton(secondCode, `确认撤销 ${secondCode}？`)).toBeDefined();
    expect(adminAccountApi.revokeInvite).not.toHaveBeenCalled();

    await act(async () => revokeButton(secondCode, `确认撤销 ${secondCode}？`).props.onClick());
    expect(adminAccountApi.revokeInvite).toHaveBeenCalledTimes(1);
    expect(adminAccountApi.revokeInvite).toHaveBeenCalledWith(secondCode);
  });

  it("cleans the armed invite expiry timer on unmount", async () => {
    await mount();
    act(() => button(renderer!, "撤销").props.onClick());
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await act(async () => renderer?.unmount());
    renderer = null;

    expect(vi.getTimerCount()).toBe(0);
    expect(adminAccountApi.revokeInvite).not.toHaveBeenCalled();
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
    const recoveryLink = renderer!.root.findByProps({ "aria-label": "手动复制邀请链接" });
    expect(recoveryLink.props.readOnly).toBe(true);
    expect(recoveryLink.props.value).toBe("https://max.example/?invite=invite_created");
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

  it("omits self-role mutation and self-delete controls for the current administrator", async () => {
    await mount();

    const selfRow = renderer!.root.find(
      (node) => node.props.className === "accountAdminRow" && text(node).includes("@admin")
    );
    expect(selfRow.findAllByType("select")).toHaveLength(0);
    expect(selfRow.findAllByType("button")).toHaveLength(0);
    expect(text(selfRow)).toContain("当前账号 · 管理员");
    expect(adminAccountApi.updateRole).not.toHaveBeenCalled();
    expect(adminAccountApi.deleteUser).not.toHaveBeenCalled();
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

    expect(text(renderer!.root)).toContain("@alice");
    expect(renderer!.root.findByProps({ "data-load-status": "ready" })).toBeDefined();
  });

  it("filters accounts and invites with per-group empty hints", async () => {
    await mount();
    const filterInput = renderer!.root.findByProps({ placeholder: "姓名、角色或邀请码" });
    await act(async () => filterInput.props.onChange({ target: { value: "alice" } }));
    expect(text(renderer!.root)).toContain("@alice");
    expect(text(renderer!.root)).not.toContain("@admin");
    expect(text(renderer!.root)).toContain("没有邀请匹配当前筛选。");
    expect(text(renderer!.root)).not.toContain("没有账号匹配当前筛选。");
  });

  it("groups users and invites into distinct sections with counts and role details", async () => {
    await mount();
    const groups = renderer!.root.findAllByProps({ className: "adminAccountGroup" });
    expect(groups).toHaveLength(2);
    expect(text(groups[0])).toContain("用户");
    expect(text(groups[0])).toContain("2 / 2");
    expect(text(groups[1])).toContain("未使用邀请");
    expect(text(groups[1])).toContain("1 / 1");
    expect(text(renderer!.root)).toContain("管理账号与邀请、发布策略、批准版本");
    expect(text(renderer!.root)).toContain("记录并提交测试会话证据");
  });

  it("labels invite status and shows absolute expiry with a countdown", async () => {
    vi.mocked(adminAccountApi.fetchOverview).mockResolvedValueOnce(
      success(
        overview(undefined, [
          { ...invite("invite_fresh_1111"), expiresAt: Date.now() + 5 * 86_400_000 },
          { ...invite("invite_soon_22222"), expiresAt: Date.now() + 3_600_000 },
          { ...invite("invite_late_33333"), expiresAt: Date.now() - 1_000 }
        ])
      )
    );
    await mount();
    const chips = renderer!.root.findAll(
      (node) => node.type === "span" && String(node.props.className).split(" ").includes("inviteStatus")
    );
    expect(chips.map((chip) => text(chip))).toEqual(["已过期", "即将过期", "未使用"]);
    expect(text(renderer!.root)).toContain("后过期");
  });

  it("hydrates the account filter from the accounts URL and ignores governance params", async () => {
    vi.stubGlobal("location", { origin: "https://max.example", hash: "#/admin/accounts?q=alice" });
    await mount();
    expect(text(renderer!.root)).toContain("@alice");
    expect(text(renderer!.root)).not.toContain("@admin");
    await act(async () => renderer?.unmount());
    renderer = null;

    vi.stubGlobal("location", { origin: "https://max.example", hash: "#/admin/governance?q=alice" });
    await mount();
    expect(text(renderer!.root)).toContain("@alice");
    expect(text(renderer!.root)).toContain("@admin");
  });

  it("keeps the account filter in sync across browser Back and Forward", async () => {
    const location = stubAccountLocation();
    await mount();
    try {
      const filter = () => renderer!.root.findByProps({ placeholder: "姓名、角色或邀请码" });

      await act(async () => filter().props.onChange({ target: { value: "alice" } }));
      expect(filter().props.value).toBe("alice");
      expect(text(renderer!.root)).toContain("@alice");
      expect(text(renderer!.root)).not.toContain("@admin");
      expect(location.hash()).toBe("#/admin/accounts?q=alice");

      await act(async () => filter().props.onChange({ target: { value: "admin" } }));
      expect(filter().props.value).toBe("admin");
      expect(text(renderer!.root)).toContain("@admin");
      expect(text(renderer!.root)).not.toContain("@alice");
      expect(location.hash()).toBe("#/admin/accounts?q=admin");

      act(() => location.back());
      await flush();
      expect(location.hash()).toBe("#/admin/accounts?q=alice");
      expect(filter().props.value).toBe("alice");
      expect(text(renderer!.root)).toContain("@alice");

      act(() => location.forward());
      await flush();
      expect(location.hash()).toBe("#/admin/accounts?q=admin");
      expect(filter().props.value).toBe("admin");
      expect(text(renderer!.root)).toContain("@admin");
    } finally {
      await act(async () => renderer?.unmount());
      renderer = null;
      location.restore();
    }
  });

  it("rejects a role update when the server returns a mismatched target", async () => {
    vi.mocked(adminAccountApi.updateRole).mockResolvedValueOnce(success(user("alice", "tester")));
    await mount();
    const roleSelect = () =>
      renderer!.root.find((node) => node.type === "select" && node.props["aria-label"] === "alice 的角色");

    await act(async () => roleSelect().props.onChange({ target: { value: "reviewer" } }));
    await flush();

    expect(text(renderer!.root)).toContain("服务器返回的角色更新与请求目标不一致。");
    expect(text(renderer!.root)).not.toContain("@alice 现在是审核员。");
    expect(adminAccountApi.fetchOverview).toHaveBeenCalledTimes(1);
  });

  it("rejects a deletion when the server returns a different account", async () => {
    vi.mocked(adminAccountApi.deleteUser).mockResolvedValueOnce(success(user("bob", "tester")));
    await mount();

    act(() => button(renderer!, "删除").props.onClick());
    await act(async () => button(renderer!, "确认删除 @alice？").props.onClick());
    await flush();

    expect(text(renderer!.root)).toContain("服务器返回的账号与删除目标不一致。");
    expect(text(renderer!.root)).not.toContain("@alice 已删除。");
  });

  it("blocks every mutation control while a role change is in flight", async () => {
    const pending = deferred<ApiResult<AuthUser>>();
    vi.mocked(adminAccountApi.updateRole).mockReturnValueOnce(pending.promise);
    await mount();
    const roleSelect = () =>
      renderer!.root.find((node) => node.type === "select" && node.props["aria-label"] === "alice 的角色");

    await act(async () => roleSelect().props.onChange({ target: { value: "reviewer" } }));
    expect(roleSelect().props.disabled).toBe(true);
    expect(button(renderer!, "撤销").props.disabled).toBe(true);
    expect(button(renderer!, "生成邀请链接").props.disabled).toBe(true);

    await act(async () => {
      pending.resolve(success(user("alice", "reviewer")));
      await pending.promise;
    });
    await flush();
    expect(button(renderer!, "撤销").props.disabled).toBe(false);
  });
});
