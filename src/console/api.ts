// Typed client for the Max Cloud JSON API (/cloud/api). Every function takes
// the bearer token (when the endpoint needs one) and an optional fetch, so
// tests can inject both.

export type Backend = "openai" | "gemini" | "grok";
export type Provider = "wechat" | "alipay" | "test";

export type Customer = { id: string; email: string; createdAt: number };
type Balance = { fen: number; freeSecondsLeft: number; month: string };
export type Me = { customer: Customer; balance: Balance };
export type Project = {
  id: string;
  name: string;
  keyPrefix: string;
  backend: Backend;
  hasModelKey: boolean;
  assistantName: string;
  instructions: string;
  greeting: string;
  createdAt: number;
};
export type ProjectPatch = Partial<{
  name: string;
  backend: Backend;
  modelKey: string;
  assistantName: string;
  instructions: string;
  greeting: string;
}>;
export type Usage = {
  month: string;
  seconds: number;
  minutes: number;
  freeSecondsUsed: number;
  chargedFen: number;
  projects: { projectId: string; name: string; seconds: number; chargedFen: number }[];
};
export type LedgerEntry = {
  id: number;
  kind: "topup" | "usage" | "adjust";
  amountFen: number;
  seconds: number;
  projectId?: string;
  ref?: string;
  createdAt: number;
};
export type Pack = { id: string; fen: number };
export type Packs = { packs: Pack[]; providers: Provider[] };
export type TopupOrder = { orderId: string; provider: Provider; amountFen: number; qrCode: string; expiresAt: number };
export type OrderStatus = "pending" | "paid" | "closed";

export type ApiErrorKind = "unauthorized" | "unavailable" | "request" | "network";

/** `unauthorized`: 401 (sign in again). `unavailable`: 503 (Cloud is off). */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status = 0
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const BASE = "/cloud/api";

async function call<T>(
  fetcher: FetchLike | undefined,
  token: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await (fetcher ?? ((input, init) => fetch(input, init)))(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError("network", "Could not reach Max Cloud. Check your connection and try again.");
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (response.ok) return data as T;
  const message =
    data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error
      : `Request failed (${response.status})`;
  const kind: ApiErrorKind =
    response.status === 401 ? "unauthorized" : response.status === 503 ? "unavailable" : "request";
  throw new ApiError(kind, message, response.status);
}

export function createCloudApi(fetcher?: FetchLike) {
  const get = <T>(token: string | null, path: string) => call<T>(fetcher, token, "GET", path);
  const send = <T>(token: string | null, method: string, path: string, body?: unknown) =>
    call<T>(fetcher, token, method, path, body);
  const id = encodeURIComponent;
  return {
    signup: (email: string, password: string, invite: string) =>
      send<{ token: string; customer: Customer }>(null, "POST", "/signup", { email, password, invite }),
    login: (email: string, password: string) =>
      send<{ token: string; customer: Customer }>(null, "POST", "/login", { email, password }),
    logout: (token: string) => send<{ ok: true }>(token, "POST", "/logout"),
    me: (token: string) => get<Me>(token, "/me"),
    listProjects: (token: string) => get<{ projects: Project[] }>(token, "/projects"),
    createProject: (token: string, name: string) =>
      send<{ project: Project; apiKey: string }>(token, "POST", "/projects", { name }),
    updateProject: (token: string, projectId: string, patch: ProjectPatch) =>
      send<{ project: Project }>(token, "PATCH", `/projects/${id(projectId)}`, patch),
    rotateKey: (token: string, projectId: string) =>
      send<{ project: Project; apiKey: string }>(token, "POST", `/projects/${id(projectId)}/rotate-key`),
    deleteProject: (token: string, projectId: string) =>
      send<{ ok: true }>(token, "DELETE", `/projects/${id(projectId)}`),
    usage: (token: string, month?: string) =>
      get<Usage>(token, month ? `/usage?month=${encodeURIComponent(month)}` : "/usage"),
    ledger: (token: string) => get<{ entries: LedgerEntry[] }>(token, "/ledger"),
    packs: (token: string | null) => get<Packs>(token, "/packs"),
    createTopup: (token: string, pack: string, provider: Provider) =>
      send<TopupOrder>(token, "POST", "/topups", { pack, provider }),
    topupStatus: (token: string, orderId: string) => get<{ status: OrderStatus }>(token, `/topups/${id(orderId)}`)
  };
}

export type CloudApi = ReturnType<typeof createCloudApi>;
