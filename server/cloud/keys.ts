// The project a Max Cloud project API key (`mpk_…`) is the key of: what the
// routes that take the key (server/cloud/sessions.ts, server/cloud/usage.ts
// and the relay's GET /v1/usage) start from.

import { cloudEnabled } from "./context";
import { hashToken } from "./secrets";
import { liveProjectByKeyHash } from "./store";

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
