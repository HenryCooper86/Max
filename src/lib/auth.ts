// Client side of user accounts: session-token storage plus thin wrappers for
// the relay's /auth endpoints. The session token rides the same channels as
// the relay token (Bearer header for HTTP, ?token= for the WebSocket), so a
// logged-in tester needs no shared operator secret.

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "tester";
  createdAt: number;
  lastLoginAt: number;
};

export type AuthResponse = { ok: true; token: string; user: AuthUser } | { ok: false; error: string };

export type CurrentUserResult =
  | { status: "authenticated"; user: AuthUser }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

import { relayAuthToken } from "./persistence";

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
