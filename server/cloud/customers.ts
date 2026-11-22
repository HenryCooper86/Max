// Max Cloud customers and their projects. Customers are a separate world from
// the relay's staff accounts (server/accounts.ts): own table, own `mcs_`
// tokens, never accepted by the staff gates and vice versa.

import { randomBytes } from "node:crypto";
import { DEFAULT_STUDIO, parseStudio, type ProjectStudio } from "../../shared/cloud-studio";
import { createLogger } from "../logger";
import { analysisUsesProjectKey } from "./analysis";
import { cloudSecretKey, cloudSecretKeys, now } from "./context";
import {
  customerByEmail,
  deleteOpenInvite,
  deleteSession,
  insertCustomer,
  insertCustomerWithInvite,
  insertInvite,
  openInvites,
  insertProject,
  insertSession,
  liveProject,
  liveProjects,
  deleteProjectConversations,
  replaceProjectKey,
  sessionCustomer,
  softDeleteProject,
  updateProject,
  type Backend,
  type CustomerRow,
  type InviteRow,
  type ProjectChanges,
  type ProjectRow
} from "./store";
import { checkedProjectFlow } from "./flow";
import {
  decryptModelKey,
  encryptModelKey,
  hashPassword,
  hashToken,
  newId,
  newPasswordSalt,
  newToken,
  passwordHashesMatch
} from "./secrets";

const log = createLogger("cloud");

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export type PublicCustomer = { id: string; email: string; createdAt: number };
export type PublicProject = {
  id: string;
  name: string;
  keyPrefix: string;
  backend: Backend;
  hasModelKey: boolean;
  assistantName: string;
  instructions: string;
  greeting: string;
  studio: ProjectStudio;
  /** Id for embedding without a backend; the console shows it in the snippet. */
  publicId: string;
  /** True once a webhook signing secret exists (it is made with the first tool). */
  hasWebhookSecret: boolean;
  /** The owner's limit on this project's minutes per calendar month (UTC); null for none. */
  monthlyMinutesCap: number | null;
  /** Whether conversation analysis runs with the project's own model key, and not on a model the operator named. */
  analysisOnOwnKey: boolean;
  createdAt: number;
};

const SESSION_LIFETIME_MS = 30 * 86_400_000;
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;
const MAX_PROJECTS = 20;
const LIMITS = { name: 60, assistantName: 24, instructions: 8000, greeting: 300, modelKey: 400 } as const;
/** A month has at most 44,640 minutes; five sessions at once use five times that. */
const MAX_MONTHLY_MINUTES_CAP = 250_000;
const BACKENDS: readonly Backend[] = ["openai", "gemini", "grok"];
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const WRONG_LOGIN = "Wrong email or password";
// Hashed when the email is unknown, so a login takes as long whether or not the account exists.
const DECOY_SALT = newPasswordSalt();

const fail = (status: number, error: string) => ({ ok: false, status, error }) as const;

function hasControlCharacter(value: string, allowNewlines = false): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (allowNewlines && (character === "\n" || character === "\r" || character === "\t")) continue;
    if (code < 32 || (code >= 127 && code < 160)) return true;
  }
  return false;
}

function normalizeEmail(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const email = input.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || hasControlCharacter(email) || !EMAIL_SHAPE.test(email)) {
    return undefined;
  }
  return email;
}

function validPassword(input: unknown): input is string {
  return typeof input === "string" && input.length >= MIN_PASSWORD_LENGTH && input.length <= MAX_PASSWORD_LENGTH;
}

