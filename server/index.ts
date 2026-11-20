import express from "express";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  authActive,
  changePassword,
  createInvite,
  deleteUser,
  flushAccounts,
  listInvites,
  listUsers,
  loginUser,
  logoutSession,
  registerUser,
  revokeInvite,
  sessionUser,
  setUserRole
} from "./accounts";
import {
  authorizeUpgrade,
  checkAuthRateLimit,
  clientAddress,
  clientRegionHint,
  presentedTokens,
  relayTokenPresented,
  requestSession,
  requestUser,
  testingAccess,
  testingClearAuthorized
} from "./auth";
import { buildHealth, config, describeConfig, readinessIssues, validateConfig } from "./config";
import { cloudSessionTokens, sessionTokens } from "./session-tokens";
import { installServerTools } from "./tools/registry";
import { createUsageMeter, monthOf, usageSettingsFromEnv } from "./usage";
import {
  cloudEnabled,
  createCloudInvite,
  listCloudInvites,
  revokeCloudInvite,
  cloudSessionAlive,
  cloudSessionEnded,
  cloudSessionStarted,
  conversationRecorder,
  projectForApiKey,
  pruneOldConversations,
  projectServerTools,
  saveConversation,
  projectKeyValid,
  projectRuntime,
  recoverCloudSessions,
  registerCloudPaymentRoutes,
  registerCloudRoutes,
  registerEmbedRoutes,
  remainingSeconds
} from "./cloud";
import { USAGE_LIMIT_CLOSE_CODE } from "../shared/agent";
import { createLogger, shortSessionId } from "./logger";
import {
  clearAllTesterData,
  clearTesterData,
  clearTestingSession,
  flushTestingHistory,
  metrics,
  startMetricsHistory,
  testingSessionDetail,
  testingSessionPage,
  testingSnapshot,
  updateTestingSessionNotes,
  type TestingClearResult
} from "./metrics";
import { buildInfo } from "./build-info";
import {
  appendTestingAudit,
  createTestingAssignment,
  createTestingPolicy,
  createTestingRun,
  countUnresolvedTestingReviewsForRun,
  getActiveTestingPolicy,
  getTestingReview,
  getTestingRun,
  listTestingAudit,
  listTestingPolicies,
  listTestingReviews,
  listTestingRuns,
  testingOperationsSnapshot,
  updateTestingAssignment,
  updateTestingRun,
  upsertTestingReview
} from "./testing-store";
import { closeTestingStore } from "./testing-store";
import {
  testingBuildsMatch,
  type TestingPlatform,
  type TestingQuality,
  type TestingReviewStatus,
  type TestingValidityStatus
} from "../shared/testing";
import { assistant, assistantLogo, projectAssistantProfile } from "./assistant";
import { sendBrandLogo } from "./brand-logo-route";
import { localizeErrors } from "./error-language";
import { clearStudioVoice, removeStudioLogo, saveStudioConfig, saveStudioLogo, studioState } from "./studio";
import { createStudioVoicesRouter, jsonParserExceptStudioVoices } from "./studio-voices";
import { loadStudioBackends, saveStudioBackends, studioBackendsState } from "./studio-backends";
import { chooseVoiceProvider, createSelectableProvider, createVoiceProvider } from "./providers/factory";
import type { AgentProvider, ProviderTelemetry } from "./providers/types";
import { AgentSessionController } from "./session-controller";
import { markClientActivity, startWatchdog, trackClient } from "./watchdog";
import type { Logger } from "./logger";
import { staticCacheControl } from "./static-cache";
import { clearUserConversationMemory, flushUserMemory, userMemorySummary } from "./user-memory";
import { registerAmapRoutes } from "./amap-proxy";
import { createCompanionBindingStore } from "./companion-store";
import { createCompanionRegistry } from "./companion-registry";
import { createCompanionSocketServer } from "./companion-socket";
import {
  closeAuthenticatedConnections,
  registerAuthenticatedConnection,
  unregisterAuthenticatedConnection
} from "./authenticated-connections";

// Voice backend settings saved from the Studio are laid over the environment
// before anything reads it.
loadStudioBackends();

const app = express();
const server = http.createServer(app);
// noServer: the upgrade is accepted only after authorizeUpgrade clears it.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: config.maxPayloadBytes,
  // Voice PCM is already compact and per-message compression adds CPU and
  // memory pressure while reopening compression-oracle risk for token-bearing
  // control traffic.
  perMessageDeflate: false
});
// Slow-client protection. Node's broad defaults are intended for general web
// servers; this API has tiny JSON bodies and should not hold scarce sockets for
// minutes while a client trickles headers or request bytes.
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1_000;
const activeSessions = new Map<WebSocket, AgentSessionController>();
const usageMeter = createUsageMeter(usageSettingsFromEnv());
const CLOUD_BALANCE_MESSAGE = "Your Max Cloud balance is used up. Top up in the console.";
/** Simultaneous voice sessions per Max Cloud customer. */
const CLOUD_SESSIONS_PER_CUSTOMER = 5;
/** Of those, at most this many from the public embed, which anyone visiting a listed website (or
 *  anyone faking its Origin) can start: the customer's own backend and tests always keep room. */
const CLOUD_EMBED_SESSIONS_PER_CUSTOMER = 3;
/** A public-embed session ends after this long, so nobody can hold one open for hours. */
const CLOUD_EMBED_SESSION_MS = 15 * 60_000;
/** Customer id → ids of their live public-embed sessions. */
const liveEmbedSessions = new Map<string, Set<string>>();
const PROJECT_MINTS_PER_MINUTE = 120;
const projectMints = new Map<string, number[]>();
/** A project's token mints in the trailing minute, within the limit. */
function projectMintAllowed(projectId: string, at = Date.now()): boolean {
  const recent = (projectMints.get(projectId) ?? []).filter((time) => time > at - 60_000);
  if (recent.length >= PROJECT_MINTS_PER_MINUTE) {
    projectMints.set(projectId, recent);
    return false;
  }
  recent.push(at);
  projectMints.set(projectId, recent);
  if (projectMints.size > 10_000) {
    for (const [key, times] of projectMints) if (!times.some((time) => time > at - 60_000)) projectMints.delete(key);
  }
  return true;
}
/** Max Cloud sessions in progress: customer → session → when it connected.
 *  A customer's balance pays for all of them at once, so every check counts
 *  them all, not just the session asking. */
