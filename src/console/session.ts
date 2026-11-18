// The customer's bearer token, kept in localStorage. Storage can be blocked
// (private windows), so every access is guarded.

const TOKEN_KEY = "max.cloud.token.v1";

export function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function storeToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* the session just won't survive a reload */
  }
}

/** Copies text; resolves false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
