// Client side of user accounts: session-token storage plus thin wrappers for
// the relay's /auth endpoints. The session token rides the same channels as
// the relay token (Bearer header for HTTP, ?token= for the WebSocket), so a
// logged-in tester needs no shared operator secret.

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "reviewer" | "tester";
  createdAt: number;
  lastLoginAt: number;
};

export type AuthResponse = { ok: true; token: string; user: AuthUser } | { ok: false; error: string };

export type CurrentUserResult =
  { status: "authenticated"; user: AuthUser } | { status: "unauthenticated" } | { status: "unavailable" };

export type UserMemorySummary = {
  enabled: boolean;
  updatedAt?: number;
  turnCount: number;
  factCount: number;
  session?: {
    language?: "zh" | "en";
    destination?: string;
    lastIntent?: string;
    responseMode?: "concise" | "normal" | "emergency";
  };
};

import { relayAuthToken } from "./persistence";
import { requestJson, type ApiResult } from "./api-client";

const AUTH_TOKEN_KEY = "max.authToken";

export function authToken(): string {
  try {
    return window.localStorage.getItem(AUTH_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeAuthToken(token: string) {
  try {
    if (token) window.localStorage.setItem(AUTH_TOKEN_KEY, token);
    else window.localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    /* storage unavailable — the session then lasts until reload */
  }
}

async function postAuth(path: string, body: Record<string, unknown>): Promise<AuthResponse> {
  try {
    // A stored operator relay token rides along: token-protected relays
    // require it (or an invite) for self-registration.
    const relayToken = relayAuthToken();
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(relayToken ? { Authorization: `Bearer ${relayToken}` } : {})
      },
      body: JSON.stringify(body)
    });
    const payload = (await response.json()) as AuthResponse;
    if (payload.ok) storeAuthToken(payload.token);
    return payload;
  } catch {
    return { ok: false, error: "无法连接服务器，请稍后再试。" };
  }
}

export function registerAccount(
  username: string,
  password: string,
  displayName?: string,
  inviteCode?: string
): Promise<AuthResponse> {
  return postAuth("/auth/register", { username, password, displayName, inviteCode });
}

export function loginAccount(username: string, password: string): Promise<AuthResponse> {
  return postAuth("/auth/login", { username, password });
}

export async function logoutAccount(): Promise<void> {
  const token = authToken();
  storeAuthToken("");
  if (!token) return;
  try {
    await fetch("/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ token })
    });
  } catch {
    /* the local token is already dropped; server session expires on its own */
  }
}

/** Self-service password change; the relay revokes the user's OTHER sessions. */
export async function changePasswordAccount(
  currentPassword: string,
  newPassword: string
): Promise<{ ok: boolean; error?: string }> {
  const token = authToken();
  if (!token) return { ok: false, error: "未登录或会话已过期。" };
  try {
    const response = await fetch("/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    return (await response.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: "无法连接服务器，请稍后再试。" };
  }
}

export type InviteInfo = { code: string; createdAt: number; expiresAt: number; createdBy: string };
export type AdminOverview = { users: AuthUser[]; invites: InviteInfo[] };

function adminHeaders(): Record<string, string> {
  const token = authToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Users + outstanding invites; admin only (null on any failure). */
export async function fetchAdminOverview(): Promise<AdminOverview | null> {
  try {
    const response = await fetch("/auth/admin/overview", { headers: adminHeaders() });
    if (!response.ok) return null;
    const payload = (await response.json()) as { ok: boolean } & AdminOverview;
    return payload.ok ? { users: payload.users, invites: payload.invites } : null;
  } catch {
    return null;
  }
}

/** Creates a single-use registration invite; admin only. */
export async function createInviteLink(): Promise<InviteInfo | null> {
  try {
    const response = await fetch("/auth/admin/invites", { method: "POST", headers: adminHeaders() });
    if (!response.ok) return null;
    const payload = (await response.json()) as { ok: boolean; invite?: InviteInfo };
    return payload.ok && payload.invite ? payload.invite : null;
  } catch {
    return null;
  }
}

export async function revokeInviteLink(code: string): Promise<boolean> {
  try {
    const response = await fetch("/auth/admin/invites/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ code })
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function deleteUserAccount(username: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch("/auth/admin/users/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ username })
    });
    return (await response.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: "无法连接服务器。" };
  }
}

export async function updateUserRole(
  username: string,
  role: AuthUser["role"]
): Promise<{ ok: boolean; error?: string; user?: AuthUser }> {
  try {
    const response = await fetch("/auth/admin/users/role", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ username, role })
    });
    return (await response.json()) as { ok: boolean; error?: string; user?: AuthUser };
  } catch {
    return { ok: false, error: "无法连接服务器。" };
  }
}

