import express from "express";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fsPromises } from "node:fs";
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
  reauthorizeUpgrade,
  upgradeIdentity,
  checkAuthRateLimit,
  clientAddress,
  clientRegionHint,
  noteProxyHeaders,
  presentedTokens,
  relayTokenPresented,
  requestSession,
  requestUser,
  testingAccess,
  testingClearAuthorized,
  withLoginBackoff
} from "./auth";
import { buildHealth, config, describeConfig, readinessIssues, readinessWarnings, validateConfig } from "./config";
import { metricsResponse, registerMetricsSource } from "./prometheus";
import { cloudCounters } from "./cloud/counters";
import { cloudSessionTokens, sessionTokens } from "./session-tokens";
import { closeServerTools, installServerTools, serverTools as installedServerTools } from "./tools/registry";
import { createConversationLifecycle } from "./conversation-lifecycle";
import { createRecordings, recordingSettingsFromEnv } from "./recording";
import { guardrailModelFromEnv, guardrailProblems } from "./guardrails";
import { compareVariants, createVariantResults, pickVariant } from "./variants";
import {
  telnyxCarrier,
  telnyxSettingsFromEnv,
  telnyxSignedStreamUrl,
  validTelnyxStreamSignature
} from "./telephony/telnyx";
import {
  createTelephony,
  telephonySettingsFromEnv,
  type Telephony,
  type TelephonyDeps
} from "./telephony/twilio-calls";
import type { IncomingMessage } from "node:http";
import { createWebRtcGateway, webRtcSettingsFromEnv, type WebRtcGateway } from "./webrtc/gateway";
import { turnSettingProblems } from "./providers/live/turn-settings";
import { loadNoiseSuppression, noiseSuppressionFromEnv } from "./noise-suppression";
import { createUsageMeter, monthOf, usageSettingsFromEnv } from "./usage";
import {
  cloudEnabled,
  createCloudInvite,
  listCloudInvites,
  revokeCloudInvite,
  admitCloudSession,
  CLOUD_CHECK_INTERVAL_MS,
  cloudReadinessIssues,
  cloudReadinessWarnings,
  cloudUnreadableSecrets,
  cloudSessionEnded,
  conversationRecorder,
  openCloudSession,
  projectForApiKey,
  projectLimitRefusal,
  projectWebhooks,
  cloudConversationEnded,
  pruneOldConversations,
  projectServerTools,
  projectKeyValid,
  projectRuntime,
  recoverCloudSessions,
  registerCloudPaymentRoutes,
  registerCloudRoutes,
  registerEmbedRoutes,
  spendEmbedTokens
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
import { assistant, assistantLogo, projectAssistantProfile, type AssistantProfile } from "./assistant";
import { sendBrandLogo } from "./brand-logo-route";
import { localizeErrors } from "./error-language";
import {
  clearStudioVoice,
  ConfigFileError,
  deleteStudioVersion,
  FlowError,
  recordStartupConfig,
  removeStudioLogo,
  restoreStudioConfig,
  saveStudioConfig,
  saveStudioFlow,
  saveStudioLogo,
  studioFlow,
  studioHistory,
  studioState,
  studioVersion
} from "./studio";
import { createStudioVoicesRouter, jsonParserExceptStudioVoices } from "./studio-voices";
import { loadStudioBackends, saveStudioBackends, studioBackendsState } from "./studio-backends";
import { chooseVoiceProvider, createSelectableProvider, createVoiceProvider } from "./providers/factory";
import type { AgentProvider, ProviderTelemetry } from "./providers/types";
import { AgentSessionController } from "./session-controller";
import { markClientActivity, startWatchdog, trackClient } from "./watchdog";
import type { Logger } from "./logger";
import { staticCacheControl } from "./static-cache";
import { analysisModelFromEnv } from "./conversation-analysis";
import { summarizeMemory } from "./memory-summary";
import {
  clearUserConversationMemory,
  externalUserMemoryKey,
  flushUserMemory,
  setUserMemorySummarizer,
  userMemorySummary
} from "./user-memory";
import { registerAmapRoutes } from "./amap-proxy";
import { createCampaigns } from "./telephony/campaigns";
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
// Phone calls (server/telephony): a carrier's media streams carry no relay
// credentials, so they have their own socket server and prove themselves with
// a ticket. Twilio and Telnyx can both be set up; each has its own routes.
const telephonySockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
const telephonyConfig = telephonySettingsFromEnv();
const telnyxConfig = telnyxSettingsFromEnv();
// Recording of conversations' audio (server/recording.ts). Off unless asked for.
const recordingConfig = recordingSettingsFromEnv();
const recordings = recordingConfig.settings
  ? createRecordings(recordingConfig.settings, { log: createLogger("recording") })
  : undefined;
let telephony: Telephony | undefined;
let telnyx: Telephony | undefined;
/** Media-stream sockets that have not presented a ticket yet, by client address. */
const pendingStreams = new Map<string, number>();
let pendingStreamTotal = 0;
const MAX_PENDING_STREAMS_PER_ADDRESS = 8;
const MAX_PENDING_STREAMS = 64;
// Noise suppression on microphone audio (server/noise-suppression.ts): off unless NOISE_SUPPRESSION is set.
const noiseSuppression = noiseSuppressionFromEnv();
// WebRTC transport for /agent (server/webrtc): off unless WEBRTC=on.
const webRtcConfig = webRtcSettingsFromEnv();
const webRtc: WebRtcGateway | undefined = webRtcConfig.settings
  ? createWebRtcGateway(webRtcConfig.settings, { log: createLogger("webrtc") })
  : undefined;
const usageMeter = createUsageMeter(usageSettingsFromEnv());
/** A public-embed session ends after this long, so nobody can hold one open for hours. */
const CLOUD_EMBED_SESSION_MS = 15 * 60_000;
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
const log = createLogger("relay");
const companionStore = createCompanionBindingStore();
const companionRegistry = createCompanionRegistry({ store: companionStore, log });
const companionSockets = createCompanionSocketServer({
  registry: companionRegistry,
  log
});
let shuttingDown = false;

app.disable("x-powered-by");
// Every request, including those that never ask for the client address, so a
// misconfigured proxy is reported on the first page load.
app.use((req, _res, next) => {
  noteProxyHeaders(req);
  next();
});
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
// A campaign lists up to 5,000 calls, which the small default does not hold. Its
// limit applies after the owner check, so nobody else can make the relay buffer it.
app.use(
  "/v1/campaigns",
  (req, res, next) => {
    if (ownerRequest(req, res)) next();
  },
  express.json({ limit: "4mb", strict: true })
);
// A flow is up to 12 steps of 8,000 characters each. Its limit applies after the admin check.
app.use(
  "/auth/admin/studio/flow",
  (req, res, next) => {
    if (requireAdmin(req, res)) next();
  },
  express.json({ limit: "512kb", strict: true })
);
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
    if (projectLimitRefusal(project.projectId)) {
      res.status(403).json({
        ok: false,
        error: "This project has used its monthly minutes limit. Raise it in the console's Settings."
      });
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
    if (!checkAuthRateLimit(clientAddress(req), Date.now(), "token-mint")) {
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

/** The origin a request was made to, as the caller saw it. */
function requestOrigin(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  const scheme = proto === "https" || proto === "http" ? proto : req.protocol;
  return `${scheme}://${req.headers.host ?? "localhost"}`;
}

// Twilio asks this what to do with a call; the answer connects it to the
// assistant. Authenticated by Twilio's signature over the URL and the form.
app.post("/telephony/twilio/voice", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
  if (!telephony) {
    res.status(404).type("text/plain").send("Telephony is not configured. Set TWILIO_AUTH_TOKEN.");
    return;
  }
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
    if (typeof value === "string") params[name] = value;
  }
  const origin = telephonyConfig.settings?.publicUrl ?? requestOrigin(req);
  const signature = req.headers["x-twilio-signature"];
  const answer = telephony.voiceWebhook({
    url: `${origin}${req.originalUrl}`,
    params,
    signature: Array.isArray(signature) ? signature[0] : signature
  });
  if (answer.status === 403) log.warn("rejected a telephony webhook: bad signature", { address: clientAddress(req) });
  res.status(answer.status).type("text/xml").send(answer.body);
});

// The same for Telnyx, which asks with GET (its default) or POST. Authenticated
// by the secret in the URL you gave Telnyx: see server/telephony/telnyx.ts.
app.all("/telephony/telnyx/voice", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).set("Allow", "GET, POST").end();
    return;
  }
  if (!telnyx) {
    res.status(404).type("text/plain").send("Telnyx is not configured. Set TELNYX_WEBHOOK_SECRET.");
    return;
  }
  // The call's details are in the query of a GET and in the form of a POST.
  const params: Record<string, string> = {};
  for (const source of [req.query, req.method === "POST" ? req.body : undefined]) {
    for (const [name, value] of Object.entries((source ?? {}) as Record<string, unknown>)) {
      if (typeof value === "string") params[name] = value;
    }
  }
  const origin = telnyxConfig.settings?.publicUrl ?? requestOrigin(req);
  const answer = telnyx.voiceWebhook({ url: `${origin}${req.originalUrl}`, params, signature: undefined });
  if (answer.status === 403) log.warn("rejected a Telnyx webhook: wrong key", { address: clientAddress(req) });
  // Nothing on the way may keep an answer that holds a ticket.
  res.status(answer.status).set("Cache-Control", "no-store").type("text/xml").send(answer.body);
});

