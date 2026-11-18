// Max Cloud: customer accounts, projects and prepaid top-ups for hosted voice
// agents (docs/superpowers/specs/2026-11-18-max-cloud-design.md). This is the
// surface the relay uses; nothing here runs unless CLOUD_SECRET_KEY is set.

import type { ProjectStudio } from "../../shared/cloud-studio";
import { createLogger } from "../logger";
import { bookedSeconds, secondsForFen } from "./billing";
import { cloudEnabled, cloudSecretKey, now } from "./context";
import { projectStudio, projectWebhookSecret } from "./customers";
import { decryptModelKey, hashToken } from "./secrets";
import {
  bookUsage,
  customerExists,
  customerFunds,
  endLiveSession,
  leftoverLiveSessions,
  liveProject,
  liveProjectByKeyHash,
  startLiveSession,
  touchLiveSession
} from "./store";

export { cloudEnabled } from "./context";
export { registerCloudPaymentRoutes, registerCloudRoutes, registerEmbedRoutes } from "./routes";
export { conversationRecorder, pruneOldConversations, saveConversation } from "./conversations";
export { projectServerTools } from "./tools";
export {
  createInvite as createCloudInvite,
  listInvites as listCloudInvites,
  revokeInvite as revokeCloudInvite
} from "./customers";

const log = createLogger("cloud");

const LATEST_DATE_MS = 8.64e15;

export type ProjectRuntime = {
  projectId: string;
  customerId: string;
  backend: "openai" | "gemini" | "grok";
  modelKey: string; // decrypted
  assistantName: string;
  instructions?: string;
  greeting?: string;
  studio: ProjectStudio;
  /** Signs the project's webhook tool calls. */
  webhookSecret?: string;
};

/** The project a project API key belongs to (live projects only), with the
 *  key's fingerprint: sessions keep it to notice a rotated or deleted key. */
export function projectForApiKey(
  apiKey: string
): { projectId: string; customerId: string; keyHash: string } | undefined {
  if (!cloudEnabled() || typeof apiKey !== "string" || !apiKey.startsWith("mpk_") || apiKey.length > 100) {
    return undefined;
  }
  const keyHash = hashToken(apiKey);
  const project = liveProjectByKeyHash(keyHash);
  return project ? { projectId: project.id, customerId: project.customer_id, keyHash } : undefined;
}

/** True while the project still exists and the key that minted a session's
 *  token is still its key (not rotated, not deleted). */
export function projectKeyValid(projectId: string, keyHash: string): boolean {
  if (!cloudEnabled()) return false;
  return liveProjectByKeyHash(keyHash)?.id === projectId;
}

/** A project session began: recorded so a crash cannot lose its charge. */
export function cloudSessionStarted(session: { sessionId: string; customerId: string; projectId: string }): void {
  try {
    startLiveSession({ ...session, at: now() });
  } catch (error) {
    log.warn("live session not recorded", { message: error instanceof Error ? error.message : String(error) });
  }
}

/** A project session is still running (checkpoint, every 15 s). */
export function cloudSessionAlive(sessionId: string): void {
  try {
    touchLiveSession(sessionId, now());
  } catch {
    /* the close or the next checkpoint records it */
  }
}

/** A project session ended: book it and forget the checkpoint. */
export function cloudSessionEnded(usage: {
  customerId: string;
  projectId: string;
  sessionId: string;
  seconds: number;
  endedAt: number;
}): void {
  chargeSession(usage);
  try {
    endLiveSession(usage.sessionId);
  } catch {
    /* booking is idempotent: a leftover row is booked again harmlessly at startup */
  }
}

/** Books every project session a crash or restart left open, up to its last
 *  checkpoint. Call once at startup. Returns how many were booked. */
export function recoverCloudSessions(): number {
  if (!cloudEnabled()) return 0;
  let booked = 0;
  for (const row of leftoverLiveSessions()) {
    cloudSessionEnded({
      customerId: row.customer_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      seconds: Math.max(0, (row.last_seen - row.started_at) / 1000),
      endedAt: row.last_seen
    });
    booked += 1;
  }
  if (booked) log.info("booked project sessions left open by the last run", { sessions: booked });
  return booked;
}

/** What a session of this project runs with; undefined when the project is gone or has no model key. */
export function projectRuntime(projectId: string): ProjectRuntime | undefined {
  const secret = cloudSecretKey();
  if (!secret || typeof projectId !== "string") return undefined;
  const project = liveProject(projectId);
  if (!project?.model_key_enc) return undefined;
  const modelKey = decryptModelKey(project.model_key_enc, secret, project.id);
  if (modelKey === undefined) {
    log.warn("a project's model key does not decrypt (CLOUD_SECRET_KEY changed?)", { projectId: project.id });
    return undefined;
  }
  return {
    projectId: project.id,
    customerId: project.customer_id,
    backend: project.backend,
    modelKey,
    assistantName: project.assistant_name || "Assistant",
    ...(project.instructions ? { instructions: project.instructions } : {}),
    ...(project.greeting ? { greeting: project.greeting } : {}),
    studio: projectStudio(project),
    ...(project.webhook_secret_enc ? { webhookSecret: projectWebhookSecret(project) } : {})
  };
}

/** Seconds this customer can still talk: free seconds left this month + balance converted at 15 fen/min. */
export function remainingSeconds(customerId: string, at?: number): number {
  if (typeof customerId !== "string" || !customerExists(customerId)) return 0;
  const funds = customerFunds(customerId, at ?? now());
  return funds.freeSecondsLeft + secondsForFen(funds.fen);
}

/** Books one finished session (idempotent on sessionId). */
export function chargeSession(usage: {
  customerId: string;
  projectId: string;
  sessionId: string;
  seconds: number;
  endedAt: number;
}): void {
  const { customerId, projectId, sessionId } = usage;
  if (![customerId, projectId, sessionId].every((value) => typeof value === "string" && value.length > 0)) {
    log.warn("session not booked: missing customer, project or session id");
    return;
  }
  const endedAt =
    Number.isFinite(usage.endedAt) && usage.endedAt > 0 && usage.endedAt < LATEST_DATE_MS ? usage.endedAt : now();
  const seconds = bookedSeconds(usage.seconds);
  try {
    if (!bookUsage({ customerId, projectId, sessionId, seconds, endedAt, at: now() })) {
      log.debug("session already booked", { sessionId });
    }
  } catch (error) {
    // Called when a voice connection closes: a failure must not take the relay
    // down, but it is logged with everything needed to book it by hand.
    log.error("session not booked", {
      customerId,
      projectId,
      sessionId,
      seconds,
      endedAt,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