export function publicCustomer(row: CustomerRow): PublicCustomer {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

function startSession(customer: CustomerRow): { token: string; customer: PublicCustomer } {
  const at = now();
  const token = newToken("mcs_");
  insertSession(hashToken(token), customer.id, at + SESSION_LIFETIME_MS, at);
  return { token, customer: publicCustomer(customer) };
}

const INVITE_CODE = /^cinv_[0-9a-f]{32}$/;
const INVITE_LIFETIME_MS = 7 * 86_400_000;
const INVALID_INVITE = "This invitation is not valid: it may have been used or have expired. Ask for a new one.";

/** True when anyone may sign up without an invitation (CLOUD_SIGNUP=open). */
function openSignup(): boolean {
  return process.env.CLOUD_SIGNUP?.trim().toLowerCase() === "open";
}

/** A new single-use invitation, valid for 7 days. */
export function createInvite(createdBy: string, noteInput: unknown): InviteRow {
  const at = now();
  const row: InviteRow = {
    code: `cinv_${randomBytes(16).toString("hex")}`,
    note:
      typeof noteInput === "string"
        ? [...noteInput]
            .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
            .join("")
            .trim()
            .slice(0, 120)
        : "",
    created_by: createdBy.slice(0, 80),
    created_at: at,
    expires_at: at + INVITE_LIFETIME_MS,
    used_by: null,
    used_at: null
  };
  insertInvite(row);
  log.info("cloud invite created", { by: row.created_by, code: `${row.code.slice(0, 10)}…` });
  return row;
}

export function listInvites(): InviteRow[] {
  return openInvites(now());
}

export function revokeInvite(code: unknown): boolean {
  return typeof code === "string" && INVITE_CODE.test(code.trim()) ? deleteOpenInvite(code.trim()) : false;
}

export async function signup(
  emailInput: unknown,
  passwordInput: unknown,
  inviteInput?: unknown
): Promise<Result<{ token: string; customer: PublicCustomer }>> {
  const invite = typeof inviteInput === "string" ? inviteInput.trim() : "";
  if (!openSignup() && !INVITE_CODE.test(invite)) {
    return fail(403, "Max Cloud is invitation-only. Use the invitation link you were sent, or ask for one.");
  }
  const email = normalizeEmail(emailInput);
  if (!email) return fail(400, "Enter a valid email address.");
  if (!validPassword(passwordInput)) {
    return fail(400, `Use a password of ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`);
  }
  const salt = newPasswordSalt();
  const row: CustomerRow = {
    id: newId("cus_"),
    email,
    password_hash: await hashPassword(passwordInput, salt),
    password_salt: salt,
    created_at: now()
  };
  if (openSignup() && !INVITE_CODE.test(invite)) {
    if (!insertCustomer(row)) return fail(409, "This email cannot be used to sign up. If it is yours, log in.");
  } else {
    const outcome = insertCustomerWithInvite(row, invite, row.created_at);
    if (outcome === "invalid-invite") return fail(403, INVALID_INVITE);
    if (outcome === "email-taken") return fail(409, "This email cannot be used to sign up. If it is yours, log in.");
  }
  log.info("customer signed up", { customerId: row.id });
  return { ok: true, value: startSession(row) };
}

export async function login(
  emailInput: unknown,
  passwordInput: unknown
): Promise<Result<{ token: string; customer: PublicCustomer }>> {
  const email = normalizeEmail(emailInput);
  const password = typeof passwordInput === "string" ? passwordInput.slice(0, MAX_PASSWORD_LENGTH + 1) : "";
  const customer = email ? customerByEmail(email) : undefined;
  const hash = await hashPassword(password, customer?.password_salt ?? DECOY_SALT);
  if (!customer || !validPassword(passwordInput) || !passwordHashesMatch(hash, customer.password_hash)) {
    return fail(401, WRONG_LOGIN);
  }
  return { ok: true, value: startSession(customer) };
}

/** The customer behind an `mcs_` token, if it is live. */
export function customerForToken(token: string): CustomerRow | undefined {
  if (!token.startsWith("mcs_") || token.length > 100) return undefined;
  return sessionCustomer(hashToken(token), now());
}

export function logout(token: string): void {
  deleteSession(hashToken(token));
}

// --- projects -------------------------------------------------------------------

/**
 * Whether a project's stored settings can still be read as they were saved.
 * False after a release that no longer takes something in them: reading them
 * then gives the defaults, and writing those back would lose the rest.
 */
export function projectStudioReadable(row: Pick<ProjectRow, "studio" | "backend">): boolean {
  try {
    return parseStudio(JSON.parse(row.studio || "{}"), row.backend).value !== undefined;
  } catch {
    return false;
  }
}

/** A project's stored Studio settings; defaults when the stored JSON is missing or no longer valid. */
export function projectStudio(row: Pick<ProjectRow, "studio" | "backend">): ProjectStudio {
  let raw: unknown;
  try {
    raw = JSON.parse(row.studio || "{}");
  } catch {
    raw = {};
  }
  const parsed = parseStudio(raw, row.backend);
  return parsed.value ?? structuredClone(DEFAULT_STUDIO);
}

function publicProject(row: ProjectRow): PublicProject {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    backend: row.backend,
    hasModelKey: Boolean(row.model_key_enc),
    assistantName: row.assistant_name,
    instructions: row.instructions,
    greeting: row.greeting,
    studio: projectStudio(row),
    publicId: row.public_id ?? "",
    hasWebhookSecret: Boolean(row.webhook_secret_enc),
    monthlyMinutesCap: row.monthly_minutes_cap ?? null,
    analysisOnOwnKey: analysisUsesProjectKey(),
    createdAt: row.created_at
  };
}

