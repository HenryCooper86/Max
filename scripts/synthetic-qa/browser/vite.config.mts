import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const harnessDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(harnessDir, "../../..");
const privateDir = process.env.QA_PRIVATE_DIR || "/tmp/max-synthetic-qa";
const fixtureManifestFile = process.env.QA_FIXTURE_MANIFEST || `${privateDir}/manifest.json`;
const fixtureDir = process.env.QA_FIXTURE_DIR || dirname(fixtureManifestFile);
const evidenceDir = process.env.QA_EVIDENCE_DIR || `${privateDir}/web-evidence`;
const compiledClientCommit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
  cwd: repo,
  encoding: "utf8"
}).trim();
const connection = JSON.parse(readFileSync(process.env.QA_CONNECTION_FILE || `${privateDir}/connection.json`, "utf8"));
const relay = new URL(connection.url);
relay.protocol = relay.protocol === "wss:" ? "https:" : relay.protocol === "ws:" ? "http:" : relay.protocol;
const utilsId = "\0qa-utils";
export default defineConfig({
  root: harnessDir,
  publicDir: `${repo}/public`,
  plugins: [
    react(),
    {
      name: "private-synthetic-qa-only",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "../lib/utils" && importer?.includes("/src/hooks/")) return utilsId;
        if (source === "qa-capture") return `${harnessDir}/runtime.ts`;
      },
      load(id) {
        if (id === utilsId)
          return `export * from '${repo}/src/lib/utils.ts'; export {createAgentSocket} from '${harnessDir}/runtime.ts'; export function getRiderLocation() { return Promise.resolve(null); }`;
      },
      transform(code, id) {
        if (id === `${repo}/src/hooks/useMicCapture.ts`) {
          if (!code.includes("navigator.mediaDevices.getUserMedia(")) throw new Error("Capture seam source changed");
          return (
            `import {acquireSyntheticStream} from 'qa-capture';\n` +
            code.replace("navigator.mediaDevices.getUserMedia(", "acquireSyntheticStream(")
          );
        }
        if (id === `${repo}/src/hooks/useHelmetAgent.ts`) {
          if (!code.includes("navigator.geolocation?.watchPosition")) throw new Error("Location guard source changed");
          return (
            `import {syntheticNetworkType} from 'qa-capture';\n` +
            code
              .replace(
                "function networkType(): string {",
                "function networkType(): string { return syntheticNetworkType();"
              )
              .replace(
                'if (!listening) return;\n    if (typeof navigator === "undefined" || !navigator.geolocation?.watchPosition) return;',
                "if (true) return; // QA only: no geolocation access"
              )
          );
        }
      },
      configureServer(server) {
        server.httpServer?.on("upgrade", (request, socket) => {
          if (request.url?.startsWith("/qa-blocked")) socket.destroy();
        });
        server.middlewares.use((request, response, next) => {
          if (request.url === "/qa-context") {
            response.setHeader("Content-Type", "application/json");
            let context = {};
            try {
              context = JSON.parse(
                readFileSync(process.env.QA_WEB_CONTEXT_FILE || `${privateDir}/web-context.json`, "utf8")
              );
            } catch {
              /* optional assignment metadata */
            }
            response.end(JSON.stringify({ ...context, serverBuild: connection.build, compiledClientCommit }));
            return;
          }
          if (request.url === "/qa-manifest") {
            response.setHeader("Content-Type", "application/json");
            response.end(readFileSync(fixtureManifestFile));
            return;
          }
          if (request.url?.startsWith("/qa-fixture/")) {
            const name = request.url.slice("/qa-fixture/".length);
            if (!/^[a-z-]+\.pcm$/.test(name)) {
              response.statusCode = 400;
              response.end();
              return;
            }
            try {
              response.setHeader("Content-Type", "application/octet-stream");
              response.end(readFileSync(`${fixtureDir}/${name}`));
            } catch {
              response.statusCode = 404;
              response.end();
            }
            return;
          }
          if (request.url === "/qa-evidence" && request.method === "POST") {
            let body = "";
            request.on("data", (chunk) => {
              body += chunk;
              if (body.length > 2_000_000) request.destroy();
            });
            request.on("end", () => {
              try {
                const evidence = JSON.parse(body);
                if (!/^[a-z0-9-]+$/.test(evidence.id)) throw new Error("Invalid evidence id");
                mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
                writeFileSync(`${evidenceDir}/${evidence.id}.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
                response.end("saved");
              } catch {
                response.statusCode = 400;
                response.end("invalid");
              }
            });
            return;
          }
          next();
        });
      }
    }
  ],
  resolve: { alias: { react: `${repo}/node_modules/react`, "react-dom": `${repo}/node_modules/react-dom` } },
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify("0.1.0"),
    "import.meta.env.VITE_GIT_COMMIT": JSON.stringify(compiledClientCommit)
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.QA_PORT || 5189),
    strictPort: true,
    fs: {
      allow: [repo],
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
        "**/connection*.json",
        "**/*-context.json",
        "**/web-evidence/**"
      ]
    },
    proxy: {
      "/agent": {
        target: relay.origin,
        ws: true,
        secure: true,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReqWs", (proxyRequest) => {
            proxyRequest.path += `${proxyRequest.path.includes("?") ? "&" : "?"}token=${encodeURIComponent(connection.token)}`;
          });
        }
      },
      "/health": {
        target: relay.origin,
        secure: true,
        changeOrigin: true,
        headers: { Authorization: `Bearer ${connection.token}` }
      }
    }
  }
});
