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
  relayTokenPresented,
  requestSession,
  requestUser,
  testingAccess,
  testingClearAuthorized
} from "./auth";
import { buildHealth, config, describeConfig, readinessIssues, validateConfig } from "./config";
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
import { testingBuildsMatch, type TestingPlatform, type TestingQuality } from "../shared/testing";
import { createDoubaoProvider } from "./providers/doubao";
import { createMockProvider } from "./providers/mock";
import type { AgentProvider, ProviderTelemetry } from "./providers/types";
import { AgentSessionController } from "./session-controller";
import { markClientActivity, startWatchdog, trackClient } from "./watchdog";
import type { Logger } from "./logger";
import { staticCacheControl } from "./static-cache";
import { clearUserConversationMemory, flushUserMemory, userMemorySummary } from "./user-memory";

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
type AuthenticatedConnection = { userId: string; token: string };
const authenticatedConnections = new Map<WebSocket, AuthenticatedConnection>();
const activeSessions = new Map<WebSocket, AgentSessionController>();
const log = createLogger("relay");
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
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:"
  );
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (/^\/(auth|testing)(\/|$)/.test(req.path) || req.path === "/health" || req.path === "/ready") {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});
app.use(express.json({ limit: "32kb", strict: true }));

app.get("/health", (_req, res) => {
  // Liveness stays small and public. Evidence moved to scoped /testing APIs;
  // never resend every retained transcript on the five-second health poll.
  res.json(buildHealth(Math.round(process.uptime()), false));
});

app.get("/ready", (_req, res) => {
  const issues = [...readinessIssues(), ...(shuttingDown ? ["shutting-down"] : [])];
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
          for (const [client, connection] of authenticatedConnections) {
            if (connection.userId === currentUser.id && connection.token !== token) {
              client.close(1008, "session revoked");
            }
          }
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
  for (const [client, connection] of authenticatedConnections) {
    if (connection.token === token) client.close(1008, "signed out");
  }
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

app.post("/auth/admin/users/delete", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = deleteUser(body.username);
  if (result.ok) {
    clearUserConversationMemory(result.user.id);
    for (const [client, connection] of authenticatedConnections) {
      if (connection.userId === result.user.id) client.close(1008, "account deleted");
    }
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
  const platform = typeof req.query.platform === "string" ? req.query.platform : undefined;
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
      platform:
        platform === "web" ||
        platform === "ios" ||
        platform === "android" ||
        platform === "embedded" ||
        platform === "unknown"
          ? (platform as TestingPlatform)
          : undefined,
      runId: typeof req.query.runId === "string" ? req.query.runId : undefined,
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

// API typos must remain JSON 404s; the SPA fallback below is only for client
// routes and must never turn a missing API endpoint into a successful HTML page.
app.use(["/auth", "/testing"], (_req, res) => {
  res.status(404).json({ ok: false, error: "接口不存在。" });
});

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
  const authenticatedSession = requestSession(request) ?? undefined;
  const authenticatedUser = authenticatedSession?.user;
  if (authenticatedSession) {
    authenticatedConnections.set(client, {
      userId: authenticatedSession.user.id,
      token: authenticatedSession.token
    });
  }
  sessionLog.info("client connected", { address, region, provider: config.voiceProvider });
  metrics.sessionOpened();
  trackClient(client);
  const session = new AgentSessionController(
    client,
    (socket, telemetry) => selectProvider(socket, sessionLog, telemetry),
    sessionLog,
    address,
    region,
    authenticatedUser
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
    authenticatedConnections.delete(client);
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

// WebSocket authorization is checked at upgrade time, but sessions can expire
// or be revoked while a helmet remains connected. Revalidate at a low cadence
// so a stale socket cannot outlive its login indefinitely.
const authSessionSweepTimer = setInterval(() => {
  for (const [client, connection] of authenticatedConnections) {
    if (!sessionUser(connection.token)) client.close(1008, "session expired");
  }
}, 60_000);
authSessionSweepTimer.unref();

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
      server.closeAllConnections?.();
    }, 5_000);
    forceTimer.unref();

    for (const client of wss.clients) client.close(1001, "server shutdown");
    await Promise.allSettled([...activeSessions.values()].map((session) => session.close()));
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