const newPublicId = () => `pub_${randomBytes(12).toString("hex")}`;
/** What a project's webhook secret is bound to, so it cannot be swapped with its model key. */
export const webhookSecretScope = (projectId: string) => `${projectId}#webhook-secret`;

/** The project's webhook signing secret, decrypted; undefined when it has none. */
export function projectWebhookSecret(row: Pick<ProjectRow, "id" | "webhook_secret_enc">): string | undefined {
  if (!cloudSecretKey() || !row.webhook_secret_enc) return undefined;
  return decryptModelKey(row.webhook_secret_enc, cloudSecretKeys(), webhookSecretScope(row.id));
}

/** Whatever Max sends a project's own server is signed: its tool calls and its conversations. */
const needsSigningSecret = (studio: ProjectStudio): boolean =>
  studio.tools.length > 0 || Boolean(studio.conversationWebhook);

function newWebhookSecret(projectId: string): string | undefined {
  const secret = cloudSecretKey();
  if (!secret) return undefined;
  return encryptModelKey(`whsec_${randomBytes(24).toString("base64url")}`, secret, webhookSecretScope(projectId));
}

function newApiKey(): { apiKey: string; keyHash: string; keyPrefix: string } {
  const apiKey = newToken("mpk_");
  return { apiKey, keyHash: hashToken(apiKey), keyPrefix: apiKey.slice(0, 8) };
}

type TextRule = { field: string; max: number; multiline?: boolean; required?: boolean };

/** A trimmed text field, undefined when absent, or an error message. */
function textField(value: unknown, rule: TextRule): { value?: string; error?: string } {
  if (value === undefined) return rule.required ? { error: `${rule.field} is required.` } : {};
  if (typeof value !== "string") return { error: `${rule.field} must be text.` };
  const text = value.trim();
  if (rule.required && !text) return { error: `${rule.field} is required.` };
  if (text.length > rule.max) return { error: `${rule.field} must be at most ${rule.max} characters.` };
  if (hasControlCharacter(text, rule.multiline)) return { error: `${rule.field} contains characters it cannot have.` };
  return { value: text };
}

export function listProjects(customerId: string): PublicProject[] {
  return liveProjects(customerId).map(publicProject);
}

