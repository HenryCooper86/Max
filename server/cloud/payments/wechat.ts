// WeChat Pay API v3, Native payment (scan a QR code), in WeChat Pay public key mode (微信支付公钥).
//
// Official documentation followed here:
// - Native order:           https://pay.weixin.qq.com/doc/v3/merchant/4012791877  (POST /v3/pay/transactions/native)
// - Query by out_trade_no:  https://pay.weixin.qq.com/doc/v3/merchant/4012791880  (GET .../out-trade-no/{id}?mchid=)
// - Close order:            https://pay.weixin.qq.com/doc/v3/merchant/4012791881  (POST .../out-trade-no/{id}/close)
// - Payment notification:   https://pay.weixin.qq.com/doc/v3/merchant/4012791882
// - Signing overview:       https://pay.weixin.qq.com/doc/v3/merchant/4012365342
// - Request signature:      https://pay.weixin.qq.com/doc/v3/merchant/4012365336
// - Verify with public key: https://pay.weixin.qq.com/doc/v3/merchant/4013053249
import { createDecipheriv, createSign, createVerify, randomBytes } from "node:crypto";
import type { PaidOrder, PaymentProvider, QrOrder } from "./types";
import {
  brief,
  chinaRfc3339,
  headerValue,
  keyParses,
  loadPrivateKey,
  loadPublicKey,
  REQUEST_TIMEOUT_MS,
  type Env,
  type HttpRequest
} from "./util";

const API_ORIGIN = "https://api.mch.weixin.qq.com";
/** Notifications and responses whose Wechatpay-Timestamp is further than this from our clock are refused. */
const MAX_CLOCK_SKEW_SECONDS = 300;
/** WeChat Pay out_trade_no: 6-32 characters of letters, digits, "_", "-", "|", "*". */
const OUT_TRADE_NO = /^[A-Za-z0-9_\-|*]{6,32}$/;

type WechatConfig = {
  mchid: string;
  appid: string;
  certSerial: string;
  privateKey: string;
  apiV3Key: string;
  publicKey: string;
  publicKeyId: string;
};

export type WechatPayOptions = {
  /** Read on every call. Defaults to process.env. */
  env?: Env;
  /** Defaults to global fetch. */
  request?: HttpRequest;
  /** Milliseconds since the epoch. Defaults to Date.now. */
  now?: () => number;
};

/** A WeChat Pay API error: carries WeChat's code and message, never request data or keys. */
class WechatPayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "WechatPayError";
  }
}

function readConfig(env: Env): WechatConfig | undefined {
  const config = {
    mchid: env.WECHATPAY_MCHID?.trim() ?? "",
    appid: env.WECHATPAY_APPID?.trim() ?? "",
    certSerial: env.WECHATPAY_CERT_SERIAL?.trim() ?? "",
    privateKey: env.WECHATPAY_PRIVATE_KEY ?? "",
    apiV3Key: env.WECHATPAY_API_V3_KEY?.trim() ?? "",
    publicKey: env.WECHATPAY_PUBLIC_KEY ?? "",
    publicKeyId: env.WECHATPAY_PUBLIC_KEY_ID?.trim() ?? ""
  };
  if (Object.values(config).some((value) => !value.trim())) return undefined;
  return config;
}

function isUsable(config: WechatConfig | undefined): config is WechatConfig {
  return (
    config !== undefined &&
    Buffer.byteLength(config.apiV3Key, "utf8") === 32 &&
    config.publicKeyId.startsWith("PUB_KEY_ID_") &&
    keyParses(config.privateKey, "private") &&
    keyParses(config.publicKey, "public")
  );
}

/** `METHOD\nPATH?QUERY\nTIMESTAMP\nNONCE\nBODY\n`, signed SHA256withRSA with the merchant private key. */
function wechatAuthorization(
  config: Pick<WechatConfig, "mchid" | "certSerial" | "privateKey">,
  method: string,
  pathWithQuery: string,
  body: string,
  timestamp: number,
  nonce: string
): string {
  const message = `${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = createSign("RSA-SHA256").update(message, "utf8").sign(loadPrivateKey(config.privateKey), "base64");
  return (
    `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchid}",nonce_str="${nonce}",signature="${signature}",` +
    `timestamp="${timestamp}",serial_no="${config.certSerial}"`
  );
}