const liveCloudSessions = new Map<string, Map<string, number>>();
function liveCloudSeconds(customerId: string, at = Date.now()): number {
  let seconds = 0;
  for (const connectedAt of liveCloudSessions.get(customerId)?.values() ?? []) seconds += (at - connectedAt) / 1000;
  return seconds;
}
const log = createLogger("relay");
const companionStore = createCompanionBindingStore();
const companionRegistry = createCompanionRegistry({ store: companionStore, log });
const companionSockets = createCompanionSocketServer({
  registry: companionRegistry,
  log
});
let shuttingDown = false;

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "microphone=(self), geolocation=(self)");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    // script-src allows webapi.amap.com for exactly one thing: the Amap JS
    // SDK's own bootstrap <script> tag (NavigationPanel.tsx, Task 9). Every
    // request that script subsequently makes (tiles, styles, geocoding) is
    // redirected by _AMapSecurityConfig.serviceHost back through this
    // origin's /_AMapService proxy, so img-src/connect-src stay 'self' —
    // the secret-holding proxy is the only thing that ever talks to Amap's
    // other hosts.
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://webapi.amap.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:"
  );
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (/^\/(auth|testing|v1)(\/|$)/.test(req.path) || req.path === "/health" || req.path === "/ready") {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});
// Payment notifications must be read as raw bytes to verify their signatures.
registerCloudPaymentRoutes(app);
// A Cloud project carries up to 20,000 characters of knowledge (3 bytes each in Chinese) and its tools.
app.use("/cloud/api/projects", express.json({ limit: "512kb", strict: true }));
// The Studio's voice routes set their own limits (a recording is megabytes), after the admin check.
app.use(jsonParserExceptStudioVoices("32kb"));
// Errors go out in English to a client that asks for it.
app.use(localizeErrors);

// The assistant's logo: the owner's own (assistant.config.json → "logo"), else
// the mark of the configured device. Public like /health: the
// sign-in page shows it. An SVG is served under a policy that lets it draw and
// nothing else, so a logo file can never run script on the relay's origin.
app.get("/brand/logo", (_req, res) => {
  sendBrandLogo(res, assistantLogo());
});

// The owner's logo is also the favicon. The page asks for these two addresses
// before any script runs, so they answer with the logo itself rather than
// waiting for the app to swap the icon; a browser reads the image type from
// the response, not from the address. With no logo of the owner's, the built
// client's own icon files are served further down.
app.get(["/favicon.svg", "/favicon.ico"], (_req, res, next) => {
  const logo = assistant().logo;
  if (!logo) {
    next();
    return;
  }
  sendBrandLogo(res, logo, "no-cache, max-age=0, must-revalidate");
});

// Short-lived session tokens for browsers on other sites (server/session-tokens.ts).
// Called by the owner's backend with the relay token; never by a browser, so
// there is deliberately no CORS here. On a relay with no protection at all
// (no relay token, no accounts) anyone may mint one, which grants nothing an
// open relay does not already give, and keeps development and production code
// paths identical.
app.post("/v1/session-tokens", (req, res) => {
  // A Max Cloud project's API key mints tokens for that project's sessions.
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : "";
  if (bearer.startsWith("mpk_")) {
    const project = cloudEnabled() ? projectForApiKey(bearer) : undefined;
    if (!project) {
      res.status(401).json({ ok: false, error: "Unknown or revoked project key." });
      return;
    }
    if (!projectMintAllowed(project.projectId)) {
      res.status(429).json({ ok: false, error: `At most ${PROJECT_MINTS_PER_MINUTE} tokens a minute per project.` });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const minted = cloudSessionTokens.mint(
      { ttlSeconds: body.ttlSeconds, userId: body.userId, context: body.context },
      project
    );
    if (!minted.ok) {
      res.status(400).json({ ok: false, error: minted.error });
      return;
    }
    res.status(201).json({ token: minted.token, expiresAt: minted.expiresAt });
    return;
  }
  const open = !config.relayAuthToken && !authActive();
  if (!open && !relayTokenPresented(req)) {
    res.status(401).json({ ok: false, error: "Send the relay token: Authorization: Bearer <RELAY_AUTH_TOKEN>." });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (open) {
    // Anyone can call this on an open relay, so a token minted here must not
    // vouch for anyone: a userId or context would reach tools and the prompt
    // as if the owner's backend had set them. Rate-limited too, so nobody can
    // flood the store and push out other tokens.
    if (body.userId !== undefined || body.context !== undefined) {
      res.status(403).json({
        ok: false,
        error: "Set RELAY_AUTH_TOKEN before minting tokens with a userId or context: on an open relay anyone could."
      });
      return;
    }
    if (!checkAuthRateLimit(clientAddress(req))) {
      res.status(429).json({ ok: false, error: "Too many token requests." });
      return;
    }
  }
  const minted = sessionTokens.mint({ ttlSeconds: body.ttlSeconds, userId: body.userId, context: body.context });
  if (!minted.ok) {
    res.status(400).json({ ok: false, error: minted.error });
    return;
  }
  res.status(201).json({ token: minted.token, expiresAt: minted.expiresAt });
});

// The browser SDK (built by vite.sdk.config.ts into dist/sdk). Loaded by other
// sites with <script src>, so it must be readable cross-origin: the relay's
// same-origin resource policy would otherwise block it.
const sdkDir = fileURLToPath(new URL("../dist/sdk", import.meta.url));
app.use(
  "/sdk",
  (_req, res, next) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  },
  express.static(sdkDir, {
    // Revalidated every time (ETag): a deploy must never leave a site on a stale SDK.
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache")
  }),
  (_req, res) => {
    // Checked per request, so `npm run build:sdk` works without a restart.
    res
      .status(404)
      .type("text/plain")
      .send(existsSync(sdkDir) ? "Not found." : "The SDK has not been built. Run: npm run build:sdk");
  }
);

// Voice minutes per user and month (server/usage.ts), for billing and limits.
// Owner-only: the relay token, or an open relay in development.
app.get("/v1/usage", (req, res) => {
  const open = !config.relayAuthToken && !authActive();
  if (!open && !relayTokenPresented(req)) {
    res.status(401).json({ ok: false, error: "Send the relay token: Authorization: Bearer <RELAY_AUTH_TOKEN>." });
    return;
  }
  const month = typeof req.query.month === "string" ? req.query.month : monthOf(Date.now());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ ok: false, error: "month must look like 2026-11" });
    return;
  }
  const userId = typeof req.query.userId === "string" && req.query.userId ? req.query.userId : undefined;
  res.json(usageMeter.report(month, userId));
});

