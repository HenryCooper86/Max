import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function normalizeCommit(value: string): string {
  const clean = value.trim().slice(0, 80);
  return /^[0-9a-f]{7,40}$/i.test(clean) ? clean.slice(0, 12).toLowerCase() : clean;
}

// Same resolution chain as server/build-info.ts: GIT_COMMIT env → local git →
// build-info.json. A checkout ignores stale deploy stamps; the deployed bundle
// excludes .git and falls through to its stamp.
function resolveGitCommit(): string {
  const fromEnv = process.env.GIT_COMMIT?.trim();
  if (fromEnv) return normalizeCommit(fromEnv);
  try {
    const sha = execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
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
  define: {
    "import.meta.env.VITE_GIT_COMMIT": JSON.stringify(resolveGitCommit())
  },
  server: {
    port: 5173,
    proxy: {
      "/health": {
        target: "http://localhost:8787"
      },
      "/testing": {
        target: "http://localhost:8787"
      },
      "/auth": {
        target: "http://localhost:8787"
      },
      "/agent": {
        target: "ws://localhost:8787",
        ws: true
      }
    }
  }
});
