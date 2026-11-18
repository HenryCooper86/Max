import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

function normalizeCommit(value: string): string {
  const clean = value.trim().slice(0, 80);
  return /^[0-9a-f]{7,40}$/i.test(clean) ? clean.slice(0, 12).toLowerCase() : clean;
}

function resolveAppVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim().slice(0, 40);
  } catch {
    /* use a visible fallback rather than silently claiming an old version */
  }
  return "unknown";
}

// Same resolution chain as server/build-info.ts: GIT_COMMIT env → local git →
// build-info.json. A checkout ignores stale deploy stamps; the deployed bundle
// excludes .git and falls through to its stamp.
function resolveGitCommit(): string {
  const fromEnv = process.env.GIT_COMMIT?.trim();
  if (fromEnv) return normalizeCommit(fromEnv);
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (sha) return normalizeCommit(sha);
  } catch {
    /* not a git checkout — use the deploy stamp */
  }
  try {
    const parsed = JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8")) as {
      gitCommit?: unknown;
    };
    if (typeof parsed.gitCommit === "string" && parsed.gitCommit.trim()) return normalizeCommit(parsed.gitCommit);
  } catch {
    /* no stamped build info — fall through */
  }
  return "local";
}

export default defineConfig({
  plugins: [react()],
  test: {
    // Live-provider protocol tests replace the upstream socket with a fake,
    // but credential validation still runs before that socket is created.
    // Keep the unit suite self-contained without weakening production checks.
    setupFiles: ["./tests/setup.ts"],
    // Git worktrees are full checkouts of another branch sitting inside this
    // one. Vitest walks them, so their copy of tests/ ran alongside the real
    // suite: measured 2026-08-11, .claude/worktrees/nav-ios-plan-b supplied
    // 923 of the 2231 collected cases — 41% of a local run spent re-testing
    // an abandoned branch, and a failure there would read as a failure here.
    // Both directories are gitignored, so this only ever affects local runs.
    exclude: [...configDefaults.exclude, "**/.claude/**", "**/.worktrees/**"]
  },
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(resolveAppVersion()),
    "import.meta.env.VITE_GIT_COMMIT": JSON.stringify(resolveGitCommit())
  },
  server: {
    port: 5173,
    proxy: {
      "/health": {
        target: "http://localhost:8787"
      },
      "/brand": {
        target: "http://localhost:8787"
      },
      "/testing": {
        target: "http://localhost:8787"
      },
      "/auth": {
        target: "http://localhost:8787"
      },
      "/cloud": { target: "http://localhost:8787" },
      "/nav": { target: "http://localhost:8787" },
      "/sdk": { target: "http://localhost:8787" },
      "/v1": { target: "http://localhost:8787" },
      "/_AMapService": { target: "http://localhost:8787" },
      "/agent": {
        target: "ws://localhost:8787",
        ws: true
      }
    }
  }
});