export function createProject(
  customerId: string,
  body: Record<string, unknown>
): Result<{ project: PublicProject; apiKey: string }> {
  const name = textField(body.name, { field: "Name", max: LIMITS.name, required: true });
  if (name.error || name.value === undefined) return fail(400, name.error ?? "Name is required.");
  // A template fills the rest; each field is checked as an edit would be.
  const starters = {
    assistantName: textField(body.assistantName, { field: "Assistant name", max: LIMITS.assistantName }),
    instructions: textField(body.instructions, { field: "Instructions", max: LIMITS.instructions, multiline: true }),
    greeting: textField(body.greeting, { field: "Greeting", max: LIMITS.greeting, multiline: true })
  };
  for (const starter of Object.values(starters)) if (starter.error) return fail(400, starter.error);
  // New projects keep conversations unless asked not to; the console says so where they are listed.
  const requested = body.studio && typeof body.studio === "object" ? (body.studio as Record<string, unknown>) : {};
  const studio = parseStudio({ ...requested, keepConversations: requested.keepConversations !== false }, "openai");
  if (studio.error !== undefined) return fail(400, studio.error);
  const startFlow = checkedProjectFlow(studio.value);
  if ("error" in startFlow) return fail(400, startFlow.error);
  studio.value.flow = startFlow.flow;
  const id = newId("prj_");
  const key = newApiKey();
  const row: ProjectRow = {
    id,
    customer_id: customerId,
    name: name.value,
    key_hash: key.keyHash,
    key_prefix: key.keyPrefix,
    backend: "openai",
    model_key_enc: null,
    assistant_name: starters.assistantName.value ?? "",
    instructions: starters.instructions.value ?? "",
    greeting: starters.greeting.value ?? "",
    studio: JSON.stringify(studio.value),
    public_id: newPublicId(),
    webhook_secret_enc: needsSigningSecret(studio.value) ? (newWebhookSecret(id) ?? null) : null,
    monthly_minutes_cap: null,
    created_at: now(),
    deleted_at: null
  };
  if (!insertProject(row, MAX_PROJECTS)) return fail(409, `You can have at most ${MAX_PROJECTS} projects.`);
  return { ok: true, value: { project: publicProject(row), apiKey: key.apiKey } };
}

export function patchProject(
  customerId: string,
  projectId: string,
  body: Record<string, unknown>
): Result<{ project: PublicProject }> {
  const current = liveProject(projectId, customerId);
  if (!current) return fail(404, "Project not found.");
  const changes: ProjectChanges = {};
  const fields = [
    ["name", { field: "Name", max: LIMITS.name, required: body.name !== undefined }],
    ["assistant_name", { field: "Assistant name", max: LIMITS.assistantName }],
    ["instructions", { field: "Instructions", max: LIMITS.instructions, multiline: true }],
    ["greeting", { field: "Greeting", max: LIMITS.greeting, multiline: true }]
  ] as const;
  const inputs = {
    name: body.name,
    assistant_name: body.assistantName,
    instructions: body.instructions,
    greeting: body.greeting
  };
  for (const [column, rule] of fields) {
    const result = textField(inputs[column], rule);
    if (result.error) return fail(400, result.error);
    if (result.value !== undefined) changes[column] = result.value;
  }
  if (body.backend !== undefined) {
    if (!BACKENDS.includes(body.backend as Backend)) return fail(400, "Backend must be openai, gemini or grok.");
    changes.backend = body.backend as Backend;
  }
  const backend = changes.backend ?? current.backend;
  if (body.studio !== undefined || backend !== current.backend) {
    const sent = body.studio !== undefined ? body.studio : projectStudio(current);
    // A save of the settings that says nothing of the flow leaves the flow as it is: the flow has a save of
    // its own, and a Studio opened before that one must not put an older flow back, or none.
    // The same for the analysis settings: a client that does not know of them (an older console, a script
    // that sets one thing) must not switch a project's analysis off by saving something else.
    const stored = projectStudio(current);
    const record =
      sent && typeof sent === "object" && !Array.isArray(sent) ? (sent as Record<string, unknown>) : undefined;
    const raw = record
      ? {
          ...record,
          ...(record.flow === undefined ? { flow: stored.flow } : {}),
          ...(record.analysis === undefined ? { analysis: stored.analysis } : {})
        }
      : sent;
    let studio = parseStudio(raw, backend);
    // A voice belongs to one backend: after a backend change, fall back to the new one's default voice.
    if (studio.error !== undefined && backend !== current.backend && raw && typeof raw === "object") {
      studio = parseStudio({ ...(raw as object), voice: "" }, backend);
    }
    if (studio.error !== undefined) return fail(400, studio.error);
    // The flow goes by the tools as they are saved with it: a tool a step names cannot be taken away under it.
    const flow = checkedProjectFlow(studio.value);
    if ("error" in flow) return fail(400, flow.error);
    studio.value.flow = flow.flow;
    changes.studio = JSON.stringify(studio.value);
    const next = JSON.parse(changes.studio) as ProjectStudio;
    if (needsSigningSecret(next) && !current.webhook_secret_enc) {
      const secret = newWebhookSecret(projectId);
      if (!secret) return fail(503, "Max Cloud is not configured");
      changes.webhook_secret_enc = secret;
    }
    if (!current.public_id) changes.public_id = newPublicId();
  }
  if (body.monthlyMinutesCap !== undefined) {
    const cap = body.monthlyMinutesCap;
    if (cap === null || cap === "") {
      changes.monthly_minutes_cap = null;
    } else if (typeof cap === "number" && Number.isInteger(cap) && cap >= 1 && cap <= MAX_MONTHLY_MINUTES_CAP) {
      changes.monthly_minutes_cap = cap;
    } else {
      return fail(
        400,
        `Monthly minutes limit must be a whole number from 1 to ${MAX_MONTHLY_MINUTES_CAP.toLocaleString("en")}, or empty for none.`
      );
    }
  }
  if (body.modelKey !== undefined) {
    if (typeof body.modelKey !== "string") return fail(400, "Model key must be text.");
    const modelKey = body.modelKey.trim();
    if (modelKey.length > LIMITS.modelKey) return fail(400, `Model key must be at most ${LIMITS.modelKey} characters.`);
    if (/\s/.test(modelKey) || hasControlCharacter(modelKey))
      return fail(400, "Model key contains characters it cannot have.");
    if (!modelKey) {
      changes.model_key_enc = null;
    } else {
      const secret = cloudSecretKey();
      if (!secret) return fail(503, "Max Cloud is not configured");
      changes.model_key_enc = encryptModelKey(modelKey, secret, projectId);
    }
  }
  if (!updateProject(projectId, customerId, changes)) return fail(404, "Project not found.");
  const row = liveProject(projectId, customerId);
  if (!row) return fail(404, "Project not found.");
  return { ok: true, value: { project: publicProject(row) } };
}

