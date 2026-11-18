// Alipay OpenAPI (v1 gateway, RSA2 public key mode): order-code payment (订单码支付 / 当面付 scan to pay).
//
// Official documentation followed here:
// - alipay.trade.precreate:   https://opendocs.alipay.com/open/05osv9
// - alipay.trade.query:       https://opendocs.alipay.com/open/05osv5
// - alipay.trade.close:       https://opendocs.alipay.com/open/05osv2
// - Async notification:       https://opendocs.alipay.com/open/0c2c19
// - Request signing (自行实现签名): https://opendocs.alipay.com/common/057k53
// - Verification (自行实现验签):   https://opendocs.alipay.com/common/02mse7
// - Optional precreate fields (time_expire, product_code) as defined by Alipay's official Java SDK model:
//   https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/domain/AlipayTradePrecreateModel.java
import { createSign, createVerify } from "node:crypto";
import type { PaidOrder, PaymentProvider, QrOrder } from "./types";
import {
  brief,
  chinaDateTime,
  fenToYuan,
  keyParses,
  loadPrivateKey,
  loadPublicKey,
  REQUEST_TIMEOUT_MS,
  yuanToFen,
  type Env,
  type HttpRequest
} from "./util";

const DEFAULT_GATEWAY = "https://openapi.alipay.com/gateway.do";
/** Product code for 订单码支付 (the current home of QR-code precreate). Legacy 当面付 contracts use FACE_TO_FACE_PAYMENT. */
const DEFAULT_PRODUCT_CODE = "QR_CODE_OFFLINE";
const PAID_STATUSES = new Set(["TRADE_SUCCESS", "TRADE_FINISHED"]);
/** Alipay out_trade_no: up to 64 letters, digits and underscores. */
const OUT_TRADE_NO = /^[A-Za-z0-9_]{1,64}$/;

type AlipayConfig = {
  appId: string;
  privateKey: string;
  publicKey: string;
  gateway: string;
  productCode: string;
};

export type AlipayOptions = {
  /** Read on every call. Defaults to process.env. */
  env?: Env;
  /** Defaults to global fetch. */
  request?: HttpRequest;
  /** Milliseconds since the epoch. Defaults to Date.now. */
  now?: () => number;
};

/** An Alipay business error: carries Alipay's codes and messages, never request data or keys. */
class AlipayError extends Error {
  constructor(
    readonly code: string,
    readonly subCode: string,
    message: string
  ) {
    super(message);
    this.name = "AlipayError";
  }
}

function readConfig(env: Env): AlipayConfig | undefined {
  const appId = env.ALIPAY_APP_ID?.trim() ?? "";
  const privateKey = env.ALIPAY_PRIVATE_KEY ?? "";
  const publicKey = env.ALIPAY_PUBLIC_KEY ?? "";
  if (!appId || !privateKey.trim() || !publicKey.trim()) return undefined;
  return {
    appId,
    privateKey,
    publicKey,
    gateway: env.ALIPAY_GATEWAY?.trim() || DEFAULT_GATEWAY,
    productCode: env.ALIPAY_PRODUCT_CODE?.trim() || DEFAULT_PRODUCT_CODE
  };
}

function isUsable(config: AlipayConfig | undefined): config is AlipayConfig {
  if (!config) return false;
  try {
    if (new URL(config.gateway).protocol !== "https:") return false;
  } catch {
    return false;
  }
  return keyParses(config.privateKey, "private") && keyParses(config.publicKey, "public");
}

/** Sorted `key=value&…` of the given parameters (values as-is, not URL-encoded). */
function signContent(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

/** RSA2 request signature: all non-empty parameters except sign, sorted by name. */
function signRequest(params: Record<string, string>, privateKey: string): string {
  const signed: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key !== "sign" && value.trim() !== "") signed[key] = value;
  }
  return createSign("RSA-SHA256").update(signContent(signed), "utf8").sign(loadPrivateKey(privateKey), "base64");
}

function rsa2Valid(content: string, signature: string, publicKey: string): boolean {
  try {
    return createVerify("RSA-SHA256").update(content, "utf8").verify(loadPublicKey(publicKey), signature, "base64");
  } catch {
    return false;
  }
}

/**
 * The exact raw text of the value of a top-level key in a JSON object, without re-serializing (Alipay signs the
 * response object as the gateway wrote it). Returns undefined when the key is missing or its value is not an object.
 */
