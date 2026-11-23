import type { InstallSignalKind } from "../../shared/studio-install";
import type { CloudProjectGrant } from "../session-tokens";
import { createLogger } from "../logger";
import { now } from "./context";
import { storeInstallSignal } from "./store";

const log = createLogger("cloud");
export function isWebsiteSession(grant: CloudProjectGrant, origin?: string) {
  return grant.source !== "test" && (grant.source === "embed" || /^https?:\/\//i.test(origin ?? ""));
}

export function observeInstall(projectId: string, kind: InstallSignalKind, at = now()) {
  try {
    storeInstallSignal(projectId, kind, at);
  } catch {
    log.warn("website install signal could not be recorded", { kind });
  }
}