app.get("/health", (_req, res) => {
  // Liveness stays small and public. Evidence moved to scoped /testing APIs;
  // never resend every retained transcript on the five-second health poll.
  res.json(buildHealth(Math.round(process.uptime()), false));
});

app.get("/ready", (_req, res) => {
  const companionIssue = companionStore.readinessIssue();
  const issues = [
    ...readinessIssues(),
    ...(companionIssue ? [companionIssue] : []),
    ...(shuttingDown ? ["shutting-down"] : [])
  ];
  res.status(issues.length ? 503 : 200).json({ ok: issues.length === 0, issues, build: { ...buildInfo } });
});

// User accounts. Registration turns authentication on (first user = admin);
// login sessions then unlock the testing stats, admin actions, and — on
// token-protected relays — the /agent WebSocket.
app.post("/auth/register", (req, res) => {
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

app.post("/auth/login", (req, res) => {
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
app.post("/auth/password", (req, res) => {
  if (!checkAuthRateLimit(clientAddress(req))) {
    res.status(429).json({ ok: false, error: "尝试过于频繁，请稍后再试。" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const authorization = req.headers.authorization ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  const token = typeof body.token === "string" ? body.token : bearer;
  const currentUser = sessionUser(token);
  changePassword(token, body.currentPassword, body.newPassword)
    .then((result) => {
      if (result.ok) {
        if (currentUser) {
          closeAuthenticatedConnections(
            (connection) => connection.userId === currentUser.id && connection.token !== token,
            1008,
            "session revoked"
          );
        }
        log.info("password changed", { username: currentUser?.username });
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    })
    .catch(() => res.status(500).json({ ok: false, error: "修改失败，请重试。" }));
});

app.post("/auth/logout", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const authorization = req.headers.authorization ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  const token = typeof body.token === "string" ? body.token : bearer;
  logoutSession(token);
  closeAuthenticatedConnections((connection) => connection.token === token, 1008, "signed out");
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

// Self-service visibility/control for durable cross-conversation memory.
// Raw history is intentionally not returned here; the summary is enough for
// the UI to show whether memory exists without exposing transcripts again.
app.get("/auth/memory", (req, res) => {
  const user = requestUser(req);
  if (!user) {
    res.status(401).json({ ok: false, error: "未登录或会话已过期。" });
    return;
  }
  res.json({ ok: true, memory: userMemorySummary(user.id) });
});

app.delete("/auth/memory", (req, res) => {
  const user = requestUser(req);
  if (!user) {
    res.status(401).json({ ok: false, error: "未登录或会话已过期。" });
    return;
  }
  const removed = clearUserConversationMemory(user.id);
  log.info("user conversation memory cleared", { username: user.username, removed });
  res.json({ ok: true, removed });
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

app.post("/auth/admin/invites", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const invite = createInvite(admin.username);
  log.info("invite created", { by: admin.username, code: `${invite.code.slice(0, 10)}…` });
  res.json({ ok: true, invite });
});

app.post("/auth/admin/invites/revoke", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.code !== "string" || !body.code.trim()) {
    res.status(400).json({ ok: false, error: "邀请代码不能为空。" });
    return;
  }
  const removed = revokeInvite(body.code);
  res.json({ ok: true, removed });
});

// Max Cloud invitations: signup at /console is invitation-only, like the
// testing platform's accounts. Admins create single-use links here.
function cloudInviteView(invite: ReturnType<typeof listCloudInvites>[number]) {
  return {
    code: invite.code,
    note: invite.note,
    createdBy: invite.created_by,
    createdAt: invite.created_at,
    expiresAt: invite.expires_at
  };
}

app.get("/auth/admin/cloud-invites", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    ok: true,
    enabled: cloudEnabled(),
    invites: cloudEnabled() ? listCloudInvites().map(cloudInviteView) : []
  });
});

app.post("/auth/admin/cloud-invites", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  if (!cloudEnabled()) {
    res.status(503).json({ ok: false, error: "Max Cloud is not configured" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  res.json({ ok: true, invite: cloudInviteView(createCloudInvite(admin.username, body.note)) });
});

app.post("/auth/admin/cloud-invites/revoke", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  res.json({ ok: true, removed: cloudEnabled() ? revokeCloudInvite(body.code) : false });
});

// Studio: an admin edits the live assistant (name, device, look, voice shaping)
// from the app. API keys are never read or written here.
app.get("/auth/admin/studio", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(studioState());
});

app.put("/auth/admin/studio", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const state = saveStudioConfig(body.config);
    log.info("assistant config saved from studio", { by: admin.username, name: state.assistant.name });
    res.json(state);
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Invalid assistant config." });
  }
});

app.put(
  "/auth/admin/studio/logo",
  express.raw({ type: ["image/svg+xml", "image/png", "application/octet-stream"], limit: "600kb" }),
  (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const state = saveStudioLogo(req.body as Buffer);
      log.info("assistant logo uploaded from studio", { by: admin.username });
      res.json(state);
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Invalid logo." });
    }
  }
);

// Voice backend setup. Keys are write-only: they can be set or cleared here,
// and come back only as "set". The log records which settings changed, never
// their values.
app.get("/auth/admin/studio/backends", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(studioBackendsState());
});

app.put("/auth/admin/studio/backends", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  try {
    const { state, changed } = saveStudioBackends(req.body);
    log.info("voice backends changed from studio", { by: admin.username, changed });
    res.json(state);
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Invalid settings." });
  }
});

