import express from "express";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { authorizeUpgrade, clientAddress } from "./auth";
import { buildHealth, config, describeConfig, validateConfig } from "./config";
import { createLogger, shortSessionId } from "./logger";
import { createDoubaoProvider } from "./providers/doubao";
import { createMockProvider } from "./providers/mock";
import type { AgentProvider } from "./providers/types";
import { AgentSessionController } from "./session-controller";
import type { Logger } from "./logger";

const app = express();
const server = http.createServer(app);
// noServer: the upgrade is accepted only after authorizeUpgrade clears it.
const wss = new WebSocketServer({ noServer: true });
const log = createLogger("relay");

app.get("/health", (_req, res) => {
  res.json(buildHealth(Math.round(process.uptime())));
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

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://relay.local");
  if (url.pathname !== "/agent") {
    socket.destroy();
    return;
  }

  const decision = authorizeUpgrade(request);
  if (!decision.ok) {
    log.warn("rejected /agent upgrade", {
      address: clientAddress(request),
      code: decision.code,
      reason: decision.reason
    });
    socket.write(`HTTP/1.1 ${decision.code} ${decision.reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (client) => {
    wss.emit("connection", client, request);
  });
});

function selectProvider(client: WebSocket, sessionLog: Logger): AgentProvider {
  if (config.voiceProvider === "doubao") {
    return createDoubaoProvider(client, sessionLog);
  }
  return createMockProvider(client);
}

wss.on("connection", (client, request) => {
  const sessionLog = createLogger(`sess:${shortSessionId(randomUUID())}`);
  sessionLog.info("client connected", { address: clientAddress(request), provider: config.voiceProvider });
  const session = new AgentSessionController(client, (socket) => selectProvider(socket, sessionLog), sessionLog);

  client.on("message", async (data, isBinary) => {
    await session.handleMessage(data, isBinary);
  });

  client.on("close", async (code) => {
    sessionLog.info("client disconnected", { code });
    await session.close();
  });

  client.on("error", (error) => {
    sessionLog.warn("client socket error", { message: error.message });
  });
});

const warnings = validateConfig();
server.listen(config.port, () => {
  log.info(`Voice relay listening on http://localhost:${config.port}`);
  for (const line of describeConfig()) log.info(line);
  for (const warning of warnings) log.warn(warning);
});