// Where the carriers report what became of a call placed for a campaign. Twilio
// signs the request as it does the voice webhook.
app.post("/telephony/twilio/status", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
  if (!telephony) {
    res.status(404).end();
    return;
  }
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
    if (typeof value === "string") params[name] = value;
  }
  const origin = telephonyConfig.settings?.publicUrl ?? requestOrigin(req);
  const signature = req.headers["x-twilio-signature"];
  const answer = telephony.statusWebhook({
    url: `${origin}${req.originalUrl}`,
    params,
    signature: Array.isArray(signature) ? signature[0] : signature
  });
  if (answer.status === 403)
    log.warn("rejected a telephony status callback: bad signature", { address: clientAddress(req) });
  res.status(answer.status).end();
});

// What Twilio asks during a warm transfer: what the person who picked up
// hears, whether they took the call, and what to do with the caller afterwards.
app.post("/telephony/twilio/transfer/:kind", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
  if (!telephony) {
    res.status(404).end();
    return;
  }
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
    if (typeof value === "string") params[name] = value;
  }
  const origin = telephonyConfig.settings?.publicUrl ?? requestOrigin(req);
  const signature = req.headers["x-twilio-signature"];
  const answer = telephony.transferWebhook(String(req.params.kind), {
    url: `${origin}${req.originalUrl}`,
    params,
    signature: Array.isArray(signature) ? signature[0] : signature
  });
  if (answer.status === 403)
    log.warn("rejected a telephony transfer callback: bad signature", { address: clientAddress(req) });
  res.status(answer.status).type("text/xml").send(answer.body);
});

// The same for Telnyx, authenticated by the secret in the URL.
app.post("/telephony/telnyx/status", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
  if (!telnyx) {
    res.status(404).end();
    return;
  }
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
    if (typeof value === "string") params[name] = value;
  }
  const origin = telnyxConfig.settings?.publicUrl ?? requestOrigin(req);
  const answer = telnyx.statusWebhook({ url: `${origin}${req.originalUrl}`, params, signature: undefined });
  if (answer.status === 403) log.warn("rejected a Telnyx status callback: wrong key", { address: clientAddress(req) });
  res.status(answer.status).end();
});