/** Verifies a WeChat Pay signature over `TIMESTAMP\nNONCE\nBODY\n` with the WeChat Pay public key. */
function signatureValid(
  config: WechatConfig,
  nowMs: number,
  parts: { serial?: string; signature?: string; timestamp?: string; nonce?: string; body: string }
): boolean {
  const { serial, signature, timestamp, nonce, body } = parts;
  if (!serial || !signature || !timestamp || !nonce) return false;
  // Public key mode: the serial is the public key ID (PUB_KEY_ID_…). Anything else is a key we do not hold.
  if (serial !== config.publicKeyId) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) return false;
  try {
    return createVerify("RSA-SHA256")
      .update(`${timestamp}\n${nonce}\n${body}\n`, "utf8")
      .verify(loadPublicKey(config.publicKey), signature, "base64");
  } catch {
    return false;
  }
}

/** AEAD_AES_256_GCM decryption of a notification resource with the APIv3 key. */
function decryptResource(
  apiV3Key: string,
  resource: { ciphertext: string; nonce: string; associated_data?: string }
): string {
  const data = Buffer.from(resource.ciphertext, "base64");
  if (data.length <= 16) throw new Error("Ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(apiV3Key, "utf8"), Buffer.from(resource.nonce, "utf8"));
  decipher.setAuthTag(data.subarray(data.length - 16));
  decipher.setAAD(Buffer.from(resource.associated_data ?? "", "utf8"));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8");
}

type Transaction = {
  appid?: unknown;
  mchid?: unknown;
  out_trade_no?: unknown;
  transaction_id?: unknown;
  trade_state?: unknown;
  amount?: { total?: unknown };
};

/** A paid order from a (verified) transaction object, or null when it is not a successful payment of ours. */
function paidFromTransaction(config: WechatConfig, transaction: Transaction, orderId?: string): PaidOrder | null {
  if (transaction.trade_state !== "SUCCESS") return null;
  if (transaction.mchid !== config.mchid || transaction.appid !== config.appid) return null;
  const { out_trade_no: outTradeNo, transaction_id: transactionId } = transaction;
  const total = transaction.amount?.total;
  if (typeof outTradeNo !== "string" || !outTradeNo) return null;
  if (orderId !== undefined && outTradeNo !== orderId) return null;
  if (typeof transactionId !== "string" || !transactionId) return null;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total <= 0) return null;
  return { orderId: outTradeNo, providerTxnId: transactionId, amountFen: total };
}

function requireOrderId(orderId: string): string {
  if (!OUT_TRADE_NO.test(orderId)) throw new Error("WeChat Pay order ids must be 6-32 letters, digits, _ - | *");
  return orderId;
}