// Custom voices and pronunciations live on the speech server; the relay holds its key.
app.use("/auth/admin/studio", createStudioVoicesRouter({ requireAdmin, log, clearAssistantVoice: clearStudioVoice }));

app.delete("/auth/admin/studio/logo", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  log.info("assistant logo removed from studio", { by: admin.username });
  res.json(removeStudioLogo());
});

app.post("/auth/admin/users/delete", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = deleteUser(body.username);
  if (result.ok) {
    clearUserConversationMemory(result.user.id);
    closeAuthenticatedConnections((connection) => connection.userId === result.user.id, 1008, "account deleted");
    log.info("user deleted", { by: admin.username, username: body.username });
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

app.post("/auth/admin/users/role", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const targetUsername = typeof body.username === "string" ? body.username.normalize("NFKC").trim().toLowerCase() : "";
  if (targetUsername === admin.username) {
    res.status(400).json({ ok: false, error: "不能修改当前登录账号的角色。" });
    return;
  }
  const result = setUserRole(body.username, body.role);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  appendTestingAudit(admin.username, "account.role-changed", "account", result.user.username, {
    role: result.user.role
  });
  res.json(result);
});

function requireTestingRead(req: express.Request, res: express.Response) {
  const access = testingAccess(req);
  if (access.allowed) return access;
  res.status(401).json({ ok: false, error: "需要登录后查看测试证据。" });
  return null;
}

function requireReviewer(req: express.Request, res: express.Response) {
  const access = testingAccess(req);
  if (access.allowed && access.role !== "tester") return access;
  res.status(access.allowed ? 403 : 401).json({ ok: false, error: "需要 QA 审核员或管理员权限。" });
  return null;
}

function accessActor(req: express.Request): string {
  return requestUser(req)?.username ?? (relayTokenPresented(req) ? "operator-token" : "internal-admin");
}

// Lightweight dashboard summary. Testers receive only their own totals/rows;
// operational state is fetched separately by authorized reviewers.
app.get("/testing/summary", (req, res) => {
  const access = requireTestingRead(req, res);
  if (!access) return;
  res.json({
    ok: true,
    testing: testingSnapshot(Date.now(), {
      testerId: access.testerId,
      includeSessions: false,
      includeTurns: false
    })
  });
});

app.get("/testing/sessions", (req, res) => {
  const access = requireTestingRead(req, res);
  if (!access) return;
  const quality = typeof req.query.quality === "string" ? req.query.quality : undefined;
  const validity = typeof req.query.validity === "string" ? req.query.validity : undefined;
  const platform = typeof req.query.platform === "string" ? req.query.platform : undefined;
  const reviewStatus = typeof req.query.reviewStatus === "string" ? req.query.reviewStatus : undefined;
  // Unlike quality/platform/reviewStatus (ignored when unrecognized), validity
  // guards release-gate evidence semantics, so a bogus value is rejected rather
  // than silently widening the result set back to unfiltered rows.
  if (validity && validity !== "valid" && validity !== "invalid") {
    res.status(400).json({ ok: false, error: "validity 必须为 valid 或 invalid。" });
    return;
  }
  const page = testingSessionPage(
    {
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
      testerId:
        access.role === "tester" ? undefined : typeof req.query.testerId === "string" ? req.query.testerId : undefined,
      testCaseId: typeof req.query.testCaseId === "string" ? req.query.testCaseId : undefined,
      build: typeof req.query.build === "string" ? req.query.build : undefined,
      quality:
        quality === "pass" || quality === "watch" || quality === "fail" ? (quality as TestingQuality) : undefined,
      validity: validity === "valid" || validity === "invalid" ? (validity as TestingValidityStatus) : undefined,
      platform:
        platform === "web" ||
        platform === "ios" ||
        platform === "android" ||
        platform === "embedded" ||
        platform === "unknown"
          ? (platform as TestingPlatform)
          : undefined,
      runId: typeof req.query.runId === "string" ? req.query.runId : undefined,
      reviewStatus:
        reviewStatus === "open" ||
        reviewStatus === "triaged" ||
        reviewStatus === "resolved" ||
        reviewStatus === "waived"
          ? (reviewStatus as TestingReviewStatus)
          : undefined,
      search: typeof req.query.search === "string" ? req.query.search : undefined
    },
    access.testerId
  );
  res.json({ ok: true, ...page });
});

app.get("/testing/sessions/:sessionId", (req, res) => {
  const access = requireTestingRead(req, res);
  if (!access) return;
  const session = testingSessionDetail(req.params.sessionId, access.testerId);
  if (!session) {
    res.status(404).json({ ok: false, error: "测试会话不存在。" });
    return;
  }
  res.json({ ok: true, session });
});

app.post("/testing/sessions/:sessionId/notes", (req, res) => {
  if (!requireReviewer(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const session = updateTestingSessionNotes(req.params.sessionId, body.notes);
  if (!session) {
    res.status(404).json({ ok: false, error: "测试会话不存在。" });
    return;
  }
  appendTestingAudit(accessActor(req), "session.notes-updated", "session", session.sessionId, {
    notesLength: session.notes.length
  });
  res.json({ ok: true, session });
});

app.get("/testing/operations", (req, res) => {
  if (!requireReviewer(req, res)) return;
  res.json({ ok: true, operations: testingOperationsSnapshot(), policies: listTestingPolicies() });
});

app.get("/testing/runs", (req, res) => {
  const access = requireTestingRead(req, res);
  if (!access) return;
  const runs = listTestingRuns();
  if (access.role === "tester") {
    res.json({
      ok: true,
      runs: runs
        .map((run) => ({ ...run, assignments: run.assignments.filter((item) => item.assignee === access.testerId) }))
        .filter((run) => run.assignments.length)
    });
    return;
  }
  res.json({ ok: true, runs });
});

app.post("/testing/runs", (req, res) => {
  if (!requireReviewer(req, res)) return;
  const run = createTestingRun(req.body ?? {}, accessActor(req), buildInfo.gitCommit);
  res.status(201).json({ ok: true, run });
});

app.patch("/testing/runs/:runId", (req, res) => {
  const access = requireReviewer(req, res);
  if (!access) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const candidate = getTestingRun(req.params.runId);
  if (!candidate) {
    res.status(404).json({ ok: false, error: "测试运行不存在。" });
    return;
  }
  if (
    typeof body.status === "string" &&
    ((candidate.status === "approved" && body.status !== "approved" && body.status !== "archived") ||
      (candidate.status === "archived" && body.status !== "archived"))
  ) {
    res.status(409).json({ ok: false, error: "已批准或已归档的发布记录不能重新打开。" });
    return;
  }
  if (body.status === "approved") {
    if (access.role !== "admin" && access.role !== "operator") {
      res.status(403).json({ ok: false, error: "发布批准需要管理员权限。" });
      return;
    }
    const decision = testingSnapshot();
    const coverageComplete = candidate.requirements.every((requirement) => {
      const captured = candidate.assignments
        .filter((assignment) => assignment.requirementId === requirement.id)
        .reduce((sum, assignment) => sum + assignment.completedSessionIds.length, 0);
      return captured >= requirement.requiredValidSessions;
    });
    const unresolvedReviews = countUnresolvedTestingReviewsForRun(candidate.id);
    const regressionBlocked = decision.regression.baselineSource !== "none" && decision.regression.status !== "pass";
    if (
      !testingBuildsMatch(candidate.build, decision.releaseGate.build) ||
      decision.releaseGate.status !== "pass" ||
      !coverageComplete ||
      unresolvedReviews ||
      regressionBlocked
    ) {
      res.status(409).json({
        ok: false,
        error: "发布批准受 gate、覆盖、复核或回归证据阻止。",
        blockers: {
          gate: decision.releaseGate.status,
          buildMatches: testingBuildsMatch(candidate.build, decision.releaseGate.build),
          coverageComplete,
          unresolvedReviews,
          regression: decision.regression.status
        }
      });
      return;
    }
  }
  const run = updateTestingRun(req.params.runId, body, accessActor(req));
  if (!run) {
    res.status(404).json({ ok: false, error: "测试运行不存在。" });
    return;
  }
  res.json({ ok: true, run });
});

app.post("/testing/runs/:runId/assignments", (req, res) => {
  const access = requireReviewer(req, res);
  if (!access) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const assignee = typeof body.assignee === "string" ? body.assignee.trim() : "";
  if (access.role !== "operator" && listUsers().length && !listUsers().some((user) => user.username === assignee)) {
    res.status(400).json({ ok: false, error: "任务受让人必须是已注册的 username。" });
    return;
  }
  const run = createTestingAssignment(req.params.runId, body, accessActor(req));
  if (!run) {
    res.status(400).json({ ok: false, error: "测试运行或覆盖要求不存在。" });
    return;
  }
  res.status(201).json({ ok: true, run });
});

app.patch("/testing/runs/:runId/assignments/:assignmentId", (req, res) => {
  const access = requireReviewer(req, res);
  if (!access) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const assignee = typeof body.assignee === "string" ? body.assignee.trim() : "";
  if (
    body.assignee !== undefined &&
    access.role !== "operator" &&
    listUsers().length &&
    !listUsers().some((user) => user.username === assignee)
  ) {
    res.status(400).json({ ok: false, error: "任务受让人必须是已注册的 username。" });
    return;
  }
  const run = updateTestingAssignment(req.params.runId, req.params.assignmentId, body, accessActor(req));
  if (!run) {
    res.status(404).json({ ok: false, error: "测试任务不存在。" });
    return;
  }
  res.json({ ok: true, run });
});

app.get("/testing/reviews", (req, res) => {
  if (!requireReviewer(req, res)) return;
  res.json({ ok: true, reviews: listTestingReviews() });
});

app.post("/testing/reviews", (req, res) => {
  if (!requireReviewer(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const requestedId = typeof body.id === "string" ? body.id : "";
  // The reviewer feed is intentionally bounded. Updating an old review must
  // use its primary-key lookup instead, otherwise a buried review is treated
  // as new and client-supplied attribution can be applied to it.
  const existing = requestedId ? getTestingReview(requestedId) : undefined;
  const sessionId = existing?.sessionId ?? (typeof body.sessionId === "string" ? body.sessionId : "");
  const session = testingSessionDetail(sessionId);
  if (!existing && !session) {
    res.status(404).json({ ok: false, error: "复核证据会话不存在。" });
    return;
  }
  const review = upsertTestingReview(
    {
      ...body,
      sessionId,
      // Evidence attribution is authoritative; clients cannot move an issue
      // between sessions or attach it to an unrelated release run.
      runId: existing?.runId ?? session?.runId
    },
    accessActor(req)
  );
  if (!review) {
    res.status(400).json({ ok: false, error: "需要提供 sessionId。" });
    return;
  }
  res.json({ ok: true, review });
});

app.get("/testing/policies", (req, res) => {
  if (!requireReviewer(req, res)) return;
  res.json({ ok: true, activePolicy: getActiveTestingPolicy(), policies: listTestingPolicies() });
});

app.post("/testing/policies", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const policy = createTestingPolicy(req.body ?? {}, accessActor(req));
  res.status(201).json({ ok: true, policy });
});

app.get("/testing/audit", (req, res) => {
  if (!requireReviewer(req, res)) return;
  res.json({ ok: true, events: listTestingAudit(200) });
});

// Admin: clear tester QA data. Stricter than viewing — once user accounts
// exist, only an admin login (or the operator relay token) may clear.
app.post("/testing/clear", (req, res) => {
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
    res.status(400).json({ ok: false, error: "scope 必须为 all、tester（testerKey）或 session（sessionId）。" });
    return;
  }
  log.info("testing data cleared", {
    scope: body.scope,
    target: body.scope === "tester" ? body.testerKey : body.scope === "session" ? body.sessionId : undefined,
    ...result
  });
  appendTestingAudit(accessActor(req), "session-data.cleared", "session", String(body.scope), {
    scope: body.scope,
    removedTesters: result.removedTesters,
    removedSessions: result.removedSessions
  });
  res.json({ ok: true, ...result });
});

// Max Cloud's console API (server/cloud).
registerEmbedRoutes(app);
registerCloudRoutes(app);

// API typos must remain JSON 404s; the SPA fallback below is only for client
// routes and must never turn a missing API endpoint into a successful HTML page.
app.use(["/auth", "/testing"], (_req, res) => {
  res.status(404).json({ ok: false, error: "接口不存在。" });
});

// Public JS key + the security-secret-holding tile/style/geocode proxy for
// the optional Amap map layer (Task 9). Must be mounted before the static
// block below so `/nav/js-config` and `/_AMapService/*` aren't swallowed by
// the SPA fallback.
registerAmapRoutes(app);

// Serve the built client when a production bundle exists. In development the
// Vite dev server handles this instead and proxies /health and /agent here.
const clientDir = fileURLToPath(new URL("../dist", import.meta.url));
if (existsSync(clientDir)) {
  app.use(
    express.static(clientDir, {
      setHeaders: (res, filePath) => {
        // Vite's content-hashed bundles (…/assets/) are safe to cache forever.
        // Fixed-name fonts revalidate so a deploy can safely replace them;
        // content-hashed bundles remain immutable for one year.
        res.setHeader("Cache-Control", staticCacheControl(filePath));
      }
    })
  );
  app.use((_req, res) => {
    // The HTML shell points at hashed bundles and must revalidate so a deploy
    // never leaves a returning rider pinned to yesterday's asset names.
    res.setHeader("Cache-Control", "no-cache, max-age=0, must-revalidate");
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

// Keep malformed/oversized JSON failures machine-readable and avoid Express's
// default HTML error response. Unexpected route failures remain honest 500s.
app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const candidate = error as { status?: unknown; type?: unknown };
  const isTooLarge = candidate.status === 413 || candidate.type === "entity.too.large";
  const isInvalidJson = candidate.type === "entity.parse.failed";
  const status = isTooLarge ? 413 : isInvalidJson ? 400 : 500;
  const fields = {
    address: clientAddress(req),
    path: req.path,
    status,
    message: error instanceof Error ? error.message : String(error)
  };
  if (status === 500) log.error("request failed", fields);
  else log.warn("request body rejected", fields);
  res.status(status).json({
    ok: false,
    error: status === 413 ? "请求内容过大。" : status === 400 ? "请求 JSON 无效。" : "服务器内部错误。"
  });
});

server.on("upgrade", (request, socket, head) => {
  if (shuttingDown) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 5\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = new URL(request.url ?? "/", "http://relay.local");
  if (url.pathname === "/companion") {
    companionSockets.handleUpgrade(request, socket, head);
    return;
  }
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
  return createSelectableProvider((requested) => {
    const id = chooseVoiceProvider(requested, {
      fallback: config.voiceProvider,
      switching: config.voiceProviderSwitching
    });
    if (id !== config.voiceProvider) sessionLog.info("session picked its own voice backend", { provider: id });
    return createVoiceProvider(id, client, sessionLog, telemetry);
  });
}

wss.on("connection", (client, request) => {
  const sessionLog = createLogger(`sess:${shortSessionId(randomUUID())}`);
  const address = clientAddress(request);
  const region = clientRegionHint(request);
  const authenticatedSession = requestSession(request) ?? undefined;
  const authenticatedUser = authenticatedSession?.user;
  const tokenGrant = presentedTokens(request)
    .map((token) => sessionTokens.grant(token) ?? cloudSessionTokens.grant(token))
    .find((grant) => grant !== undefined);
  if (authenticatedSession) {
    registerAuthenticatedConnection(client, {
      userId: authenticatedSession.user.id,
      token: authenticatedSession.token
    });
  }
  sessionLog.info("client connected", { address, region, provider: config.voiceProvider });

  // A Max Cloud project's session runs on the project's own model key and
  // persona, is billed to its customer, and is nobody else's business: no
  // relay tools, no QA recording.
  const cloudProject = tokenGrant?.project;
  const runtime = cloudProject && cloudEnabled() ? projectRuntime(cloudProject.projectId) : undefined;
  const refuse = (code: number, message: string, reason: string) => {
    sessionLog.info("connection refused", { reason });
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "error", message }));
      client.close(code, reason);
    }
  };
  if (cloudProject && (!runtime || !projectKeyValid(cloudProject.projectId, cloudProject.keyHash))) {
    unregisterAuthenticatedConnection(client);
    refuse(
      1008,
      runtime
        ? "This Max Cloud project key was rotated or the project was deleted."
        : "This Max Cloud project is not ready: add a model key in the console.",
      "project not ready"
    );
    return;
  }
  const cloudCustomer = cloudProject?.customerId;
  if (cloudCustomer && (liveCloudSessions.get(cloudCustomer)?.size ?? 0) >= CLOUD_SESSIONS_PER_CUSTOMER) {
    unregisterAuthenticatedConnection(client);
    refuse(
      1013,
      `This Max Cloud account already has ${CLOUD_SESSIONS_PER_CUSTOMER} voice sessions open.`,
      "too many sessions"
    );
    return;
  }
  const embedSession = cloudProject?.source === "embed";
  if (
    cloudCustomer &&
    embedSession &&
    (liveEmbedSessions.get(cloudCustomer)?.size ?? 0) >= CLOUD_EMBED_SESSIONS_PER_CUSTOMER
  ) {
    unregisterAuthenticatedConnection(client);
    refuse(1013, "This assistant is busy right now. Try again in a minute.", "too many embed sessions");
    return;
  }
  // Left to talk: the customer's free seconds and balance, minus every one of
  // their sessions still running (they are only booked when they end).
  const cloudSecondsLeft = () =>
    cloudCustomer ? remainingSeconds(cloudCustomer) - liveCloudSeconds(cloudCustomer) : Infinity;

  // Usage: whose minutes these are, and whether they have any left.
  const usageUserId = cloudProject
    ? `project:${cloudProject.projectId}`
    : (authenticatedUser?.id ?? tokenGrant?.userId);
  const limitReached = () =>
    cloudProject
      ? refuse(USAGE_LIMIT_CLOSE_CODE, CLOUD_BALANCE_MESSAGE, "balance used up")
      : refuse(
          USAGE_LIMIT_CLOSE_CODE,
          "This account has used all of its voice minutes for this month.",
          "usage limit reached"
        );
  // A Cloud project pays from its balance and must afford at least one check
  // interval; the relay-wide allowance is for the relay's own users.
  if (cloudProject ? cloudSecondsLeft() < 15 : usageMeter.overLimit(usageUserId)) {
    // Refused before any session exists: nothing else to clean up.
    unregisterAuthenticatedConnection(client);
    limitReached();
    return;
  }
  const usageSessionId = randomUUID();
  const meteredSession = usageMeter.open(usageSessionId, usageUserId);
  // The project's conversation history, when the customer keeps one.
  const recorder = runtime?.studio.keepConversations ? conversationRecorder() : undefined;
  if (cloudProject) {
    const sessions = liveCloudSessions.get(cloudProject.customerId) ?? new Map<string, number>();
    sessions.set(usageSessionId, Date.now());
    liveCloudSessions.set(cloudProject.customerId, sessions);
    if (embedSession) {
      const embeds = liveEmbedSessions.get(cloudProject.customerId) ?? new Set<string>();
      embeds.add(usageSessionId);
      liveEmbedSessions.set(cloudProject.customerId, embeds);
    }
    cloudSessionStarted({
      sessionId: usageSessionId,
      customerId: cloudProject.customerId,
      projectId: cloudProject.projectId
    });
  }
  const usageCheck =
    cloudProject || usageMeter.limitMinutes()
      ? setInterval(() => {
          if (cloudProject) {
            cloudSessionAlive(usageSessionId);
            if (!projectKeyValid(cloudProject.projectId, cloudProject.keyHash)) {
              refuse(1008, "This Max Cloud project key was rotated or the project was deleted.", "project revoked");
              return;
            }
            if (cloudSecondsLeft() <= 0) limitReached();
            return;
          }
          if (usageMeter.overLimit(usageUserId)) limitReached();
        }, 15_000)
      : undefined;
  usageCheck?.unref();
  const embedLimit = embedSession
    ? setTimeout(
        () => refuse(1000, "This conversation reached its 15-minute limit.", "embed session time limit"),
        CLOUD_EMBED_SESSION_MS
      )
    : undefined;
  embedLimit?.unref();
  metrics.sessionOpened();
  trackClient(client);
  const session = new AgentSessionController(
    client,
    (socket, telemetry) =>
      runtime
        ? createVoiceProvider(runtime.backend, socket, sessionLog, telemetry, {
            apiKey: runtime.modelKey,
            profile: projectAssistantProfile({
              name: runtime.assistantName,
              instructions: runtime.instructions,
              greeting: runtime.greeting,
              language: runtime.studio.language,
              knowledge: runtime.studio.knowledge
            }),
            // Only the project's own webhook tools: never the relay's.
            serverTools: () => projectServerTools(runtime.studio, runtime.webhookSecret),
            ...(runtime.studio.voice ? { voice: runtime.studio.voice } : {})
          })
        : selectProvider(socket, sessionLog, telemetry),
    sessionLog,
    address,
    region,
    authenticatedUser,
    {
      deviceRegistrationAuthorized:
        !cloudProject && (relayTokenPresented(request) || (!config.relayAuthToken && !authActive())),
      privateSession: Boolean(cloudProject),
      ...(tokenGrant ? { tokenGrant: { userId: tokenGrant.userId, context: tokenGrant.context } } : {}),
      onServerEvent: (payload) => {
        recorder?.event(payload);
        const event = payload as { type?: unknown; state?: unknown };
        if (event?.type === "tool.activity" && event.state === "started") meteredSession.toolCall();
      },
      onDeviceRegistered: (peer) => companionRegistry.attachHelmet(peer),
      onRiderUtterance: (deviceId, text) => companionRegistry.handleRiderUtterance(deviceId, text)
    }
  );
  activeSessions.set(client, session);

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
    if (usageCheck) clearInterval(usageCheck);
    if (embedLimit) clearTimeout(embedLimit);
    if (cloudProject && embedSession) {
      const embeds = liveEmbedSessions.get(cloudProject.customerId);
      embeds?.delete(usageSessionId);
      if (embeds && embeds.size === 0) liveEmbedSessions.delete(cloudProject.customerId);
    }
    const usage = meteredSession.close();
    if (cloudProject) {
      const sessions = liveCloudSessions.get(cloudProject.customerId);
      sessions?.delete(usageSessionId);
      if (sessions && sessions.size === 0) liveCloudSessions.delete(cloudProject.customerId);
    }
    if (cloudProject && recorder) {
      try {
        saveConversation({
          customerId: cloudProject.customerId,
          projectId: cloudProject.projectId,
          source: cloudProject.source ?? "api",
          seconds: usage?.seconds ?? 0,
          recorder
        });
      } catch (error) {
        sessionLog.warn("conversation could not be saved", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (cloudProject && usage) {
      try {
        cloudSessionEnded({
          customerId: cloudProject.customerId,
          projectId: cloudProject.projectId,
          sessionId: usage.sessionId,
          seconds: usage.seconds,
          endedAt: usage.endedAt
        });
      } catch (error) {
        sessionLog.error("cloud session could not be charged", {
          projectId: cloudProject.projectId,
          seconds: usage.seconds,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    unregisterAuthenticatedConnection(client);
    activeSessions.delete(client);
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
const stopMetricsHistory = startMetricsHistory();

// Liveness + idle watchdog: terminates half-open links and closes forgotten
// sessions so their Doubao upstream slots are released. See server/watchdog.ts.
const stopWatchdog = startWatchdog({
  clients: () => wss.clients,
  heartbeatMs: config.heartbeatMs,
  idleTimeoutMs: config.idleTimeoutMs,
  log
});

// The phone's /companion link gets liveness but DELIBERATELY no idle timeout.
// Liveness, because nothing else closes these sockets — `rejectLocation` only
// sends an error, and the sweep above walks `wss.clients`, not this server — so
// an idle link (a GPS dropout is enough) can be reaped by carrier NAT with
// neither end noticing until the next write fails. Observed 2026-08-12: five
// reattaches in four minutes with the app foregrounded.
//
// No idle timeout, because that one exists to free leaked Doubao upstream
// slots, which a companion socket does not hold. A paired-but-idle phone is a
// legitimate state — `syncCompanionStateIfNeeded` opens a socket that may sit
// idle by design — and closing those would recreate the disconnect this fixes.
const stopCompanionWatchdog = startWatchdog({
  clients: () => companionSockets.clients(),
  heartbeatMs: config.heartbeatMs,
  idleTimeoutMs: 0,
  log
});

// WebSocket authorization is checked at upgrade time, but sessions can expire
// or be revoked while a helmet remains connected. Revalidate at a low cadence
// so a stale socket cannot outlive its login indefinitely.
const authSessionSweepTimer = setInterval(() => {
  closeAuthenticatedConnections((connection) => !sessionUser(connection.token), 1008, "session expired");
}, 60_000);
authSessionSweepTimer.unref();

// The relay's own tools (assistant.config.json → tools / toolsModule) load
// before the first session can start.
await installServerTools(assistant().tools);
// Max Cloud sessions a crash or restart left unbooked are charged up to their last checkpoint.
recoverCloudSessions();
// Conversation transcripts expire after 30 days even for projects nobody talks to any more.
const conversationPruneTimer = setInterval(() => {
  if (!cloudEnabled()) return;
  try {
    pruneOldConversations();
  } catch (error) {
    log.warn("conversation pruning failed", { message: error instanceof Error ? error.message : String(error) });
  }
}, 3_600_000);
conversationPruneTimer.unref();

const warnings = validateConfig();
server.on("error", (error) => {
  log.error("HTTP server error", { message: error.message });
  process.exitCode = 1;
});
server.listen(config.port, () => {
  log.info(`Voice relay listening on http://localhost:${config.port}`);
  for (const line of describeConfig()) log.info(line);
  for (const warning of warnings) log.warn(warning);
});

let shutdownPromise: Promise<void> | null = null;

function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    shuttingDown = true;
    log.info("graceful shutdown started", { signal, activeSessions: activeSessions.size });
    stopMetricsHistory();
    stopWatchdog();
    stopCompanionWatchdog();
    clearInterval(authSessionSweepTimer);
    const serverClosed = new Promise<void>((resolve) => {
      server.close((error) => {
        if (error) log.warn("HTTP server close reported an error", { message: error.message });
        resolve();
      });
    });
    server.closeIdleConnections?.();

    const forceTimer = setTimeout(() => {
      for (const client of wss.clients) client.terminate();
      for (const client of companionSockets.clients()) client.terminate();
      server.closeAllConnections?.();
    }, 5_000);
    forceTimer.unref();

    for (const client of wss.clients) client.close(1001, "server shutdown");
    await companionSockets.close();
    await companionRegistry.close();
    await companionStore.flush();
    await Promise.allSettled([...activeSessions.values()].map((session) => session.close()));
    usageMeter.flush();
    await Promise.allSettled([flushAccounts(), flushUserMemory(), flushTestingHistory()]);
    closeTestingStore();
    await serverClosed;
    clearTimeout(forceTimer);
    wss.close();
    log.info("graceful shutdown complete");
  })().catch((error) => {
    process.exitCode = 1;
    log.error("graceful shutdown failed", { message: error instanceof Error ? error.message : String(error) });
  });
  return shutdownPromise;
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
