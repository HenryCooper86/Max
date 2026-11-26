// HTTP surface of Max Cloud: the JSON console API under /cloud/api and the
// payment notification routes under /cloud/pay. Handlers stay thin; the work
// is in customers.ts, topups.ts and store.ts.

import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { checkAuthRateLimit, clientAddress, withLoginBackoff } from "../auth";
import { createLogger } from "../logger";
import { PACKS } from "./billing";
import { cloudEnabled, cloudPaymentProvider, cloudPaymentProviders, now } from "./context";
import { flowFrom } from "../flow";
import { projectWebhooks } from "./conversation-webhook";
import { projectTraces } from "./traces";
import { listConversations, readConversation } from "./conversations";
import {
  createProject,
  customerForToken,
  deleteProject,
  listProjects,
  login,
  logout,
  patchProject,
  projectStudioReadable,
  projectStudio,
  projectTracesHeaders,
  projectWebhookSecret,
  publicCustomer,
  revealWebhookSecret,
  rotateProjectKey,
  rotateWebhookSecret,
  signup,
  type Result
} from "./customers";
import {
  draftRevisionProject,
  studioRelease,
  saveStudioDraft,
  publishStudioRevision,
  restoreStudioRevision
} from "./revisions";
import {
  createReplayCase,
  listReplayCases,
  updateReplayCase,
  deleteReplayCase,
  readReplayCase,
  recordReplayOutcome
} from "./replay-cases";
import { runDraftReplay } from "./replay-runner";
import { mintEmbedSession, mintTestSession } from "./sessions";
import { liveProject, readStudioLiveRevision } from "./store";
import { testProjectTool } from "./tools";
import { customerFunds, ledgerEntries, usageSummary, type CustomerRow } from "./store";
import { creditAccepted, creditPaidOrder, createTopup, readOrder, topupStatus, validOrderId } from "./topups";

const log = createLogger("cloud");

const NOT_CONFIGURED = "Max Cloud is not configured";
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const LEDGER_LIMIT = 100;

type Handler = (req: Request, res: Response) => void | Promise<void>;

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  next();
}

function requireEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!cloudEnabled()) {
    res.status(503).json({ ok: false, error: NOT_CONFIGURED });
    return;
  }
  next();
}

/** Runs a handler; an unexpected failure becomes a plain 500 with nothing internal in it. */
function handle(handler: Handler) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      log.error("cloud request failed", {
        path: req.path,
        message: error instanceof Error ? error.message : String(error)
      });
      if (!res.headersSent) res.status(500).json({ ok: false, error: "Something went wrong. Try again." });
    }
  };
}

function send<T>(res: Response, result: Result<T>, status = 200): void {
  if (!result.ok) {
    res.status(result.status).json({ ok: false, error: result.error });
    return;
  }
  res.status(status).json(result.value);
}

