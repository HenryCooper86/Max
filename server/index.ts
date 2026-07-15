import express from "express";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  changePassword,
  createInvite,
  deleteUser,
  listInvites,
  listUsers,
  loginUser,
  logoutSession,
  registerUser,
  revokeInvite
} from "./accounts";
import {
  authorizeUpgrade,
  checkAuthRateLimit,
  clientAddress,
  clientRegionHint,
  relayTokenPresented,
  requestUser,
  testingClearAuthorized,
  testingStatsAuthorized
} from "./auth";
import { buildHealth, config, describeConfig, validateConfig } from "./config";
import { createLogger, shortSessionId } from "./logger";
import {
  clearAllTesterData,
  clearTesterData,
  clearTestingSession,
  metrics,
  startMetricsHistory,
  type TestingClearResult
} from "./metrics";
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

// User accounts. Registration turns authentication on (first user = admin);
// login sessions then unlock the testing stats, admin actions, and — on
// token-protected relays — the /agent WebSocket.
app.post("/auth/register", express.json(), (req, res) => {
  if (!checkAuthRateLimit(clientAddress(req))) {
    log.warn("auth rate limit hit", { address: clientAddress(req), route: "register" });
    res.status(429).json({ ok: false, error: "尝试过于频繁，请稍后再试。" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  // On a token-protected relay, open self-registration would mint sessions
  // that bypass the token (and could hand admin to a stranger) — require the
  // relay token or an invite there. The zero-config bootstrap (no token) and
  // the invite flow are unaffected.
  const requireInvite = Boolean(config.relayAuthToken && !relayTokenPresented(req));
  if (requireInvite && typeof body.inviteCode !== "string") {
    res.status(403).json({ ok: false, error: "该中继需要邀请链接（或中继令牌）才能注册。" });
    return;
  }
  registerUser(body.username, body.password, body.displayName, Date.now(), body.inviteCode, { requireInvite })
    .then((result) => {
      if (result.ok) {
        log.info("user registered", { username: result.user.username, role: result.user.role });
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    })
    .catch(() => res.status(500).json({ ok: false, error: "注册失败，请重试。" }));
});

app.post("/auth/login", express.json(), (req, res) => {
  if (!checkAuthRateLimit(clientAddress(req))) {
    log.warn("auth rate limit hit", { address: clientAddress(req), route: "login" });
    res.status(429).json({ ok: false, error: "尝试过于频繁，请稍后再试。" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  loginUser(body.username, body.password)
    .then((result) => {
      if (result.ok) {
        log.info("user logged in", { username: result.user.username });
        res.json(result);
      } else {
        // Brute-force attempts should be visible in the log (no password, and
        // the username only truncated — it may be a typo of a real one).
        log.warn("login failed", {
          address: clientAddress(req),
          username: typeof body.username === "string" ? body.username.slice(0, 32) : "?"
        });
        res.status(401).json(result);
      }
    })
    .catch(() => res.status(500).json({ ok: false, error: "登录失败，请重试。" }));
});

// Self-service password change; revokes the user's other sessions.
app.post("/auth/password", express.json(), (req, res) => {
  if (!checkAuthRateLimit(clientAddress(req))) {
    res.status(429).json({ ok: false, error: "尝试过于频繁，请稍后再试。" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const authorization = req.headers.authorization ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  changePassword(typeof body.token === "string" ? body.token : bearer, body.currentPassword, body.newPassword)
    .then((result) => {
      if (result.ok) {
        log.info("password changed", { username: requestUser(req)?.username });
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    })
    .catch(() => res.status(500).json({ ok: false, error: "修改失败，请重试。" }));
});

app.post("/auth/logout", express.json(), (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const authorization = req.headers.authorization ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  logoutSession(typeof body.token === "string" ? body.token : bearer);
  res.json({ ok: true });
});

app.get("/auth/me", (req, res) => {
  const user = requestUser(req);
  if (!user) {
    res.status(401).json({ ok: false, error: "未登录或会话已过期。" });
    return;
  }
  res.json({ ok: true, user });
});

// Admin: user + invite management for onboarding testers while
// self-registration stays closed.
function requireAdmin(req: express.Request, res: express.Response) {
  const user = requestUser(req);
  if (user?.role === "admin") return user;
  res.status(user ? 403 : 401).json({ ok: false, error: "需要管理员登录。" });
  return null;
}

app.get("/auth/admin/overview", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, users: listUsers(), invites: listInvites() });
});

app.post("/auth/admin/invites", express.json(), (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const invite = createInvite(admin.username);
  log.info("invite created", { by: admin.username, code: `${invite.code.slice(0, 10)}…` });
  res.json({ ok: true, invite });
});

app.post("/auth/admin/invites/revoke", express.json(), (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  revokeInvite(body.code);
  res.json({ ok: true });
});

app.post("/auth/admin/users/delete", express.json(), (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = deleteUser(body.username);
  if (result.ok) {
    log.info("user deleted", { by: admin.username, username: body.username });
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

// Admin: clear tester QA data. Stricter than viewing — once user accounts
// exist, only an admin login (or the operator relay token) may clear.
app.post("/testing/clear", express.json(), (req, res) => {
  if (!testingClearAuthorized(req)) {
    res.status(requestUser(req) ? 403 : 401).json({ ok: false, error: "需要管理员登录或中继令牌。" });
    return;
  }
  const body = (req.body ?? {}) as { scope?: unknown; testerKey?: unknown; sessionId?: unknown };
  let result: TestingClearResult;
  if (body.scope === "all") {
    result = clearAllTesterData();
  } else if (body.scope === "tester" && typeof body.testerKey === "string" && body.testerKey) {
    result = clearTesterData(body.testerKey);
  } else if (body.scope === "session" && typeof body.sessionId === "string" && body.sessionId) {
    result = clearTestingSession(body.sessionId);
  } else {
    res.status(400).json({ ok: false, error: "scope must be all, tester (testerKey), or session (sessionId)" });
    return;
  }
  log.info("testing data cleared", {
    scope: body.scope,
    target: body.scope === "tester" ? body.testerKey : body.scope === "session" ? body.sessionId : undefined,
    ...result
  });
  res.json({ ok: true, ...result });
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
