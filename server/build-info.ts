// Relay build identity for release comparison. Its own module (not config.ts)
// so metrics.ts can use it without an import cycle: config.ts already imports
// metrics.ts.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type BuildInfo = { appVersion: string; gitCommit: string; deployedAt?: string };

function normalizeCommit(value: string): string {
  const clean = value.trim().slice(0, 80);
  return /^[0-9a-f]{7,40}$/i.test(clean) ? clean.slice(0, 12).toLowerCase() : clean;
}

/** Priority: GIT_COMMIT env → local git → build-info.json (stamped by
 *  deploy-lightsail.command). A checkout must not inherit a stale deploy
 *  stamp; the deployed bundle excludes .git and therefore falls through to
 *  its stamp. */
function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim().slice(0, 40);
  } catch {
    /* malformed/missing package metadata — use the emergency fallback */
  }
  return process.env.npm_package_version?.trim().slice(0, 40) || "unknown";
}

function deployedAt(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function resolveBuildInfo(): BuildInfo {
  const appVersion = packageVersion();
  const fromEnv = process.env.GIT_COMMIT?.trim();
  if (fromEnv) return { appVersion, gitCommit: normalizeCommit(fromEnv) };
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (sha) return { appVersion, gitCommit: normalizeCommit(sha) };
  } catch {
    /* not a git checkout — use the deploy stamp */
  }
  try {
    const parsed = JSON.parse(readFileSync(new URL("../build-info.json", import.meta.url), "utf8")) as {
      gitCommit?: unknown;
      deployedAt?: unknown;
    };
    if (typeof parsed.gitCommit === "string" && parsed.gitCommit.trim()) {
      const stampDeployedAt = deployedAt(parsed.deployedAt);
      return {
        appVersion,
        gitCommit: normalizeCommit(parsed.gitCommit),
        ...(stampDeployedAt ? { deployedAt: stampDeployedAt } : {})
      };
    }
  } catch {
    /* no stamped build info — fall through */
  }
  return { appVersion, gitCommit: "local" };
}

export const buildInfo = resolveBuildInfo();
