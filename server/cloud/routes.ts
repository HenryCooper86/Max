// HTTP surface of Max Cloud: the JSON console API under /cloud/api and the
// payment notification routes under /cloud/pay. Handlers stay thin; the work
// is in customers.ts, topups.ts and store.ts.

import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { checkAuthRateLimit, clientAddress } from "../auth";
import { createLogger } from "../logger";
import { PACKS } from "./billing";
import { cloudEnabled, cloudPaymentProvider, cloudPaymentProviders, now } from "./context";
import {
  createProject,
  customerForToken,
  deleteProject,
  listProjects,
  login,
  logout,
  patchProject,
  publicCustomer,
  rotateProjectKey,
  signup,
  type Result
} from "./customers";
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
  if (!checkAuthRateLimit(clientAddress(req))) {
    res.status(429).json({ ok: false, error: "Too many attempts. Try again in a minute." });
    return;
  }
  next();
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
    handle(async (req, res) => send(res, await login(body(req).email, body(req).password)))
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
    handle(async (req, res) => send(res, await createTopup(customerOf(res).id, body(req)), 201))
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

// --- payments ---------------------------------------------------------------------

const rawNotificationBody = express.raw({ type: "*/*", limit: "64kb" });

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
