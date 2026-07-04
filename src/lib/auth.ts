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
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = (await response.json()) as AuthResponse;
    if (payload.ok) storeAuthToken(payload.token);
    return payload;
  } catch {
    return { ok: false, error: "无法连接服务器，请稍后再试。" };
  }
}

export function registerAccount(username: string, password: string, displayName?: string): Promise<AuthResponse> {
  return postAuth("/auth/register", { username, password, displayName });
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

/** The logged-in user for the stored session token, or null (also on expiry). */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  const token = authToken();
  if (!token) return null;
  try {
    const response = await fetch("/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      if (response.status === 401) storeAuthToken("");
      return null;
    }
    const payload = (await response.json()) as { ok: boolean; user?: AuthUser };
    return payload.ok && payload.user ? payload.user : null;
  } catch {
    return null;
  }
}
