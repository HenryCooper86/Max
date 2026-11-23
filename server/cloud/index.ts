// Max Cloud: customer accounts, projects and prepaid top-ups for hosted voice
// agents (docs/superpowers/specs/2026-11-18-max-cloud-design.md). This is the
// surface the relay uses; nothing here runs unless CLOUD_SECRET_KEY is set.

import type { ProjectStudio } from "../../shared/cloud-studio";
import { createLogger } from "../logger";
import type { CloudProjectGrant } from "../session-tokens";
import { cloudEnabled, cloudSecretKey, cloudSecretKeys } from "./context";
import { projectStudio, projectTracesHeaders, projectWebhookSecret } from "./customers";
import { draftRevisionProject } from "./revisions";
import { decryptModelKey, hashToken } from "./secrets";
import { liveProject, liveProjectByKeyHash, readStudioLiveRevision } from "./store";

export { studioActivation } from "./store";
export { cloudEnabled } from "./context";
export { registerCloudPaymentRoutes, registerCloudRoutes, registerEmbedRoutes } from "./routes";
export { conversationRecorder, pruneOldConversations } from "./conversations";
export { projectServerTools } from "./tools";
export { projectWebhooks } from "./conversation-webhook";
export { projectTraces } from "./traces";
export { cloudConversationEnded, settleConversationAnalyses } from "./conversation-end";
export {
  createInvite as createCloudInvite,
  listInvites as listCloudInvites,
  revokeInvite as revokeCloudInvite
} from "./customers";
export {
  chargeSession,
  cloudSessionAlive,
  cloudSessionEnded,
  cloudSessionStarted,
  recoverCloudSessions,
  remainingSeconds
} from "./booking";
export { cloudReadinessIssues, cloudReadinessWarnings, cloudUnreadableSecrets } from "./keyring";
export { CLOUD_CHECK_INTERVAL_MS, admitCloudSession, openCloudSession, projectLimitRefusal } from "./live";
export { spendEmbedTokens } from "./sessions";

const log = createLogger("cloud");

export type ProjectRuntime = {
  projectId: string;
  customerId: string;
  /** The project's name. */
  name: string;
  backend: "openai" | "gemini" | "grok";
  modelKey: string; // decrypted
  assistantName: string;
  instructions?: string;
  greeting?: string;
  studio: ProjectStudio;
  /** Signs the project's webhook tool calls. */
  webhookSecret?: string;
  /** The request headers of the project's trace collector, decrypted. */
  tracesHeaders?: string;
  /** They are saved but cannot be decrypted. */
  tracesHeadersUnreadable?: true;
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

/** What a session of this project runs with; undefined when the project is gone or has no model key. */
export function projectRuntime(projectId: string, grant?: CloudProjectGrant): ProjectRuntime | undefined {
  if (!cloudSecretKey() || typeof projectId !== "string") return undefined;
  if (grant && grant.projectId !== projectId) return undefined;
  const revision = grant?.source === "test" ? grant.testRevision : undefined;
  const liveRevision = grant?.source === "test" ? grant.testLiveRevision : undefined;
  const project =
    revision !== undefined && grant
      ? draftRevisionProject(grant.customerId, projectId, revision)
      : liveRevision !== undefined && grant
        ? readStudioLiveRevision(projectId, grant.customerId, liveRevision)
        : liveProject(projectId, grant?.customerId);
  if ((revision ?? liveRevision) !== undefined && project?.key_hash !== grant?.keyHash) return undefined;
  if (!project?.model_key_enc) return undefined;
  const modelKey = decryptModelKey(project.model_key_enc, cloudSecretKeys(), project.id);
  if (modelKey === undefined) {
    // The customer is only told to add a model key; the operator needs to know why.
    log.error(
      "a project's model key does not decrypt with CLOUD_SECRET_KEY or CLOUD_SECRET_KEY_PREVIOUS: was the key changed? See docs/cloud.md (Rotating CLOUD_SECRET_KEY)",
      { projectId: project.id }
    );
    return undefined;
  }
  const studio = projectStudio(project);
  // Only read for a project that traces: a project without a collector has no use for them.
  const tracesHeaders = studio.traces.endpoint ? projectTracesHeaders(project) : {};
  return {
    projectId: project.id,
    customerId: project.customer_id,
    name: project.name,
    backend: project.backend,
    modelKey,
    assistantName: project.assistant_name || "Assistant",
    ...(project.instructions ? { instructions: project.instructions } : {}),
    ...(project.greeting ? { greeting: project.greeting } : {}),
    studio,
    ...(project.webhook_secret_enc ? { webhookSecret: projectWebhookSecret(project) } : {}),
    ...(tracesHeaders.headers ? { tracesHeaders: tracesHeaders.headers } : {}),
    ...(tracesHeaders.unreadable ? { tracesHeadersUnreadable: true as const } : {})
  };
}
