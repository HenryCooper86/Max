// Typed client for the Max Cloud JSON API (/cloud/api). Every function takes
// the bearer token (when the endpoint needs one) and an optional fetch, so
// tests can inject both.

import type { FlowStep } from "../lib/flow";
import type { AnalysisResult } from "../../shared/analysis";
import type { ProjectStudio } from "../../shared/cloud-studio";

export type { ProjectStudio } from "../../shared/cloud-studio";
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
  /** Whether request headers for the project's trace collector are saved; their value is never sent back. */
  hasTracesHeaders?: boolean;
  assistantName: string;
  instructions: string;
  greeting: string;
  studio: ProjectStudio;
  /** Public agent id for embedding without a backend. */
  publicId: string;
  hasWebhookSecret: boolean;
  /** The owner's limit on this project's minutes per month; null (or absent, from an older relay) for none. */
  monthlyMinutesCap?: number | null;
  /** False when conversation analysis runs on a model the service's operator named, not with the project's key. */
  analysisOnOwnKey?: boolean;
  createdAt: number;
};
export type ProjectPatch = Partial<{
  name: string;
  backend: Backend;
  modelKey: string;
  /** The trace collector's request headers (`name=value,…`); "" removes them. Absent leaves them as they are. */
  tracesHeaders: string;
  assistantName: string;
  instructions: string;
  greeting: string;
  /** Without `flow`, the project's flow stays as it is. */
  studio: Omit<ProjectStudio, "flow"> & { flow?: ProjectStudio["flow"] };
  monthlyMinutesCap: number | null;
}>;
/** What a new project starts with (from a template). */
export type ProjectStart = { name: string } & Partial<{
  assistantName: string;
  instructions: string;
  greeting: string;
  studio: Partial<ProjectStudio>;
}>;
export type ConversationSummary = {
  id: string;
  startedAt: number;
  endedAt: number;
  seconds: number;
  source: "test" | "embed" | "api" | string;
  preview: string;
  /** How long the visitor waited for an answer to begin, in ms: the median over the conversation. */
  answerMs?: number;
  /** From the conversation's analysis, when it has one. */
  sentiment?: AnalysisResult["sentiment"];
  success?: boolean;
};
/** What the project's analysis made of a conversation, or why it made nothing. */
export type ConversationAnalysis = { at: number; result?: AnalysisResult; error?: string };
export type ConversationTurn = {
  at: number;
  speaker: "user" | "agent" | "tool";
  text: string;
  ok?: boolean;
  ms?: number;
  /** Agent turns: how long the visitor waited for this answer to begin, in ms. */
  answerMs?: number;
};
export type Conversation = ConversationSummary & {
  projectId: string;
  turns: ConversationTurn[];
  analysis?: ConversationAnalysis;
};
/** A project's flow as the flow builder edits it: the steps, the starting step first, and the tools a step can name. */
export type ProjectFlow = { ok: true; steps: FlowStep[]; tools: string[]; problems: string[] };
/** How the last delivery of a conversation to the project's server went. */
export type WebhookDelivery = { at: number; ok: boolean; attempts: number; status?: number; error?: string };
export type WebhookTestResult = { ok: boolean; status?: number; error?: string; ms: number };
export type TracesTestResult = { ok: true } | { ok: false; error: string };
export type ToolTestResult = { ok: true; result: unknown; ms: number } | { ok: false; error: string; ms: number };
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
    createProject: (token: string, start: ProjectStart) =>
      send<{ project: Project; apiKey: string }>(token, "POST", "/projects", start),
    updateProject: (token: string, projectId: string, patch: ProjectPatch) =>
      send<{ project: Project }>(token, "PATCH", `/projects/${id(projectId)}`, patch),
    rotateKey: (token: string, projectId: string) =>
      send<{ project: Project; apiKey: string }>(token, "POST", `/projects/${id(projectId)}/rotate-key`),
    deleteProject: (token: string, projectId: string) =>
      send<{ ok: true }>(token, "DELETE", `/projects/${id(projectId)}`),
    testSession: (token: string, projectId: string) =>
      send<{ token: string; expiresAt: number }>(token, "POST", `/projects/${id(projectId)}/test-session`),
    testTool: (token: string, projectId: string, name: string, args: Record<string, unknown>) =>
      send<ToolTestResult>(token, "POST", `/projects/${id(projectId)}/tools/test`, { name, arguments: args }),
    webhookSecret: (token: string, projectId: string) =>
      get<{ secret: string }>(token, `/projects/${id(projectId)}/webhook-secret`),
    rotateWebhookSecret: (token: string, projectId: string) =>
      send<{ secret: string }>(token, "POST", `/projects/${id(projectId)}/webhook-secret/rotate`),
    projectFlow: (token: string, projectId: string) => get<ProjectFlow>(token, `/projects/${id(projectId)}/flow`),
    saveProjectFlow: (token: string, projectId: string, steps: FlowStep[]) =>
      send<ProjectFlow & { project: Project }>(token, "PUT", `/projects/${id(projectId)}/flow`, { steps }),
    conversationWebhook: (token: string, projectId: string) =>
      get<{ url: string; last: WebhookDelivery | null }>(token, `/projects/${id(projectId)}/conversation-webhook`),
    testConversationWebhook: (token: string, projectId: string) =>
      send<WebhookTestResult>(token, "POST", `/projects/${id(projectId)}/conversation-webhook/test`),
    testTraces: (token: string, projectId: string) =>
      send<TracesTestResult>(token, "POST", `/projects/${id(projectId)}/traces-test`),
    conversations: (token: string, projectId: string) =>
      get<{ conversations: ConversationSummary[] }>(token, `/projects/${id(projectId)}/conversations`),
    conversation: (token: string, conversationId: string) =>
      get<{ conversation: Conversation }>(token, `/conversations/${id(conversationId)}`),
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
