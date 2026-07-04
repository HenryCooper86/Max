import express from "express";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { authorizeUpgrade, clientAddress, clientRegionHint, testingStatsAuthorized } from "./auth";
import { buildHealth, config, describeConfig, validateConfig } from "./config";
import { createLogger, shortSessionId } from "./logger";
import { metrics, startMetricsHistory } from "./metrics";
import { createDoubaoProvider } from "./providers/doubao";
import { createMockProvider } from "./providers/mock";
import type { AgentProvider, ProviderTelemetry } from "./providers/types";
import { AgentSessionController } from "./session-controller";
import { markClientActivity, startWatchdog, trackClient } from "./watchdog";
import type { Logger } from "./logger";

const app = express();
const server = http.createServer(app);
// noServer: the upgrade is accepted only after authorizeUpgrade clears it.
const wss = new WebSocketServer({ noServer: true });
const log = createLogger("relay");

app.get("/health", (req, res) => {
  // Liveness stays open; the per-tester QA block (IPs, transcripts) requires
  // the relay token once one is configured.
  res.json(buildHealth(Math.round(process.uptime()), testingStatsAuthorized(req)));
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
    metrics.rejectedUpgrade();
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

function selectProvider(client: WebSocket, sessionLog: Logger, telemetry: ProviderTelemetry): AgentProvider {
  if (config.voiceProvider === "doubao") {
    return createDoubaoProvider(client, sessionLog, telemetry);
  }
  return createMockProvider(client, telemetry);
}

wss.on("connection", (client, request) => {
  const sessionLog = createLogger(`sess:${shortSessionId(randomUUID())}`);
  const address = clientAddress(request);
  const region = clientRegionHint(request);
  sessionLog.info("client connected", { address, region, provider: config.voiceProvider });
  metrics.sessionOpened();
  trackClient(client);
  const session = new AgentSessionController(
    client,
    (socket, telemetry) => selectProvider(socket, sessionLog, telemetry),
    sessionLog,
    address,
    region
  );

  client.on("message", async (data, isBinary) => {
    markClientActivity(client);
    try {
      await session.handleMessage(data, isBinary);
    } catch (error) {
      sessionLog.warn("message handling failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  client.on("close", async (code) => {
    sessionLog.info("client disconnected", { code });
    metrics.sessionClosed();
    try {
      await session.close();
    } catch (error) {
      sessionLog.warn("session close failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  client.on("error", (error) => {
    sessionLog.warn("client socket error", { message: error.message });
  });
});

// Once-a-minute counter snapshots so /health can report trailing-window rates.
startMetricsHistory();

// Liveness + idle watchdog: terminates half-open links and closes forgotten
// sessions so their Doubao upstream slots are released. See server/watchdog.ts.
startWatchdog({
  clients: () => wss.clients,
  heartbeatMs: config.heartbeatMs,
  idleTimeoutMs: config.idleTimeoutMs,
  log
});

const warnings = validateConfig();
server.listen(config.port, () => {
  log.info(`Voice relay listening on http://localhost:${config.port}`);
  for (const line of describeConfig()) log.info(line);
  for (const warning of warnings) log.warn(warning);
});
