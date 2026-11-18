// The "your backend" half of the example, with no dependencies:
//   GET  /                     the shop page with the voice widget
//   POST /api/voice-token      mints a short-lived session token from the relay
//   POST /tools/order-status   a webhook tool the relay calls
//
//   RELAY_URL=http://localhost:8787 RELAY_AUTH_TOKEN=... TOOL_WEBHOOK_SECRET=... node server.mjs
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 3000);
const RELAY_URL = (process.env.RELAY_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const RELAY_AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN ?? "";
const TOOL_WEBHOOK_SECRET = process.env.TOOL_WEBHOOK_SECRET ?? "";

const ORDERS = {
  "A-1042": { status: "shipped", carrier: "UPS", estimatedDelivery: "Friday" },
  "A-1043": { status: "processing", estimatedShipDate: "tomorrow" }
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Checks x-voice-agent-signature: sha256=HMAC(secret, `${timestamp}.${body}`), at most 5 minutes old. */
function signatureValid(req, body) {
  if (!TOOL_WEBHOOK_SECRET) return true;
  const timestamp = String(req.headers["x-voice-agent-timestamp"] ?? "");
  const signature = String(req.headers["x-voice-agent-signature"] ?? "");
  if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false;
  const expected = `sha256=${createHmac("sha256", TOOL_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex")}`;
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      const page = (await readFile(new URL("./index.html", import.meta.url), "utf8")).replaceAll(
        "__RELAY_URL__",
        RELAY_URL
      );
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }

    if (req.method === "POST" && req.url === "/api/voice-token") {
      // In a real app: check the user's own session here, and pass their id.
      const response = await fetch(`${RELAY_URL}/v1/session-tokens`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(RELAY_AUTH_TOKEN ? { authorization: `Bearer ${RELAY_AUTH_TOKEN}` } : {})
        },
        body: JSON.stringify({
          ttlSeconds: 600,
          userId: "demo-shopper",
          context: "Signed-in shopper: Sam (loyalty tier: gold)."
        })
      });
      json(res, response.status, await response.json());
      return;
    }

    if (req.method === "POST" && req.url === "/tools/order-status") {
      const body = await readBody(req);
      if (!signatureValid(req, body)) return json(res, 401, { error: "bad signature" });
      const { arguments: args } = JSON.parse(body);
      const order = ORDERS[String(args?.orderId ?? "").toUpperCase()];
      if (!order) return json(res, 404, { error: `No order ${args?.orderId}. Ask the shopper to check the number.` });
      return json(res, 200, { orderId: args.orderId, ...order });
    }

    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, () => console.log(`Shop on http://localhost:${PORT} (relay ${RELAY_URL})`));
