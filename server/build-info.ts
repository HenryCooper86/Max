// Relay build identity for release comparison. Its own module (not config.ts)
// so metrics.ts can use it without an import cycle: config.ts already imports
// metrics.ts.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Priority: GIT_COMMIT env → build-info.json (stamped by
 *  deploy-lightsail.command; the deploy rsync excludes .git, so the server box
 *  cannot ask git itself) → local git → "local" for a plain dev checkout. */
function resolveBuildInfo(): { appVersion: string; gitCommit: string } {
  const appVersion = process.env.npm_package_version || "0.1.0";
  const fromEnv = process.env.GIT_COMMIT?.trim();
  if (fromEnv) return { appVersion, gitCommit: fromEnv.slice(0, 80) };
  try {
    const parsed = JSON.parse(readFileSync(new URL("../build-info.json", import.meta.url), "utf8")) as {
      gitCommit?: unknown;
    };
    if (typeof parsed.gitCommit === "string" && parsed.gitCommit.trim()) {
      return { appVersion, gitCommit: parsed.gitCommit.trim().slice(0, 80) };
    }
  } catch {
    /* no stamped build info — fall through */
  }
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (sha) return { appVersion, gitCommit: sha };
  } catch {
    /* not a git checkout */
  }
  return { appVersion, gitCommit: "local" };
}

export const buildInfo = resolveBuildInfo();