function rawTopLevelObject(json: string, key: string): string | undefined {
  let depth = 0;
  let index = 0;
  const length = json.length;
  const skipString = (start: number): number => {
    let at = start + 1;
    while (at < length) {
      const char = json[at];
      if (char === "\\") at += 2;
      else if (char === '"') return at + 1;
      else at += 1;
    }
    return -1;
  };
  while (index < length) {
    const char = json[index];
    if (char === '"') {
      const end = skipString(index);
      if (end < 0) return undefined;
      if (depth === 1) {
        let after = end;
        while (after < length && /\s/.test(json[after] ?? "")) after += 1;
        if (json[after] === ":") {
          let name: unknown;
          try {
            name = JSON.parse(json.slice(index, end));
          } catch {
            return undefined;
          }
          let valueStart = after + 1;
          while (valueStart < length && /\s/.test(json[valueStart] ?? "")) valueStart += 1;
          if (name === key) {
            if (json[valueStart] !== "{") return undefined;
            // Scan to the matching closing brace, honouring strings.
            let inner = 0;
            let at = valueStart;
            while (at < length) {
              const c = json[at];
              if (c === '"') {
                at = skipString(at);
                if (at < 0) return undefined;
                continue;
              }
              if (c === "{" || c === "[") inner += 1;
              else if (c === "}" || c === "]") {
                inner -= 1;
                if (inner === 0) return json.slice(valueStart, at + 1);
              }
              at += 1;
            }
            return undefined;
          }
          index = valueStart;
          continue;
        }
      }
      index = end;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    index += 1;
  }
  return undefined;
}

type GatewayResult = Record<string, unknown> & { code?: unknown; sub_code?: unknown; msg?: unknown; sub_msg?: unknown };

function alipayError(result: GatewayResult): AlipayError {
  const code = typeof result.code === "string" ? brief(result.code, 16) : "";
  const subCode = typeof result.sub_code === "string" ? brief(result.sub_code, 80) : "";
  const message = brief(typeof result.sub_msg === "string" ? result.sub_msg : result.msg);
  return new AlipayError(code, subCode, `Alipay ${code}${subCode ? ` ${subCode}` : ""}: ${message}`);
}

export function createAlipay(options: AlipayOptions = {}): PaymentProvider {
  const env = options.env ?? process.env;
  const request: HttpRequest = options.request ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;

  function config(): AlipayConfig {
    const current = readConfig(env);
    if (!isUsable(current)) throw new Error("Alipay is not configured");
    return current;
  }

  /**
   * Calls a gateway method and returns its verified `<method>_response` object. Throws AlipayError when the code is
   * not 10000, and a plain Error when the response is unsigned or its signature does not verify.
   */
  async function call(method: string, bizContent: Record<string, unknown>, notifyUrl?: string): Promise<GatewayResult> {
    const current = config();
    const params: Record<string, string> = {
      app_id: current.appId,
      method,
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: chinaDateTime(now()),
      version: "1.0"
    };
    if (notifyUrl) params.notify_url = notifyUrl;
    const bizJson = JSON.stringify(bizContent);
    const sign = signRequest({ ...params, biz_content: bizJson }, current.privateKey);
    // The docs ask for platform parameters (charset in particular) in the query and biz_content in the form body.
    const query = Object.entries({ ...params, sign })
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    const separator = current.gateway.includes("?") ? "&" : "?";
    const response = await request(`${current.gateway}${separator}${query}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        Accept: "application/json"
      },
      body: `biz_content=${encodeURIComponent(bizJson)}`,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Alipay gateway HTTP ${response.status}`);
    let parsed: { sign?: unknown } & Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error("Alipay gateway answered with something other than JSON");
    }
    if (typeof parsed !== "object" || parsed === null) throw new Error("Alipay gateway answered with unexpected JSON");
    const responseKey = `${method.replace(/\./g, "_")}_response`;
    const signedKey = responseKey in parsed ? responseKey : "error_response";
    const raw = rawTopLevelObject(text, signedKey);
    if (raw === undefined) throw new Error(`Alipay response has no ${responseKey}`);
    const result = JSON.parse(raw) as GatewayResult;
    const signature = typeof parsed.sign === "string" ? parsed.sign : "";
    if (!signature) {
      if (result.code !== "10000") throw alipayError(result);
      throw new Error("Alipay response is not signed");
    }
    // Verify over the raw text; the docs suggest retrying with "/" escaped as "\/" when the first try fails.
    const valid =
      rsa2Valid(raw, signature, current.publicKey) ||
      rsa2Valid(raw.replace(/(?<!\\)\//g, "\\/"), signature, current.publicKey);
    if (!valid) throw new Error("Alipay response signature is invalid");
    if (result.code !== "10000") throw alipayError(result);
    return result;
  }

  function requireOrderId(orderId: string): string {
    if (!OUT_TRADE_NO.test(orderId)) throw new Error("Alipay order ids must be 1-64 letters, digits or _");
    return orderId;
  }

  return {
    id: "alipay",

    configured() {
      return isUsable(readConfig(env));
    },

    async createQrOrder(order: QrOrder) {
      const current = config();
      requireOrderId(order.orderId);
      if (!Number.isSafeInteger(order.amountFen) || order.amountFen <= 0) throw new Error("Invalid order amount");
      // subject is string(256) and must not contain special characters such as / = &.
      const subject = Array.from(order.description.replace(/[/=&]/g, " ").trim()).slice(0, 256).join("");
      const result = await call(
        "alipay.trade.precreate",
        {
          out_trade_no: order.orderId,
          total_amount: fenToYuan(order.amountFen),
          subject: subject || order.orderId,
          product_code: current.productCode,
          time_expire: chinaDateTime(order.expiresAt)
        },
        order.notifyUrl
      );
      if (typeof result.qr_code !== "string" || !result.qr_code) throw new Error("Alipay returned no qr_code");
      return { qrCode: result.qr_code };
    },

    async parseNotification({ rawBody }) {
      try {
        const current = readConfig(env);
        if (!isUsable(current)) return null;
        const form = new URLSearchParams(rawBody);
        const params: Record<string, string> = {};
        for (const [key, value] of form) {
          if (Object.hasOwn(params, key)) return null; // Repeated parameters are never legitimate.
          params[key] = value;
        }
        const signature = params.sign;
        if (!signature) return null;
        if (params.sign_type !== undefined && params.sign_type !== "RSA2") return null;
        // Every parameter except sign and sign_type, URL-decoded, sorted by name, joined as k=v&…
        const signed: Record<string, string> = {};
        for (const [key, value] of Object.entries(params)) {
          if (key !== "sign" && key !== "sign_type") signed[key] = value;
        }
        if (!rsa2Valid(signContent(signed), signature, current.publicKey)) return null;
        if (params.app_id !== current.appId) return null;
        if (!PAID_STATUSES.has(params.trade_status ?? "")) return null;
        const orderId = params.out_trade_no;
        const providerTxnId = params.trade_no;
        const amountFen = yuanToFen(params.total_amount ?? "");
        if (!orderId || !providerTxnId || amountFen === null || amountFen <= 0) return null;
        return { orderId, providerTxnId, amountFen };
      } catch {
        return null;
      }
    },

    notificationAnswer(accepted: boolean) {
      // Alipay stops retrying only on the exact text "success"; "fail" (or anything else) makes it retry.
      return { status: 200, contentType: "text/plain", body: accepted ? "success" : "fail" };
    },

    async queryOrder(orderId: string): Promise<PaidOrder | null> {
      let result: GatewayResult;
      try {
        result = await call("alipay.trade.query", { out_trade_no: requireOrderId(orderId) });
      } catch (error) {
        // A precreated order exists at Alipay only once the customer scans it.
        if (error instanceof AlipayError && error.subCode === "ACQ.TRADE_NOT_EXIST") return null;
        throw error;
      }
      if (!PAID_STATUSES.has(typeof result.trade_status === "string" ? result.trade_status : "")) return null;
      if (result.out_trade_no !== orderId || typeof result.trade_no !== "string" || !result.trade_no) return null;
      const amountFen = typeof result.total_amount === "string" ? yuanToFen(result.total_amount) : null;
      if (amountFen === null || amountFen <= 0) return null;
      return { orderId, providerTxnId: result.trade_no, amountFen };
    },

    async closeOrder(orderId: string) {
      try {
        await call("alipay.trade.close", { out_trade_no: requireOrderId(orderId) });
      } catch (error) {
        // Never scanned: nothing to close at Alipay.
        if (error instanceof AlipayError && error.subCode === "ACQ.TRADE_NOT_EXIST") return;
        throw error;
      }
    }
  };
}