export function createWechatPay(options: WechatPayOptions = {}): PaymentProvider {
  const env = options.env ?? process.env;
  const request: HttpRequest = options.request ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;

  function config(): WechatConfig {
    const current = readConfig(env);
    if (!isUsable(current)) throw new Error("WeChat Pay is not configured");
    return current;
  }

  /** Sends a signed API request and returns the verified response body (empty for 204). */
  async function call(
    method: "GET" | "POST",
    pathWithQuery: string,
    payload?: unknown
  ): Promise<{ status: number; body: string }> {
    const current = config();
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const timestamp = Math.floor(now() / 1000);
    const nonce = randomBytes(16).toString("hex").toUpperCase();
    const headers: Record<string, string> = {
      Authorization: wechatAuthorization(current, method, pathWithQuery, body, timestamp, nonce),
      Accept: "application/json",
      "Wechatpay-Serial": current.publicKeyId,
      "User-Agent": "max-cloud"
    };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    const response = await request(`${API_ORIGIN}${pathWithQuery}`, {
      method,
      headers,
      body: payload === undefined ? undefined : body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const text = await response.text();
    if (response.status < 200 || response.status > 299) {
      let code = "HTTP_ERROR";
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
        if (typeof parsed.code === "string") code = brief(parsed.code, 64);
        if (typeof parsed.message === "string") message = brief(parsed.message);
      } catch {
        // Not JSON: keep the HTTP status only.
      }
      throw new WechatPayError(response.status, code, `WeChat Pay ${response.status} ${code}: ${message}`);
    }
    const verified = signatureValid(current, now(), {
      serial: response.headers.get("Wechatpay-Serial") ?? undefined,
      signature: response.headers.get("Wechatpay-Signature") ?? undefined,
      timestamp: response.headers.get("Wechatpay-Timestamp") ?? undefined,
      nonce: response.headers.get("Wechatpay-Nonce") ?? undefined,
      body: text
    });
    if (!verified) throw new Error("WeChat Pay response signature is invalid");
    return { status: response.status, body: text };
  }

  return {
    id: "wechat",

    configured() {
      return isUsable(readConfig(env));
    },

    async createQrOrder(order: QrOrder) {
      const current = config();
      requireOrderId(order.orderId);
      if (!Number.isSafeInteger(order.amountFen) || order.amountFen <= 0) throw new Error("Invalid order amount");
      const { body } = await call("POST", "/v3/pay/transactions/native", {
        appid: current.appid,
        mchid: current.mchid,
        // description is string(127).
        description: Array.from(order.description).slice(0, 127).join(""),
        out_trade_no: order.orderId,
        time_expire: chinaRfc3339(order.expiresAt),
        notify_url: order.notifyUrl,
        amount: { total: order.amountFen, currency: "CNY" }
      });
      const parsed = JSON.parse(body) as { code_url?: unknown };
      if (typeof parsed.code_url !== "string" || !parsed.code_url) throw new Error("WeChat Pay returned no code_url");
      return { qrCode: parsed.code_url };
    },

    async parseNotification({ headers, rawBody }) {
      try {
        const current = readConfig(env);
        if (!isUsable(current)) return null;
        const verified = signatureValid(current, now(), {
          serial: headerValue(headers, "Wechatpay-Serial"),
          signature: headerValue(headers, "Wechatpay-Signature"),
          timestamp: headerValue(headers, "Wechatpay-Timestamp"),
          nonce: headerValue(headers, "Wechatpay-Nonce"),
          body: rawBody
        });
        if (!verified) return null;
        const notification = JSON.parse(rawBody) as {
          resource?: { algorithm?: unknown; ciphertext?: unknown; nonce?: unknown; associated_data?: unknown };
        };
        const resource = notification.resource;
        if (!resource || resource.algorithm !== "AEAD_AES_256_GCM") return null;
        const { ciphertext, nonce, associated_data: associatedData } = resource;
        if (typeof ciphertext !== "string" || typeof nonce !== "string") return null;
        if (associatedData !== undefined && typeof associatedData !== "string") return null;
        const plain = decryptResource(current.apiV3Key, { ciphertext, nonce, associated_data: associatedData });
        return paidFromTransaction(current, JSON.parse(plain) as Transaction);
      } catch {
        return null;
      }
    },

    notificationAnswer(accepted: boolean) {
      // Success: HTTP 200 or 204 without a body. Failure: 4XX/5XX with {"code":"FAIL","message":…}; WeChat retries.
      return accepted
        ? { status: 204, contentType: "text/plain", body: "" }
        : { status: 400, contentType: "application/json", body: '{"code":"FAIL","message":"invalid"}' };
    },

    async queryOrder(orderId: string) {
      const current = config();
      const path =
        `/v3/pay/transactions/out-trade-no/${encodeURIComponent(requireOrderId(orderId))}` +
        `?mchid=${encodeURIComponent(current.mchid)}`;
      try {
        const { body } = await call("GET", path);
        return paidFromTransaction(current, JSON.parse(body) as Transaction, orderId);
      } catch (error) {
        if (error instanceof WechatPayError && error.code === "ORDER_NOT_EXIST") return null;
        throw error;
      }
    },

    async closeOrder(orderId: string) {
      const current = config();
      const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(requireOrderId(orderId))}/close`;
      await call("POST", path, { mchid: current.mchid });
    }
  };
}