// WebRTC signalling for /agent: the client's offer in, the relay's answer out.
// The same checks as the WebSocket upgrade apply, and the session that follows
// is the same session: only its transport differs (server/webrtc/gateway.ts).
// Pages on other sites call this with fetch, so it answers their preflight;
// the origin allowlist is enforced on the request itself, below.
const webRtcCors = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Max-Age", "600");
  next();
};
app.options("/agent/webrtc", webRtcCors, (_req, res) => {
  res.status(204).end();
});
app.post("/agent/webrtc", webRtcCors, express.json({ limit: "64kb" }), async (req, res) => {
  if (!webRtc) {
    res.status(404).json({ ok: false, error: "WebRTC is not turned on for this relay. Use the WebSocket." });
    return;
  }
  if (shuttingDown) {
    res.status(503).json({ ok: false, error: "The relay is shutting down." });
    return;
  }
  const decision = authorizeUpgrade(req);
  if (!decision.ok) {
    metrics.rejectedUpgrade();
    log.warn("rejected /agent/webrtc offer", {
      address: clientAddress(req),
      code: decision.code,
      reason: decision.reason
    });
    res.status(decision.code).json({ ok: false, error: decision.reason });
    return;
  }
  // The session starts when the peer connects, after this request is over:
  // keep what it will need to know about who asked.
  const asked = {
    url: req.originalUrl,
    headers: req.headers,
    socket: { remoteAddress: req.socket.remoteAddress }
  } as unknown as IncomingMessage;
  const identity = upgradeIdentity(asked);
  const body = (req.body ?? {}) as { sdp?: unknown };
  const answer = await webRtc.accept(
    body.sdp,
    (socket) => {
      // Seconds may have passed since the checks above: the token must still stand.
      const still = shuttingDown
        ? ({ ok: false, code: 1001, reason: "server shutdown" } as const)
        : reauthorizeUpgrade(asked, identity);
      if (!still.ok) {
        log.warn("rejected a webrtc session at connect", { address: clientAddress(asked), reason: still.reason });
        socket.send(JSON.stringify({ type: "error", message: still.reason }));
        socket.close(still.code === 1001 ? 1001 : 1008, still.reason);
        return;
      }
      wss.emit("connection", socket as unknown as WebSocket, asked);
    },
    clientAddress(asked)
  );
  if (answer.ok) res.status(201).json({ ok: true, sdp: answer.sdp });
  else res.status(answer.status).json({ ok: false, error: answer.error });
});

// With both carriers set up, Twilio places the call unless the request names Telnyx.
function telephonyFor(wanted: "twilio" | "telnyx" | undefined): Telephony | undefined {
  return wanted === "telnyx" ? telnyx : wanted === "twilio" ? telephony : (telephony ?? telnyx);
}

function telephonyMissing(wanted: "twilio" | "telnyx" | undefined): string {
  return wanted === "telnyx"
    ? "Telnyx is not configured. Set TELNYX_WEBHOOK_SECRET."
    : wanted === "twilio"
      ? "Twilio is not configured. Set TWILIO_AUTH_TOKEN."
      : "Telephony is not configured. Set TWILIO_AUTH_TOKEN or TELNYX_WEBHOOK_SECRET.";
}

// Places a phone call for the assistant to hold. Owner-only, and never open:
// a relay without a token must not let strangers dial numbers on its account.
app.post("/v1/calls", async (req, res) => {
  if (!config.relayAuthToken || !relayTokenPresented(req)) {
    res.status(401).json({
      ok: false,
      error: config.relayAuthToken
        ? "Send the relay token: Authorization: Bearer <RELAY_AUTH_TOKEN>."
        : "Set RELAY_AUTH_TOKEN before placing calls."
    });
    return;
  }
  const { carrier: wanted, ...input } = (req.body ?? {}) as Record<string, unknown>;
  if (wanted !== undefined && wanted !== "twilio" && wanted !== "telnyx") {
    res.status(400).json({ ok: false, error: "carrier must be twilio or telnyx." });
    return;
  }
  const calls = telephonyFor(wanted);
  if (!calls) {
    res.status(503).json({ ok: false, error: telephonyMissing(wanted) });
    return;
  }
  const placed = await calls.placeCall(input, requestOrigin(req));
  if (placed.ok) res.status(201).json({ ok: true, callSid: placed.callSid });
  else res.status(placed.status).json({ ok: false, error: placed.error });
});

// Batch outbound calls (server/telephony/campaigns.ts). Owner-only: the check
// runs before the body is read, with the larger limit set above.
app.post("/v1/campaigns", (req, res) => {
  const created = campaigns.create(req.body, requestOrigin(req));
  if (created.ok) res.status(201).json({ ok: true, campaign: created.campaign });
  else res.status(created.status).json({ ok: false, error: created.problem });
});

app.get("/v1/campaigns", (req, res) => {
  if (!ownerRequest(req, res)) return;
  res.json({ ok: true, campaigns: campaigns.list() });
});

app.get("/v1/campaigns/:id", (req, res) => {
  if (!ownerRequest(req, res)) return;
  const campaign = campaigns.get(req.params.id);
  if (campaign) res.json({ ok: true, campaign });
  else res.status(404).json({ ok: false, error: "There is no such campaign." });
});

app.post("/v1/campaigns/:id/cancel", (req, res) => {
  if (!ownerRequest(req, res)) return;
  const campaign = campaigns.cancel(req.params.id);
  if (campaign) res.json({ ok: true, campaign });
  else res.status(404).json({ ok: false, error: "There is no such campaign." });
});

app.delete("/v1/campaigns/:id", (req, res) => {
  if (!ownerRequest(req, res)) return;
  const removed = campaigns.remove(req.params.id);
  if (removed.ok) res.json({ ok: true });
  else res.status(removed.status).json({ ok: false, error: removed.problem });
});

// What the relay remembers about one of your users between conversations
// (`conversation.rememberUsers`), by the id your backend put in their session
// token. Owner-only: this is how a product honours "forget me".
function ownerRequest(req: express.Request, res: express.Response): boolean {
  if (config.relayAuthToken && relayTokenPresented(req)) return true;
  res.status(401).json({
    ok: false,
    error: config.relayAuthToken
      ? "Send the relay token: Authorization: Bearer <RELAY_AUTH_TOKEN>."
      : "Set RELAY_AUTH_TOKEN to use this route."
  });
  return false;
}

app.get("/v1/users/:userId/memory", (req, res) => {
  if (!ownerRequest(req, res)) return;
  const { enabled, updatedAt, turnCount, factCount } = userMemorySummary(externalUserMemoryKey(req.params.userId));
  res.json({ ok: true, memory: { enabled, ...(updatedAt ? { updatedAt } : {}), turnCount, factCount } });
});

app.delete("/v1/users/:userId/memory", (req, res) => {
  if (!ownerRequest(req, res)) return;
  const removed = clearUserConversationMemory(externalUserMemoryKey(req.params.userId));
  log.info("a token user's conversation memory was cleared", { removed });
  res.json({ ok: true, removed });
});

