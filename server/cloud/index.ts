// Max Cloud: customer accounts, projects and prepaid top-ups for hosted voice
// agents (docs/superpowers/specs/2026-11-18-max-cloud-design.md). This is the
// surface the relay uses; nothing here runs unless CLOUD_SECRET_KEY is set.

import { createLogger } from "../logger";
import { bookedSeconds, secondsForFen } from "./billing";
import { cloudEnabled, cloudSecretKey, now } from "./context";
import { decryptModelKey, hashToken } from "./secrets";
import { bookUsage, customerExists, customerFunds, liveProject, liveProjectByKeyHash } from "./store";

export { cloudEnabled } from "./context";
export { registerCloudPaymentRoutes, registerCloudRoutes } from "./routes";

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
};

/** The project a project API key belongs to (live projects only). */
export function projectForApiKey(apiKey: string): { projectId: string; customerId: string } | undefined {
  if (!cloudEnabled() || typeof apiKey !== "string" || !apiKey.startsWith("mpk_") || apiKey.length > 100) {
    return undefined;
  }
  const project = liveProjectByKeyHash(hashToken(apiKey));
  return project ? { projectId: project.id, customerId: project.customer_id } : undefined;
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
    ...(project.greeting ? { greeting: project.greeting } : {})
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
