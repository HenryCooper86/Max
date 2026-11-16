import { readStoredLanguage } from "./i18n";

type ApiErrorKind = "unauthorized" | "forbidden" | "not-found" | "conflict" | "invalid" | "server" | "unavailable";

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
  const language = readStoredLanguage();
  const english = language === "en-US";
  const controller = new AbortController();
  const abort = () => controller.abort();
  const callerSignal = init?.signal;
  if (callerSignal?.aborted) abort();
  else callerSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 15_000);
  try {
    // The relay answers in the app's language, not the browser's.
    const given = init?.headers;
    let headers: HeadersInit;
    if (given instanceof Headers || Array.isArray(given)) {
      const merged = new Headers(given);
      if (!merged.has("Accept-Language")) merged.set("Accept-Language", language);
      headers = merged;
    } else {
      headers = { "Accept-Language": language, ...given };
    }
    const response = await fetch(path, { ...init, headers, signal: controller.signal });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      payload = null;
    }
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : english
            ? `The request failed (HTTP ${response.status}).`
            : `请求失败（HTTP ${response.status}）。`;
      return { ok: false, error: { kind: errorKind(response.status), status: response.status, message } };
    }
    if (payload === null) {
      return {
        ok: false,
        error: {
          kind: "server",
          status: response.status,
          message: english
            ? "The relay returned invalid data. Please try again later."
            : "中继返回了无效的数据，请稍后重试。"
        }
      };
    }
    return { ok: true, data: payload as T };
  } catch {
    return {
      ok: false,
      error: {
        kind: "unavailable",
        message: english ? "Could not reach the relay. Please try again later." : "无法连接中继，请稍后重试。"
      }
    };
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abort);
  }
}