// The variants of an A/B test and how their conversations went. Owner-only.
app.get("/v1/variants", (req, res) => {
  if (!ownerRequest(req, res)) return;
  const { variants, version } = assistant();
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  const results = variantResults.tallies();
  const compared = compareVariants(
    results,
    variants.map((variant) => variant.id),
    version
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    ok: true,
    ...(version ? { version } : {}),
    variants: variants.map(({ id, weight }) => ({ id, weight, share: Math.round((weight / total) * 1000) / 1000 })),
    results,
    // Whether the variants' success rates differ by more than chance, for the config's own version.
    ...(compared ? { comparison: compared } : {}),
    // False when nothing is counted because no conversation records are kept.
    counting: conversations.keepsRecords(),
    ...(variantResults.reading() ? { readingLog: true } : {})
  });
});

// The finished recordings, newest first. Owner-only, like the two routes after it.
app.get("/v1/recordings", async (req, res) => {
  if (!ownerRequest(req, res)) return;
  if (!recordings) {
    res.status(404).json({ ok: false, error: "Recording is not on." });
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ ok: true, ...(await recordings.list()) });
});

// A conversation's recording, by the file name its record gives. Owner-only:
// it is what people said, as sound.
app.get("/v1/recordings/:file", (req, res) => {
  if (!ownerRequest(req, res)) return;
  const file = recordings?.pathOf(req.params.file);
  if (!file) {
    res.status(404).json({ ok: false, error: "There is no such recording." });
    return;
  }
  res.set("Cache-Control", "private, no-store");
  res.type("audio/wav").sendFile(file, { dotfiles: "allow" }, (error) => {
    if (error && !res.headersSent) res.status(404).json({ ok: false, error: "There is no such recording." });
  });
});

app.delete("/v1/recordings/:file", async (req, res) => {
  if (!ownerRequest(req, res)) return;
  const file = recordings?.pathOf(req.params.file);
  if (!file) {
    res.status(404).json({ ok: false, error: "There is no such recording." });
    return;
  }
  try {
    await fsPromises.rm(file, { force: true });
    log.info("a recording was deleted", { file: req.params.file });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "The recording could not be deleted." });
  }
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
    ...cloudReadinessIssues(),
    ...(companionIssue ? [companionIssue] : []),
    ...(shuttingDown ? ["shutting-down"] : [])
  ];
  res.status(issues.length ? 503 : 200).json({
    ok: issues.length === 0,
    issues,
    warnings: [...readinessWarnings(), ...cloudReadinessWarnings()],
    build: { ...buildInfo }
  });
});

// Prometheus scrape endpoint (server/prometheus.ts). Off unless METRICS_TOKEN
// is set, and then only for that token.
registerMetricsSource(() => ({
  relay_agent_sockets_open: wss.clients.size + (webRtc ? [...webRtc.sockets()].length : 0),
  relay_companion_sockets_open: [...companionSockets.clients()].length
}));
// Billing counters (bookings, failed bookings, top-ups); all zero while Max Cloud is off.
registerMetricsSource(cloudCounters);
registerMetricsSource(() => ({ max_cloud_secrets_unreadable: cloudUnreadableSecrets() }));
app.get("/metrics", (req, res) => {
  const response = metricsResponse(req.headers.authorization);
  // setHeader and end, not set/send: Express would rewrite the exposition content type.
  for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
  res.setHeader("Cache-Control", "no-store");
  res.status(response.status).end(response.body);
});