export function rotateProjectKey(
  customerId: string,
  projectId: string
): Result<{ project: PublicProject; apiKey: string }> {
  const key = newApiKey();
  if (!replaceProjectKey(projectId, customerId, key.keyHash, key.keyPrefix)) return fail(404, "Project not found.");
  const row = liveProject(projectId, customerId);
  if (!row) return fail(404, "Project not found.");
  return { ok: true, value: { project: publicProject(row), apiKey: key.apiKey } };
}

export function deleteProject(customerId: string, projectId: string): Result<{ ok: true }> {
  if (!softDeleteProject(projectId, customerId, now())) return fail(404, "Project not found.");
  // Transcripts go with the project.
  deleteProjectConversations(projectId, customerId);
  return { ok: true, value: { ok: true } };
}

/** The project's webhook signing secret, for the person setting up their tool's server. */
export function revealWebhookSecret(customerId: string, projectId: string): Result<{ secret: string }> {
  const row = liveProject(projectId, customerId);
  if (!row) return fail(404, "Project not found.");
  const secret = projectWebhookSecret(row);
  if (!secret) return fail(404, "This project has no signing secret yet: add a tool or a conversation webhook first.");
  return { ok: true, value: { secret } };
}

/** Replaces the webhook signing secret; the old one stops verifying at once. */
export function rotateWebhookSecret(customerId: string, projectId: string): Result<{ secret: string }> {
  const row = liveProject(projectId, customerId);
  if (!row) return fail(404, "Project not found.");
  const encrypted = newWebhookSecret(projectId);
  if (!encrypted) return fail(503, "Max Cloud is not configured");
  if (!updateProject(projectId, customerId, { webhook_secret_enc: encrypted })) return fail(404, "Project not found.");
  return revealWebhookSecret(customerId, projectId);
}
