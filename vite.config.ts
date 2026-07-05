import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Same resolution chain as server/build-info.ts: GIT_COMMIT env →
// build-info.json (stamped by deploy-lightsail.command — the deploy rsync
// excludes .git, so the server-side build cannot ask git) → local git →
// "local". Keeps web sessions tagged with the real build in QA statistics.
function resolveGitCommit(): string {
  const fromEnv = process.env.GIT_COMMIT?.trim();
  if (fromEnv) return fromEnv.slice(0, 80);
  try {
    const parsed = JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8")) as {
      gitCommit?: unknown;
    };
    if (typeof parsed.gitCommit === "string" && parsed.gitCommit.trim()) return parsed.gitCommit.trim().slice(0, 80);
  } catch {
    /* no stamped build info — fall through */
  }
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (sha) return sha;
  } catch {
    /* not a git checkout */
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