// User accounts. Registration turns authentication on (first user = admin);
// login sessions then unlock the testing stats, admin actions, and — on
// token-protected relays — the /agent WebSocket.
app.post("/auth/register", (req, res) => {
  if (!checkAuthRateLimit(clientAddress(req), Date.now(), "relay-auth")) {
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
  if (!checkAuthRateLimit(clientAddress(req), Date.now(), "relay-auth")) {
    log.warn("auth rate limit hit", { address: clientAddress(req), route: "login" });
    res.status(429).json({ ok: false, error: "尝试过于频繁，请稍后再试。" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  withLoginBackoff("relay", body.username, clientAddress(req), () => loginUser(body.username, body.password))
    .then((outcome) => {
      // Same answer as the per-IP limit, for real and unknown names alike.
      if (outcome.locked) {
        log.warn("login locked out", {
          address: clientAddress(req),
          username: typeof body.username === "string" ? body.username.slice(0, 32) : "?"
        });
        res.setHeader("Retry-After", String(outcome.retryAfterSeconds));
        res.status(429).json({ ok: false, error: "尝试过于频繁，请稍后再试。" });
        return;
      }
      const result = outcome.result;
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
  if (!checkAuthRateLimit(clientAddress(req), Date.now(), "relay-password")) {
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
    const state = saveStudioConfig(body.config, admin.username);
    log.info("assistant config saved from studio", { by: admin.username, name: state.assistant.name });
    res.json(state);
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Invalid assistant config." });
  }
});

// The flow builder: the assistant's agents as steps and the arrows between them.
// `tools` are the names a step can be limited to; a client's own tools are not known here.
const flowTools = () => [...new Set(installedServerTools().map((tool) => tool.name))].sort();

app.get("/auth/admin/studio/flow", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ ...studioFlow(), tools: flowTools() });
});

app.put("/auth/admin/studio/flow", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const flow = saveStudioFlow(body.steps, admin.username);
    log.info("flow saved from studio", { by: admin.username, steps: flow.steps.map((step) => step.id) });
    res.json({ ...flow, tools: flowTools() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (error instanceof FlowError) {
      res.status(400).json({ ok: false, error: message, problems: error.problems });
    } else if (error instanceof ConfigFileError) {
      log.warn("the assistant config file could not be written", { message });
      res.status(500).json({ ok: false, error: `The config file on the server could not be written: ${message}` });
    } else res.status(400).json({ ok: false, error: message || "The flow could not be saved." });
  }
});

// The configs that have been live, newest first, and going back to one of them.
app.get("/auth/admin/studio/history", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader("Cache-Control", "private, no-store");
  res.json(studioHistory());
});

app.get("/auth/admin/studio/history/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const version = studioVersion(String(req.params.id));
  res.setHeader("Cache-Control", "private, no-store");
  if (!version) res.status(404).json({ ok: false, error: "There is no such version." });
  else res.json(version);
});

app.post("/auth/admin/studio/history/:id/restore", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = String(req.params.id);
  try {
    const state = restoreStudioConfig(id, admin.username);
    if (!state) {
      res.status(404).json({ ok: false, error: "There is no such version." });
      return;
    }
    log.info("assistant config restored from history", {
      by: admin.username,
      version: id,
      restartFor: state.restartFor
    });
    res.json(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (error instanceof ConfigFileError) {
      log.warn("the assistant config file could not be written", { message });
      res.status(500).json({ ok: false, error: `The config file on the server could not be written: ${message}` });
      return;
    }
    res.status(400).json({
      ok: false,
      error: `That version can no longer be used: ${message || "it is not a valid config"}`
    });
  }
});

// For a kept config that held something that must not stay on disk, such as a secret that was since replaced.
app.delete("/auth/admin/studio/history/:id", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = String(req.params.id);
  if (!deleteStudioVersion(id)) {
    res.status(404).json({ ok: false, error: "There is no such version." });
    return;
  }
  log.info("assistant config removed from history", { by: admin.username, version: id });
  res.setHeader("Cache-Control", "private, no-store");
  res.json(studioHistory());
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
  if (url.pathname === "/telephony/twilio/stream" || url.pathname === "/telephony/telnyx/stream") {
    const viaTelnyx = url.pathname === "/telephony/telnyx/stream";
    const calls = viaTelnyx ? telnyx : telephony;
    const address = clientAddress(request);
    const waiting = pendingStreams.get(address) ?? 0;
    // A media stream carries no credentials until its first message, so the
    // sockets that have not shown a ticket yet are rationed: none at all unless
    // a call is waiting for its stream, a few per address, and a fixed number
    // in total. Calls in progress do not count against them.
    // Through a proxy the relay was not told to trust, every client has the
    // proxy's address: a per-address ration would be one ration for everybody,
    // Twilio included. The total still holds.
    const shared = !config.trustProxy && Boolean(request.headers["x-forwarded-for"] ?? request.headers.forwarded);
    if (
      !calls ||
      !calls.expectsStream() ||
      (!shared && waiting >= MAX_PENDING_STREAMS_PER_ADDRESS) ||
      pendingStreamTotal >= MAX_PENDING_STREAMS
    ) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Telnyx signs the request for a stream; with its public key set, an
    // unsigned one goes no further. The signature covers the URL as Telnyx was
    // given it, which is the relay's public origin and this path and ticket.
    const telnyxKey = viaTelnyx ? telnyxConfig.settings?.publicKey : undefined;
    if (telnyxKey) {
      const header = (name: string): string | undefined => {
        const value = request.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };
      const signed = validTelnyxStreamSignature({
        publicKey: telnyxKey,
        streamUrl: telnyxSignedStreamUrl({
          ...(telnyxConfig.settings?.publicUrl ? { publicUrl: telnyxConfig.settings.publicUrl } : {}),
          ...(request.headers.host ? { host: request.headers.host } : {}),
          ...(header("x-forwarded-proto") ? { forwardedProto: header("x-forwarded-proto") } : {}),
          encrypted: "encrypted" in request.socket,
          requestUrl: request.url ?? ""
        }),
        timestamp: header("telnyx-timestamp"),
        signature: header("telnyx-signature-ed25519")
      });
      if (!signed) {
        log.warn("rejected a Telnyx media stream: bad signature", { address });
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    const urlTicket = viaTelnyx ? (url.searchParams.get("ticket") ?? "") : undefined;
    pendingStreams.set(address, waiting + 1);
    pendingStreamTotal += 1;
    let counted = true;
    const settled = () => {
      if (!counted) return;
      counted = false;
      pendingStreamTotal -= 1;
      const left = (pendingStreams.get(address) ?? 1) - 1;
      if (left > 0) pendingStreams.set(address, left);
      else pendingStreams.delete(address);
    };
    // A handshake that never completes gives its slot back too.
    socket.once("close", settled);
    telephonySockets.handleUpgrade(request, socket, head, (stream) => calls.handleStream(stream, settled, urlTicket));
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

function selectProvider(
  client: WebSocket,
  sessionLog: Logger,
  telemetry: ProviderTelemetry,
  /** The assistant as this conversation's variant has it, in an A/B test. */
  profile?: AssistantProfile
): AgentProvider {
  return createSelectableProvider((requested) => {
    const id = chooseVoiceProvider(requested, {
      fallback: config.voiceProvider,
      switching: config.voiceProviderSwitching
    });
    if (id !== config.voiceProvider) sessionLog.info("session picked its own voice backend", { provider: id });
    return createVoiceProvider(id, client, sessionLog, telemetry, profile ? { profile } : {});
  });
}

// How the conversations of each variant went (server/variants.ts), counted
// from the conversation records: the ones in the log file, and each new one.
const variantResults = createVariantResults();

// Traces, post-conversation analysis and the conversation webhook, for the
// relay's own assistant. (Max Cloud projects keep their history in the console.)
const conversations = createConversationLifecycle({
  ...(assistant().analysis ? { analysis: assistant().analysis } : {}),
  redact: assistant().redact,
  onRecord: (record) => variantResults.add(record),
  // An A/B test is counted from the records, so it has them made even with nowhere to send them.
  keepRecords: assistant().variants.length > 0
});
if (process.env.CONVERSATION_LOG_FILE?.trim()) void variantResults.readLog(process.env.CONVERSATION_LOG_FILE.trim());
for (const problem of [
  ...assistant().configProblems,
  ...conversations.problems(),
  ...turnSettingProblems(),
  ...new Set(
    [assistant(), ...assistant().variants.map((variant) => variant.profile)].flatMap((profile) =>
      guardrailProblems(profile.guardrails)
    )
  )
]) {
  log.warn(problem);
}
if (assistant().variants.length > 0) {
  log.info("variants on", {
    variants: assistant().variants.map((variant) => `${variant.id}:${variant.weight}`),
    ...(assistant().version ? { version: assistant().version } : {})
  });
  if (!process.env.CONVERSATION_LOG_FILE?.trim())
    log.warn(
      "variants are counted in memory only and start from zero at a restart: set CONVERSATION_LOG_FILE to keep the counts"
    );
  if (!config.trustProxy)
    log.warn(
      "variants: visitors without a user id are told apart by their address. Behind a reverse proxy every visitor has the proxy's address and gets the same variant: set RELAY_TRUST_PROXY=on, or give users an id with a session token"
    );
  if (config.voiceProvider === "doubao" || config.voiceProvider === "mock")
    log.warn(
      `variants do not apply to the ${config.voiceProvider === "mock" ? "demo" : "Doubao"} backend: every conversation there runs the config as it is`
    );
}
if (assistant().guardrails) {
  const {
    blockedTerms,
    rules,
    userRules,
    toolRules,
    checkedTools,
    resultRules,
    checkedResults,
    endConversation,
    hold
  } = assistant().guardrails!;
  log.info("guardrails on", {
    blockedTerms: blockedTerms.length,
    rules: rules.length,
    userRules: userRules.length,
    ...(toolRules.length > 0 ? { toolRules: toolRules.length, checkedTools: checkedTools ?? "all" } : {}),
    ...(resultRules.length > 0 ? { resultRules: resultRules.length, checkedResults: checkedResults ?? "all" } : {}),
    ...(rules.length + userRules.length + toolRules.length + resultRules.length > 0
      ? { model: guardrailModelFromEnv()?.model ?? "none" }
      : {}),
    ...(hold ? { hold: true } : {}),
    then: endConversation ? "end the conversation" : "carry on"
  });
}
// Speech can be held for the judge only where the relay makes the speech from text itself.
for (const profile of [assistant(), ...assistant().variants.map((variant) => variant.profile)]) {
  if (!profile.guardrails?.hold) continue;
  const where = profile.variant ? `variants: ${profile.variant}: ` : "";
  if (profile.guardrails.rules.length === 0) {
    log.warn(`${where}guardrails.hold is set but there are no rules to judge: nothing is held`);
  } else if (!["pipeline", "local", "max-speech"].includes(config.voiceProvider)) {
    log.warn(
      `${where}guardrails.hold does not apply to the ${config.voiceProvider} backend, which makes speech and text together: rules are judged while the assistant speaks`
    );
  }
}

for (const problem of noiseSuppression.problems) log.warn(problem);
if (noiseSuppression.mode !== "off") {
  void loadNoiseSuppression(log).then((loaded) => {
    if (loaded)
      log.info("noise suppression ready", { sessions: noiseSuppression.mode === "on" ? "all" : "phone calls" });
  });
}
for (const problem of recordingConfig.problems) log.warn(problem);
if (recordingConfig.settings) {
  log.info("conversation recording on", {
    conversations: recordingConfig.settings.mode === "on" ? "all" : "phone calls",
    keepDays: recordingConfig.settings.keepDays ?? "for ever"
  });
}
for (const problem of webRtcConfig.problems) log.warn(problem);
if (webRtcConfig.settings) {
  log.info("webrtc ready", {
    publicAddresses: webRtcConfig.settings.publicAddresses,
    ports: webRtcConfig.settings.portRange ?? "any",
    maxSessions: webRtcConfig.settings.maxSessions
  });
}
/** What a call needs from the relay, whichever carrier brought it. */
const callDeps = (logName: string): TelephonyDeps => ({
  log: createLogger(logName),
  openSession(client, call, extras) {
    const usageUserId = call.userId ?? "phone";
    if (shuttingDown) return { refused: "shutting down" };
    if (usageMeter.overLimit(usageUserId)) return { refused: "usage limit reached" };
    const sessionId = randomUUID();
    const sessionLog = createLogger(`call:${shortSessionId(sessionId)}`);
    const metered = usageMeter.open(sessionId, usageUserId);
    // The same person gets the same variant on every call: by who they are, or else by their number.
    const other = call.direction === "inbound" ? call.from : call.to;
    const variant = pickVariant(assistant().variants, call.userId ?? other);
    const observer = conversations.active()
      ? conversations.open({
          sessionId,
          channel: "phone",
          assistant: assistant().name,
          ...(assistant().version ? { version: assistant().version } : {}),
          ...(variant ? { variant: variant.id } : {}),
          phone: {
            direction: call.direction,
            callSid: call.callSid,
            ...(call.from ? { from: call.from } : {}),
            ...(call.to ? { to: call.to } : {})
          },
          ...(call.userId ? { userId: call.userId } : {}),
          ...(assistant().languages[0] ? { language: assistant().languages[0] } : {})
        })
      : undefined;
    const recording = recordings?.records("phone") ? recordings.open(sessionId) : undefined;
    metrics.sessionOpened();
    const socket = client as unknown as WebSocket;
    const session = new AgentSessionController(
      socket,
      (target, telemetry) => selectProvider(target, sessionLog, telemetry, variant?.profile),
      sessionLog,
      "phone",
      undefined,
      undefined,
      {
        deviceRegistrationAuthorized: false,
        // A caller is a member of the public: nothing they say is QA evidence.
        privateSession: true,
        resumeScope: "phone",
        channel: "phone",
        noiseSuppression: noiseSuppression.mode !== "off",
        ...(recording ? { recording, recordingClient: "phone" as const } : {}),
        sessionTools: extras.sessionTools,
        trustedContext: extras.trustedContext,
        ...(call.userId ? { tokenGrant: { userId: call.userId } } : {}),
        onServerEvent: (payload) => {
          observer?.event(payload);
          const event = payload as { type?: unknown; state?: unknown };
          if (event?.type === "tool.activity" && event.state === "started") metered.toolCall();
        }
      }
    );
    activeSessions.set(socket, session);
    let over = false;
    return {
      handleMessage: (data, isBinary) => session.handleMessage(data, isBinary),
      close(reason) {
        if (over) return;
        over = true;
        metered.close();
        const recorded = recording?.close();
        observer?.end(reason ?? "caller", recorded ? { recording: recorded } : undefined);
        activeSessions.delete(socket);
        metrics.sessionClosed();
        void session.close().catch((error: unknown) => {
          sessionLog.warn("session close failed", {
            message: error instanceof Error ? error.message : String(error)
          });
        });
      }
    };
  },
  ...(assistant().languages[0] ? { language: assistant().languages[0] } : {})
});
for (const problem of telephonyConfig.problems) log.warn(problem);
if (telephonyConfig.settings) {
  telephony = createTelephony(telephonyConfig.settings, callDeps("telephony"));
  log.info("telephony ready", {
    transfers: [...telephonyConfig.settings.transferTargets.keys()],
    ...(telephonyConfig.settings.warmTransfer ? { warmTransfer: telephonyConfig.settings.warmTransfer } : {}),
    outbound: Boolean(telephonyConfig.settings.accountSid && telephonyConfig.settings.phoneNumber)
  });
}
// What both carriers share is read for each: say it once.
for (const problem of telnyxConfig.problems) {
  if (!telephonyConfig.problems.includes(problem)) log.warn(problem);
}
if (telnyxConfig.settings) {
  const settings = telnyxConfig.settings;
  telnyx = createTelephony(settings, callDeps("telnyx"), telnyxCarrier(settings));
  log.info("telephony ready (Telnyx)", {
    transfers: settings.apiKey ? [...settings.transferTargets.keys()] : [],
    outbound: Boolean(settings.applicationSid && settings.phoneNumber && settings.publicUrl),
    streamSignature: Boolean(settings.publicKey)
  });
}

// Batch calls go through the same placing as POST /v1/calls.
const campaigns = createCampaigns({
  log: createLogger("campaigns"),
  ...(process.env.CAMPAIGNS_FILE?.trim() ? { file: process.env.CAMPAIGNS_FILE.trim() } : {}),
  notReady: (wanted) =>
    telephonyFor(wanted)?.placeProblem() ?? (telephonyFor(wanted) ? undefined : telephonyMissing(wanted)),
  lineFree: (wanted) => telephonyFor(wanted)?.hasFreeLine() ?? true,
  place: async (wanted, input, watch, origin) => {
    const calls = telephonyFor(wanted);
    if (!calls) return { ok: false, status: 503, error: telephonyMissing(wanted) };
    return calls.placeCall(input, origin ?? "", watch);
  }
});

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
  // A public-embed token opens one session (server/cloud/sessions.ts); the SDK fetches a new one to reconnect.
  if (!spendEmbedTokens(presentedTokens(request))) {
    unregisterAuthenticatedConnection(client);
    refuse(1008, "This conversation token was already used. Start the conversation again.", "embed token reused");
    return;
  }
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
  const embedSession = cloudProject?.source === "embed";

  // Usage: whose minutes these are, and whether they have any left. A Cloud
  // project pays from its customer's balance, within its own limits
  // (server/cloud/live.ts); the relay-wide allowance is for the relay's own users.
  const usageUserId = cloudProject
    ? `project:${cloudProject.projectId}`
    : (authenticatedUser?.id ?? tokenGrant?.userId);
  const limitReached = () =>
    refuse(
      USAGE_LIMIT_CLOSE_CODE,
      "This account has used all of its voice minutes for this month.",
      "usage limit reached"
    );
  const cloudRefusal = cloudProject ? admitCloudSession(cloudProject, address) : undefined;
  if (cloudRefusal || (!cloudProject && usageMeter.overLimit(usageUserId))) {
    // Refused before any session exists: nothing else to clean up.
    unregisterAuthenticatedConnection(client);
    if (cloudRefusal) refuse(cloudRefusal.code, cloudRefusal.message, cloudRefusal.reason);
    else limitReached();
    return;
  }
  const usageSessionId = randomUUID();
  const meteredSession = usageMeter.open(usageSessionId, usageUserId);
  // The project's conversation history, when the customer keeps one.
  // Or sends each one to their own server. (What is said is collected for no other reason.)
  const recorder =
    runtime?.studio.keepConversations || runtime?.studio.conversationWebhook ? conversationRecorder() : undefined;
  // Billed only while the voice model can talk, checkpointed and checked every few seconds.
  const cloudSession = cloudProject ? openCloudSession(usageSessionId, cloudProject, address) : undefined;
  const usageCheck = cloudSession
    ? setInterval(() => {
        const refusal = cloudSession.check();
        if (refusal) refuse(refusal.code, refusal.message, refusal.reason);
      }, CLOUD_CHECK_INTERVAL_MS)
    : usageMeter.limitMinutes()
      ? setInterval(() => {
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
  // The same user gets the same variant every time; a visitor without an id, by their address.
  const variant = cloudProject
    ? undefined
    : pickVariant(
        assistant().variants,
        // An address nobody could tell is not one to tell people apart by: such a visitor is drawn at random.
        authenticatedUser?.id ?? tokenGrant?.userId ?? (address && address !== "unknown" ? address : undefined)
      );
  const observer =
    !cloudProject && conversations.active()
      ? conversations.open({
          sessionId: usageSessionId,
          channel: "web",
          assistant: assistant().name,
          ...(assistant().version ? { version: assistant().version } : {}),
          ...(variant ? { variant: variant.id } : {}),
          ...((authenticatedUser?.id ?? tokenGrant?.userId)
            ? { userId: authenticatedUser?.id ?? tokenGrant?.userId }
            : {}),
          ...(assistant().languages[0] ? { language: assistant().languages[0] } : {})
        })
      : undefined;
  // A Max Cloud project's conversations are its customer's: the relay's owner does not record them.
  const recording = !cloudProject && recordings?.records("web") ? recordings.open(usageSessionId) : undefined;
  let sessionProvider: AgentProvider | undefined;
  const session = new AgentSessionController(
    client,
    (socket, telemetry) =>
      (sessionProvider = runtime
        ? createVoiceProvider(runtime.backend, socket, sessionLog, telemetry, {
            apiKey: runtime.modelKey,
            profile: projectAssistantProfile({
              name: runtime.assistantName,
              instructions: runtime.instructions,
              greeting: runtime.greeting,
              language: runtime.studio.language,
              knowledge: runtime.studio.knowledge,
              flow: runtime.studio.flow,
              onProblems: (problems) =>
                sessionLog.warn("the project's settings were not all used", { project: runtime.projectId, problems })
            }),
            // Only the project's own webhook tools: never the relay's.
            serverTools: () => projectServerTools(runtime.studio, runtime.webhookSecret),
            ...(runtime.studio.voice ? { voice: runtime.studio.voice } : {})
          })
        : selectProvider(socket, sessionLog, telemetry, variant?.profile)),
    sessionLog,
    address,
    region,
    authenticatedUser,
    {
      deviceRegistrationAuthorized:
        !cloudProject && (relayTokenPresented(request) || (!config.relayAuthToken && !authActive())),
      privateSession: Boolean(cloudProject),
      noiseSuppression: noiseSuppression.mode === "on",
      ...(recording ? { recording } : {}),
      ...(cloudProject ? { resumeScope: `cloud:${cloudProject.projectId}` } : {}),
      ...(tokenGrant ? { tokenGrant: { userId: tokenGrant.userId, context: tokenGrant.context } } : {}),
      onServerEvent: (payload) => {
        cloudSession?.observe(payload, sessionProvider?.upstreamUsable?.());
        recorder?.event(payload);
        observer?.event(payload);
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
    const usage = meteredSession.close();
    const recorded = recording?.close();
    observer?.end(
      code === 1000 || code === 1005 ? "client" : "disconnected",
      recorded ? { recording: recorded } : undefined
    );
    const endedAt = usage?.endedAt ?? Date.now();
    const billedSeconds = cloudSession?.close(endedAt);
    if (cloudProject && recorder) {
      cloudConversationEnded({
        customerId: cloudProject.customerId,
        projectId: cloudProject.projectId,
        source: cloudProject.source ?? "api",
        sessionId: usageSessionId,
        seconds: usage?.seconds ?? 0,
        endedAt,
        keep: Boolean(runtime?.studio.keepConversations),
        recorder
      });
    }
    if (cloudProject && billedSeconds !== undefined) {
      try {
        // A failed booking is kept and retried by the booking timer below.
        cloudSessionEnded({
          customerId: cloudProject.customerId,
          projectId: cloudProject.projectId,
          sessionId: usageSessionId,
          seconds: billedSeconds,
          endedAt
        });
      } catch (error) {
        sessionLog.error("cloud session could not be charged", {
          projectId: cloudProject.projectId,
          seconds: billedSeconds,
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
  // Peers on the WebRTC transport are sessions like any other.
  clients: () => (webRtc ? [...wss.clients, ...(webRtc.sockets() as unknown as Iterable<WebSocket>)] : wss.clients),
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
// The config the relay starts with is part of its history, also when it was edited by hand.
recordStartupConfig();
// A name in guardrails.checkedTools or checkedResults that is no tool is most likely a tool that is not being checked.
for (const profile of [assistant(), ...assistant().variants.map((variant) => variant.profile)]) {
  const known = new Set([...installedServerTools().map((tool) => tool.name), "transfer_call"]);
  for (const key of ["checkedTools", "checkedResults"] as const) {
    const strangers = (profile.guardrails?.[key] ?? []).filter((name) => !known.has(name));
    if (strangers.length === 0) continue;
    log.warn(
      `${profile.variant ? `variants: ${profile.variant}: ` : ""}guardrails.${key} names ${strangers.join(", ")}, and the relay has no tool of that name right now. Unless it is a tool of your client or of an MCP server that is still connecting, the tool you meant is not checked.`
    );
  }
}
// Summaries of what a user said longer ago, where the config asks for them and there is a model to write them.
setUserMemorySummarizer({
  enabled: () => assistant().conversation.memorySummary,
  summarize: (input) => {
    const model = analysisModelFromEnv();
    if (!model) throw new Error("there is no model for the memory summary");
    return summarizeMemory(input, model);
  }
});
if (assistant().conversation.memorySummary && !analysisModelFromEnv()) {
  log.warn(
    "conversation.memorySummary needs a chat model to write the summaries: set ANALYSIS_LLM_BASE_URL and ANALYSIS_LLM_MODEL, or a chat model for the conversation. Until then older turns wait, up to 48 for a user, and are not summarised."
  );
}
// The same for a tool an agent's onEnter calls: the step would arrive, call nothing and say why.
{
  const installed = installedServerTools();
  const known = new Set(installed.map((tool) => tool.name));
  const later = new Set(installed.filter((tool) => tool.background).map((tool) => tool.name));
  const said = new Set<string>();
  for (const profile of [assistant(), ...assistant().variants.map((variant) => variant.profile)]) {
    for (const agent of profile.agents) {
      for (const key of ["onEnter", "onStart"] as const) {
        const tool = agent[key]?.call?.tool;
        if (!tool || said.has(`${agent.id}:${key}:${tool}`)) continue;
        said.add(`${agent.id}:${key}:${tool}`);
        if (later.has(tool)) {
          log.warn(
            `agents: ${agent.id}: ${key} calls ${tool}, which runs in the background. A step goes by the tool's answer, so the call will not be made: use a tool that answers at once.`
          );
        } else if (!known.has(tool)) {
          log.warn(
            `agents: ${agent.id}: ${key} calls ${tool}, and the relay has no tool of that name right now. Unless it is a tool of your client or of an MCP server that is still connecting, the call will fail.`
          );
        }
      }
    }
  }
}
// Max Cloud sessions a crash or restart left unbooked are charged up to their last checkpoint, and
// bookings that failed are retried: now, and from then on every 15 seconds.
recoverCloudSessions();
// A CLOUD_SECRET_KEY that reads none of the stored customer secrets is logged now, not first on a /ready probe.
cloudReadinessIssues();
const cloudBookingTimer = setInterval(() => {
  if (cloudEnabled()) recoverCloudSessions();
}, 15_000);
cloudBookingTimer.unref();
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
      for (const client of webRtc?.sockets() ?? []) client.terminate();
      for (const client of companionSockets.clients()) client.terminate();
      server.closeAllConnections?.();
    }, 5_000);
    forceTimer.unref();

    // No new calls from here on: nobody would be there when they are answered.
    campaigns.stop();
    for (const client of wss.clients) client.close(1001, "server shutdown");
    for (const client of telephonySockets.clients) client.close(1001, "server shutdown");
    webRtc?.close();
    await companionSockets.close();
    await companionRegistry.close();
    await companionStore.flush();
    await Promise.allSettled([...activeSessions.values()].map((session) => session.close()));
    // No session is left to call a tool: the MCP servers the relay runs itself are stopped with it.
    closeServerTools();
    usageMeter.flush();
    // Conversations that just ended still owe their webhook and their traces.
    await Promise.all([conversations.drain(3_000), projectWebhooks.drain(3_000)]);
    await recordings?.close();
    await campaigns.close();
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