function body(req: Request): Record<string, unknown> {
  const value: unknown = req.body;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function bearerToken(req: Request): string {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
  return match?.[1] ?? "";
}

function rateLimited(req: Request, res: Response, next: NextFunction): void {
  if (!checkAuthRateLimit(clientAddress(req), Date.now(), "cloud-auth")) {
    res.status(429).json({ ok: false, error: "Too many attempts. Try again in a minute." });
    return;
  }
  next();
}

/**
 * Top-up orders a customer may start in a minute. Each is a call on the
 * payment provider's API, so a customer whose provider keeps failing cannot
 * retry without end.
 */
const TOPUPS_PER_MINUTE_PER_CUSTOMER = 10;
/** The same from one address, for all of its customers. */
const TOPUPS_PER_MINUTE_PER_ADDRESS = 60;

/** Whether the signed-in customer may start another top-up order now. */
function topupAllowed(req: Request, customerId: string): boolean {
  const at = Date.now();
  return (
    checkAuthRateLimit(`customer:${customerId}`, at, "cloud-topup", TOPUPS_PER_MINUTE_PER_CUSTOMER) &&
    checkAuthRateLimit(clientAddress(req), at, "cloud-topup", TOPUPS_PER_MINUTE_PER_ADDRESS)
  );
}

function requireCustomer(req: Request, res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  const customer = token ? customerForToken(token) : undefined;
  if (!customer) {
    res.status(401).json({ ok: false, error: "Log in to continue." });
    return;
  }
  res.locals.cloudCustomer = customer;
  res.locals.cloudToken = token;
  next();
}

function customerOf(res: Response): CustomerRow {
  return res.locals.cloudCustomer as CustomerRow;
}

function param(req: Request, name: string): string {
  const value: unknown = req.params[name];
  return typeof value === "string" ? value : "";
}

/** JSON API under /cloud/api. Call after express.json(). */
export function registerCloudRoutes(app: express.Express): void {
  const api = express.Router();
  api.use(noStore, requireEnabled);

  api.get("/packs", (_req, res) => {
    res.json({
      packs: PACKS.map((pack) => ({ id: pack.id, fen: pack.fen })),
      providers: cloudPaymentProviders().map((provider) => provider.id)
    });
  });

  api.post(
    "/signup",
    rateLimited,
    handle(async (req, res) => send(res, await signup(body(req).email, body(req).password, body(req).invite), 201))
  );
  api.post(
    "/login",
    rateLimited,
    handle(async (req, res) => {
      const outcome = await withLoginBackoff("cloud", body(req).email, clientAddress(req), () =>
        login(body(req).email, body(req).password)
      );
      if (outcome.locked) {
        res.setHeader("Retry-After", String(outcome.retryAfterSeconds));
        res.status(429).json({ ok: false, error: "Too many attempts. Try again in a minute." });
        return;
      }
      send(res, outcome.result);
    })
  );

  api.use(requireCustomer);

  api.post(
    "/logout",
    handle((_req, res) => {
      logout(res.locals.cloudToken as string);
      res.json({ ok: true });
    })
  );

  api.get(
    "/me",
    handle((_req, res) => {
      const customer = customerOf(res);
      res.json({ customer: publicCustomer(customer), balance: customerFunds(customer.id, now()) });
    })
  );

  api.get(
    "/projects",
    handle((_req, res) => {
      res.json({ projects: listProjects(customerOf(res).id) });
    })
  );
  api.post(
    "/projects",
    handle((req, res) => send(res, createProject(customerOf(res).id, body(req)), 201))
  );
  api.patch(
    "/projects/:id",
    handle((req, res) => send(res, patchProject(customerOf(res).id, param(req, "id"), body(req))))
  );
  api.post(
    "/projects/:id/rotate-key",
    handle((req, res) => send(res, rotateProjectKey(customerOf(res).id, param(req, "id"))))
  );
  api.delete(
    "/projects/:id",
    handle((req, res) => send(res, deleteProject(customerOf(res).id, param(req, "id"))))
  );
  api.get(
    "/projects/:id/release",
    handle((req, res) => send(res, studioRelease(customerOf(res).id, param(req, "id"))))
  );
  api.put(
    "/projects/:id/draft",
    handle((req, res) => send(res, saveStudioDraft(customerOf(res).id, param(req, "id"), body(req))))
  );
  api.post(
    "/projects/:id/publish",
    handle((req, res) => send(res, publishStudioRevision(customerOf(res).id, param(req, "id"), body(req))))
  );
  api.post(
    "/projects/:id/restore",
    handle((req, res) => send(res, restoreStudioRevision(customerOf(res).id, param(req, "id"), body(req))))
  );

  const replayCases = "/projects/:id/replay-cases";
  const replayCase = replayCases + "/:caseId";
  api.get(
    replayCases,
    handle((req, res) => send(res, listReplayCases(customerOf(res).id, param(req, "id"))))
  );
  api.post(
    replayCases,
    handle((req, res) => send(res, createReplayCase(customerOf(res).id, param(req, "id"), body(req)), 201))
  );
  api.put(
    replayCase,
    handle((req, res) =>
      send(res, updateReplayCase(customerOf(res).id, param(req, "id"), param(req, "caseId"), body(req)))
    )
  );
  api.delete(
    replayCase,
    handle((req, res) =>
      send(res, deleteReplayCase(customerOf(res).id, param(req, "id"), param(req, "caseId"), body(req).version))
    )
  );
  api.post(
    replayCase + "/run",
    handle(async (req, res) => {
      const customerId = customerOf(res).id;
      const projectId = param(req, "id");
      const { revision, version } = body(req);
      const caseId = param(req, "caseId");
      const saved = readReplayCase(customerId, projectId, caseId, version);
      if (!saved.ok) return send(res, saved);
      if (typeof revision !== "string" || !revision.trim()) {
        res.status(400).json({ ok: false, error: "Choose a saved draft revision to replay." });
        return;
      }
      const disconnect = new AbortController();
      const abort = () => disconnect.abort();
      res.once("close", abort);
      try {
        const result = await runDraftReplay(customerId, projectId, revision, saved.value.testCase, disconnect.signal);
        if (res.destroyed) return;
        if (result.ok || [422, 502, 504].includes(result.status)) {
          const { testCase } = saved.value;
          const recorded = recordReplayOutcome(
            customerId,
            projectId,
            revision,
            testCase,
            result.ok
              ? {
                  status: result.value.run.passed ? "passed" : "failed",
                  answer: result.value.run.answer,
                  missingTools: result.value.run.tools.filter((t) => !t.mocked).map((t) => t.name)
                }
              : { status: "error", message: result.error }
          );
          if (!recorded.ok) return send(res, recorded);
        }
        send(res, result);
      } finally {
        res.off("close", abort);
      }
    })
  );

  function projectForProbe(req: Request, res: Response) {
    const revision = body(req).revision;
    const projectId = param(req, "id");
    const owner = customerOf(res).id;
    if (revision === undefined) return liveProject(projectId, owner);
    return typeof revision === "string"
      ? (draftRevisionProject(owner, projectId, revision) ?? readStudioLiveRevision(projectId, owner, revision))
      : undefined;
  }

  // The console's Test panel: a short-lived session token for the owner.
  api.post(
    "/projects/:id/test-session",
    handle((req, res) => {
      const { revision, expectedLiveRevision } = body(req);
      if (
        (revision !== undefined && (typeof revision !== "string" || !revision)) ||
        (expectedLiveRevision !== undefined &&
          (typeof expectedLiveRevision !== "string" || !expectedLiveRevision || revision !== undefined))
      ) {
        res.status(400).json({ ok: false, error: "Provide one valid revision ID." });
        return;
      }
      send(res, mintTestSession(customerOf(res).id, param(req, "id"), revision, expectedLiveRevision), 201);
    })
  );
  // "Send test request" for one saved tool, with sample arguments.
  api.post(
    "/projects/:id/tools/test",
    handle(async (req, res) => {
      const row = projectForProbe(req, res);
      if (!row) {
        res.status(404).json({ ok: false, error: "Project not found." });
        return;
      }
      if (!checkAuthRateLimit(`project:${row.id}`, Date.now(), "tool-test")) {
        res.status(429).json({ ok: false, error: "Too many test requests. Try again in a minute." });
        return;
      }
      const input = body(req);
      const args = input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments);
      res.json(
        await testProjectTool(
          projectStudio(row),
          projectWebhookSecret(row),
          typeof input.name === "string" ? input.name : "",
          args ? (input.arguments as Record<string, unknown>) : {}
        )
      );
    })
  );
  // The flow builder: the project's flow as steps, the starting step first, and the tools a step can name.
  const flowOf = (row: Parameters<typeof projectStudio>[0]) => {
    const studio = projectStudio(row);
    return { ok: true, ...flowFrom(studio.flow), tools: studio.tools.map((tool) => tool.name).sort() };
  };
  api.get(
    "/projects/:id/flow",
    handle((req, res) => {
      const row = liveProject(param(req, "id"), customerOf(res).id);
      if (!row) {
        res.status(404).json({ error: "Project not found." });
        return;
      }
      res.json(flowOf(row));
    })
  );
  api.put(
    "/projects/:id/flow",
    handle((req, res) => {
      const customer = customerOf(res);
      const row = liveProject(param(req, "id"), customer.id);
      if (!row) {
        res.status(404).json({ error: "Project not found." });
        return;
      }
      const steps = body(req).steps;
      if (!Array.isArray(steps)) {
        res.status(400).json({ error: "The flow must be a list of steps." });
        return;
      }
      // What is stored is written back with the flow: not when it can no longer be read as it was saved.
      if (!projectStudioReadable(row)) {
        res.status(409).json({
          error: "This project's settings have to be saved again in the Studio before its flow can be changed."
        });
        return;
      }
      // Saved like any other setting, with the rest of the project's settings as they are.
      const saved = patchProject(customer.id, row.id, { studio: { ...projectStudio(row), flow: steps } });
      if (!saved.ok) {
        send(res, saved);
        return;
      }
      const after = liveProject(row.id, customer.id);
      res.json({ ...(after ? flowOf(after) : { ok: true, steps: [], problems: [], tools: [] }), ...saved.value });
    })
  );
  // The conversation webhook: how the last delivery went, and one test request to the saved address.
  api.get(
    "/projects/:id/conversation-webhook",
    handle((req, res) => {
      const row = liveProject(param(req, "id"), customerOf(res).id);
      if (!row) {
        res.status(404).json({ error: "Project not found." });
        return;
      }
      res.json({ url: projectStudio(row).conversationWebhook, last: projectWebhooks.last(row.id) ?? null });
    })
  );
  api.post(
    "/projects/:id/conversation-webhook/test",
    handle(async (req, res) => {
      const row = projectForProbe(req, res);
      if (!row) {
        res.status(404).json({ ok: false, error: "Project not found." });
        return;
      }
      const url = projectStudio(row).conversationWebhook;
      if (!url) {
        res.status(400).json({ ok: false, error: "Save the address first." });
        return;
      }
      if (!checkAuthRateLimit(`project:${row.id}`, Date.now(), "tool-test")) {
        res.status(429).json({ ok: false, error: "Too many test requests. Try again in a minute." });
        return;
      }
      res.json(await projectWebhooks.test({ projectId: row.id, url, secret: projectWebhookSecret(row) }));
    })
  );
  // The traces collector: one sample trace to the saved endpoint, with the saved headers.
  api.post(
    "/projects/:id/traces-test",
    handle(async (req, res) => {
      const row = projectForProbe(req, res);
      if (!row) {
        res.status(404).json({ ok: false, error: "Project not found." });
        return;
      }
      const endpoint = projectStudio(row).traces.endpoint;
      if (!endpoint) {
        res.status(400).json({ ok: false, error: "Save the endpoint first." });
        return;
      }
      if (!checkAuthRateLimit(`project:${row.id}`, Date.now(), "tool-test")) {
        res.status(429).json({ ok: false, error: "Too many test requests. Try again in a minute." });
        return;
      }
      const { headers, unreadable } = projectTracesHeaders(row);
      if (unreadable) {
        res.json({ ok: false, error: "The saved headers cannot be read: enter them again and save." });
        return;
      }
      res.json(await projectTraces.test({ name: row.name, endpoint, ...(headers ? { headers } : {}) }));
    })
  );
  api.get(
    "/projects/:id/webhook-secret",
    handle((req, res) => send(res, revealWebhookSecret(customerOf(res).id, param(req, "id"))))
  );
  api.post(
    "/projects/:id/webhook-secret/rotate",
    handle((req, res) => send(res, rotateWebhookSecret(customerOf(res).id, param(req, "id"))))
  );
  api.get(
    "/projects/:id/conversations",
    handle((req, res) => send(res, listConversations(customerOf(res).id, param(req, "id"))))
  );
  api.get(
    "/conversations/:id",
    handle((req, res) => send(res, readConversation(customerOf(res).id, param(req, "id"))))
  );

  api.get(
    "/usage",
    handle((req, res) => {
      const requested = req.query.month;
      const month = requested === undefined ? new Date(now()).toISOString().slice(0, 7) : requested;
      if (typeof month !== "string" || !MONTH.test(month)) {
        res.status(400).json({ ok: false, error: "month must look like 2026-11." });
        return;
      }
      const summary = usageSummary(customerOf(res).id, month);
      res.json({ month, ...summary, minutes: Math.round((summary.seconds / 60) * 100) / 100 });
    })
  );

  api.get(
    "/ledger",
    handle((_req, res) => {
      const entries = ledgerEntries(customerOf(res).id, LEDGER_LIMIT).map((row) => ({
        id: row.id,
        kind: row.kind,
        amountFen: row.amount_fen,
        seconds: row.seconds,
        ...(row.project_id ? { projectId: row.project_id } : {}),
        ...(row.ref ? { ref: row.ref } : {}),
        createdAt: row.created_at
      }));
      res.json({ entries });
    })
  );

  api.post(
    "/topups",
    handle(async (req, res) => {
      if (!topupAllowed(req, customerOf(res).id)) {
        res.status(429).json({ ok: false, error: "Too many top-up attempts. Try again in a minute." });
        return;
      }
      send(res, await createTopup(customerOf(res).id, body(req)), 201);
    })
  );
  api.get(
    "/topups/:orderId",
    handle(async (req, res) => send(res, await topupStatus(customerOf(res).id, param(req, "orderId"))))
  );

  app.use("/cloud/api", api);
  // Unknown /cloud addresses stay JSON, never the web app's HTML fallback.
  app.use("/cloud", noStore, requireEnabled, (_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: "Not found." });
  });
}

