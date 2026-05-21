import express from "express";
import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { config, describeConfig, validateConfig } from "./config";
import { createDoubaoProvider } from "./providers/doubao";
import { createMockProvider } from "./providers/mock";
import type { AgentProvider, ClientEvent } from "./providers/types";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/agent" });

app.get("/health", (_req, res) => {
  res.json({ ok: true, provider: config.voiceProvider });
});

// Serve the built client when a production bundle exists. In development the
// Vite dev server handles this instead and proxies /health and /agent here.
const clientDir = fileURLToPath(new URL("../dist", import.meta.url));
if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.use((_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

function selectProvider(client: WebSocket): AgentProvider {
  if (config.voiceProvider === "doubao") {
    return createDoubaoProvider(client);
  }
  return createMockProvider(client);
}

wss.on("connection", (client) => {
  const provider = selectProvider(client);

  client.on("message", async (data, isBinary) => {
    try {
      if (isBinary) {
        await provider.sendAudio(data as Buffer);
        return;
      }

      const event = JSON.parse(data.toString()) as ClientEvent;
      if (event.type === "session.start") await provider.start(event);
      if (event.type === "audio.start") await provider.startAudio();
      if (event.type === "audio.stop") await provider.stopAudio();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Voice relay failed";
      client.send(JSON.stringify({ type: "error", message }));
    }
  });

  client.on("close", async () => {
    await provider.close();
  });
});

const warnings = validateConfig();
server.listen(config.port, () => {
  console.log(`Voice relay listening on http://localhost:${config.port}`);
  for (const line of describeConfig()) console.log(`  ${line}`);
  for (const warning of warnings) console.warn(`  ⚠️  ${warning}`);
});
