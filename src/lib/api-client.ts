export type ApiErrorKind =
  "unauthorized" | "forbidden" | "not-found" | "conflict" | "invalid" | "server" | "unavailable";

export type ApiError = { kind: ApiErrorKind; message: string; status?: number };
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

function errorKind(status: number): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status >= 400 && status < 500) return "invalid";
  return "server";
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, init);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `请求失败（HTTP ${response.status}）。`;
      return { ok: false, error: { kind: errorKind(response.status), status: response.status, message } };
    }
    return { ok: true, data: payload as T };
  } catch {
    return { ok: false, error: { kind: "unavailable", message: "无法连接中继，请稍后重试。" } };
  }
}