// --- public embed -------------------------------------------------------------------

/**
 * POST /v1/public-session-tokens {"project":"pub_…"}: a session token for the
 * widget on a website the project's owner listed. Called by browsers on other
 * sites, so it answers CORS for whichever site asks; only a listed site gets
 * a token, and the token opens a session from that site only.
 */
export function registerEmbedRoutes(app: express.Express): void {
  const path = "/v1/public-session-tokens";
  const cors = (req: Request, res: Response) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin.length < 300) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Cache-Control", "no-store");
  };
  app.options(path, (req, res) => {
    cors(req, res);
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Max-Age", "600");
    res.status(204).end();
  });
  app.post(
    path,
    handle((req, res) => {
      cors(req, res);
      if (!cloudEnabled()) {
        res.status(503).json({ ok: false, error: NOT_CONFIGURED });
        return;
      }
      send(
        res,
        mintEmbedSession({ publicId: body(req).project, origin: req.headers.origin, address: clientAddress(req) }),
        201
      );
    })
  );
}

// --- payments ---------------------------------------------------------------------

/**
 * The most a payment notification may weigh. A WeChat Pay one is an envelope
 * round an encrypted transaction of a dozen fields (about 2 KB, its
 * documentation's example included), and an Alipay one a form of about twenty
 * parameters whose documented lengths add up to a few KB. Five times that
 * leaves room for what the providers add; anything larger is not a
 * notification. One that were larger is answered as refused, and the payment
 * is still credited through the provider's query API (topups.ts).
 */