export type AdminAccountApi = {
  fetchOverview: () => Promise<ApiResult<AdminOverview>>;
  createInvite: () => Promise<ApiResult<InviteInfo>>;
  revokeInvite: (code: string) => Promise<ApiResult<{ removed: boolean }>>;
  deleteUser: (username: string) => Promise<ApiResult<AuthUser>>;
  updateRole: (username: string, role: AuthUser["role"]) => Promise<ApiResult<AuthUser>>;
};

async function fetchOverview(): Promise<ApiResult<AdminOverview>> {
  const result = await requestJson<{ ok: true } & AdminOverview>("/auth/admin/overview", { headers: adminHeaders() });
  return result.ok ? { ok: true, data: { users: result.data.users, invites: result.data.invites } } : result;
}

async function createInvite(): Promise<ApiResult<InviteInfo>> {
  const result = await requestJson<{ ok: true; invite: InviteInfo }>("/auth/admin/invites", {
    method: "POST",
    headers: adminHeaders()
  });
  return result.ok ? { ok: true, data: result.data.invite } : result;
}

async function revokeInvite(code: string): Promise<ApiResult<{ removed: boolean }>> {
  const result = await requestJson<{ ok: true; removed: boolean }>("/auth/admin/invites/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ code })
  });
  return result.ok ? { ok: true, data: { removed: result.data.removed } } : result;
}

async function deleteUser(username: string): Promise<ApiResult<AuthUser>> {
  const result = await requestJson<{ ok: true; user: AuthUser }>("/auth/admin/users/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ username })
  });
  return result.ok ? { ok: true, data: result.data.user } : result;
}

async function updateRole(username: string, role: AuthUser["role"]): Promise<ApiResult<AuthUser>> {
  const result = await requestJson<{ ok: true; user: AuthUser }>("/auth/admin/users/role", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ username, role })
  });
  return result.ok ? { ok: true, data: result.data.user } : result;
}

export const adminAccountApi: AdminAccountApi = {
  fetchOverview,
  createInvite,
  revokeInvite,
  deleteUser,
  updateRole
};

/** The full invite URL a new tester opens to register. */
export function inviteUrl(code: string): string {
  return `${window.location.origin}/?invite=${encodeURIComponent(code)}`;
}

/**
 * Revalidates the stored login without confusing a temporary network/server
 * failure with an expired session. Only an explicit 401 clears the token;
 * callers can keep an already-unlocked HUD intact while the relay recovers.
 */
export async function fetchCurrentUser(): Promise<CurrentUserResult> {
  const token = authToken();
  if (!token) return { status: "unauthenticated" };
  try {
    const response = await fetch("/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      if (response.status === 401) {
        storeAuthToken("");
        return { status: "unauthenticated" };
      }
      return { status: "unavailable" };
    }
    const payload = (await response.json()) as { ok: boolean; user?: AuthUser };
    return payload.ok && payload.user ? { status: "authenticated", user: payload.user } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

/** Returns metadata only; raw remembered transcripts never leave the relay. */
export async function fetchUserMemorySummary(): Promise<UserMemorySummary | null> {
  const token = authToken();
  if (!token) return null;
  try {
    const response = await fetch("/auth/memory", { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return null;
    const payload = (await response.json()) as { ok?: boolean; memory?: UserMemorySummary };
    return payload.ok && payload.memory ? payload.memory : null;
  } catch {
    return null;
  }
}

export async function forgetUserMemory(): Promise<boolean> {
  const token = authToken();
  if (!token) return false;
  try {
    const response = await fetch("/auth/memory", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { ok?: boolean };
    return payload.ok === true;
  } catch {
    return false;
  }
}