const NOTIFICATION_BODY_LIMIT = "16kb";
/**
 * Payment notifications one address may send in a minute. The providers send
 * one per paid order, and retry from a few addresses (docs/cloud.md).
 */
const NOTIFICATIONS_PER_MINUTE = 600;
const rawNotificationBody = express.raw({ type: "*/*", limit: NOTIFICATION_BODY_LIMIT });

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function testPage(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${content}
</body>
</html>
`;
}

/** Payment notification routes under /cloud/pay. They need the raw body: call BEFORE express.json(). */
export function registerCloudPaymentRoutes(app: express.Express): void {
  // Mounted before express.json(), so even a /cloud/api request whose JSON
  // body is rejected there is answered uncached, and 503 while Cloud is off.
  app.use("/cloud", noStore, requireEnabled);
  const pay = express.Router();
  pay.use(noStore, requireEnabled);

  // Never throws: whatever happens, the provider gets the answer its protocol expects.
  pay.post("/:provider/notify", (req, res) => {
    const provider = cloudPaymentProvider(param(req, "provider"));
    if (!provider) {
      res.status(404).json({ ok: false, error: "Not found." });
      return;
    }
    const answer = (accepted: boolean) => {
      try {
        const reply = provider.notificationAnswer(accepted);
        res.status(reply.status).setHeader("Content-Type", reply.contentType);
        res.send(reply.body);
      } catch {
        if (!res.headersSent) res.status(accepted ? 200 : 500).end();
      }
    };
    // Counted before the body is read, so a flood from one address costs one short answer per request and no
    // verification. It gets the answer of a refused notification, which both providers send again later.
    if (!checkAuthRateLimit(clientAddress(req), Date.now(), "cloud-pay-notify", NOTIFICATIONS_PER_MINUTE)) {
      log.warn("payment notification refused: too many from one address", { provider: provider.id });
      answer(false);
      return;
    }
    rawNotificationBody(req, res, (parseError?: unknown) => {
      if (parseError) {
        log.warn("payment notification unreadable", { provider: provider.id });
        answer(false);
        return;
      }
      void (async () => {
        let accepted = false;
        try {
          const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
          const paid = await provider.parseNotification({ headers: req.headers, rawBody });
          if (paid) accepted = creditAccepted(creditPaidOrder(paid, provider.id));
          else log.warn("payment notification refused", { provider: provider.id });
        } catch (error) {
          log.warn("payment notification failed", {
            provider: provider.id,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        answer(accepted);
      })();
    });
  });

  // The test provider's "QR code" leads here (development only: the provider
  // exists only with CLOUD_PAYMENTS_TEST=on outside production).
  pay.get(
    "/test/:orderId",
    handle((req, res) => {
      const orderId = param(req, "orderId");
      const order = cloudPaymentProvider("test") && validOrderId(orderId) ? readOrder(orderId) : undefined;
      if (!order || order.provider !== "test") {
        res.status(404).type("html").send(testPage("Order not found", "<p>There is no such test order.</p>"));
        return;
      }
      const amount = `¥${(order.amount_fen / 100).toFixed(2)}`;
      const form =
        order.status === "pending"
          ? `<form method="post"><button type="submit">Mark as paid</button></form>`
          : `<p>This order is ${escapeHtml(order.status)}.</p>`;
      res
        .type("html")
        .send(testPage("Max Cloud test payment", `<p>Order ${escapeHtml(order.id)}: ${escapeHtml(amount)}</p>${form}`));
    })
  );

  pay.post(
    "/test/:orderId",
    handle((req, res) => {
      const orderId = param(req, "orderId");
      const order = cloudPaymentProvider("test") && validOrderId(orderId) ? readOrder(orderId) : undefined;
      if (!order || order.provider !== "test") {
        res.status(404).json({ ok: false, error: "Order not found." });
        return;
      }
      if (order.status === "closed") {
        res.status(409).json({ ok: false, error: "This order has expired." });
        return;
      }
      if (order.status === "pending") {
        const paid = {
          orderId: order.id,
          providerTxnId: `test_${randomBytes(8).toString("hex")}`,
          amountFen: order.amount_fen
        };
        if (!creditAccepted(creditPaidOrder(paid, "test"))) {
          res.status(409).json({ ok: false, error: "The order could not be paid." });
          return;
        }
      }
      if (req.accepts(["json", "html"]) === "html") {
        res.redirect(303, `/cloud/pay/test/${order.id}`);
        return;
      }
      res.json({ ok: true, status: "paid" });
    })
  );

  app.use("/cloud/pay", pay);
}
