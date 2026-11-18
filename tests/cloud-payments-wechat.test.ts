import { createCipheriv, createSign, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWechatPay } from "../server/cloud/payments/wechat";

function rsaPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString()
  };
}

// The merchant (us) and the WeChat Pay platform each hold a key pair.
const merchant = rsaPair();
const platform = rsaPair();

const NOW = Date.UTC(2026, 10, 18, 4, 0, 0); // 2026-11-18 12:00:00 in China
const NOW_S = Math.floor(NOW / 1000);
const API_V3_KEY = "0123456789abcdefghijklmnopqrstuv"; // 32 characters
const PUBLIC_KEY_ID = "PUB_KEY_ID_0000000000000024101100397200000006";

const ENV = {
  WECHATPAY_MCHID: "1900007291",
  WECHATPAY_APPID: "wxd678efh567hg6787",
  WECHATPAY_CERT_SERIAL: "408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB",
  WECHATPAY_PRIVATE_KEY: merchant.privatePem,
  WECHATPAY_API_V3_KEY: API_V3_KEY,
  WECHATPAY_PUBLIC_KEY: platform.publicPem,
  WECHATPAY_PUBLIC_KEY_ID: PUBLIC_KEY_ID
};

function platformSign(message: string, key = platform.privatePem): string {
  return createSign("RSA-SHA256").update(message, "utf8").sign(key, "base64");
}

type Captured = { url: string; init: RequestInit };

/** A fetch that records the request and answers with a response WeChat Pay would sign. */
function wechatServer(
  answer: (request: Captured) => {
    status: number;
    body: string;
    signature?: string;
    serial?: string;
    timestamp?: number;
    omitHeaders?: boolean;
  }
) {
  const calls: Captured[] = [];
  const request = async (url: string, init: RequestInit) => {
    const captured = { url, init };
    calls.push(captured);
    const { status, body, signature, serial, timestamp = NOW_S, omitHeaders } = answer(captured);
    const nonce = randomBytes(16).toString("hex");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (!omitHeaders) {
      headers["Wechatpay-Timestamp"] = String(timestamp);
      headers["Wechatpay-Nonce"] = nonce;
      headers["Wechatpay-Serial"] = serial ?? PUBLIC_KEY_ID;
      headers["Wechatpay-Signature"] = signature ?? platformSign(`${timestamp}\n${nonce}\n${body}\n`);
    }
    return new Response(status === 204 ? null : body, { status, headers });
  };
  return { calls, request };
}

function provider(request?: (url: string, init: RequestInit) => Promise<Response>, env: Record<string, string> = ENV) {
  return createWechatPay({
    env,
    now: () => NOW,
    request: request ?? (async () => new Response("unexpected", { status: 500 }))
  });
}

/** Parses `WECHATPAY2-SHA256-RSA2048 k="v",…` and checks the signature over the documented message. */
function checkAuthorization(header: string, method: string, pathWithQuery: string, body: string) {
  expect(header.startsWith("WECHATPAY2-SHA256-RSA2048 ")).toBe(true);
  const fields = Object.fromEntries(
    [...header.slice("WECHATPAY2-SHA256-RSA2048 ".length).matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]])
  );
  expect(Object.keys(fields).sort()).toEqual(["mchid", "nonce_str", "serial_no", "signature", "timestamp"]);
  expect(fields.mchid).toBe(ENV.WECHATPAY_MCHID);
  expect(fields.serial_no).toBe(ENV.WECHATPAY_CERT_SERIAL);
  expect(fields.timestamp).toBe(String(NOW_S));
  expect(fields.nonce_str).toMatch(/^[0-9A-F]{32}$/);
  const message = `${method}\n${pathWithQuery}\n${fields.timestamp}\n${fields.nonce_str}\n${body}\n`;
  const valid = createVerify("RSA-SHA256")
    .update(message, "utf8")
    .verify(merchant.publicPem, fields.signature ?? "", "base64");
  expect(valid).toBe(true);
}

const transaction = {
  appid: ENV.WECHATPAY_APPID,
  mchid: ENV.WECHATPAY_MCHID,
  out_trade_no: "ord_0123456789",
  transaction_id: "4200000985202611184321098765",
  trade_type: "NATIVE",
  trade_state: "SUCCESS",
  trade_state_desc: "支付成功",
  bank_type: "OTHERS",
  success_time: "2026-11-18T12:00:00+08:00",
  payer: { openid: "oUpF8uMuAJO_M2pxb1Q9zNjWeS6o" },
  amount: { total: 5000, payer_total: 4900, currency: "CNY", payer_currency: "CNY" }
};

/** A payment notification exactly as WeChat Pay sends it: AES-256-GCM resource, signed headers. */
function notification(
  overrides: {
    resource?: object;
    timestamp?: number;
    serial?: string;
    key?: string;
    signWith?: string;
    tamperBody?: (body: string) => string;
  } = {}
) {
  const nonce = randomBytes(6).toString("hex"); // 12 characters
  const associatedData = "transaction";
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(overrides.key ?? API_V3_KEY, "utf8"), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(overrides.resource ?? transaction), "utf8"),
    cipher.final(),
    cipher.getAuthTag()
  ]);
  const body = JSON.stringify({
    id: "EV-2018022511223320873",
    create_time: "2026-11-18T12:00:01+08:00",
    resource_type: "encrypt-resource",
    event_type: "TRANSACTION.SUCCESS",
    summary: "支付成功",
    resource: {
      original_type: "transaction",
      algorithm: "AEAD_AES_256_GCM",
      ciphertext: encrypted.toString("base64"),
      associated_data: associatedData,
      nonce
    }
  });
  const timestamp = String(overrides.timestamp ?? NOW_S);
  const headerNonce = randomBytes(16).toString("hex");
  const signature = platformSign(`${timestamp}\n${headerNonce}\n${body}\n`, overrides.signWith);
  return {
    headers: {
      "wechatpay-timestamp": timestamp,
      "wechatpay-nonce": headerNonce,
      "wechatpay-serial": overrides.serial ?? PUBLIC_KEY_ID,
      "wechatpay-signature": signature,
      "content-type": "application/json"
    } as Record<string, string | string[] | undefined>,
    rawBody: overrides.tamperBody ? overrides.tamperBody(body) : body
  };
}

describe("WeChat Pay configuration", () => {
  it("is configured only when every setting is present and the keys parse", () => {
    expect(provider().configured()).toBe(true);
    for (const name of Object.keys(ENV)) {
      expect(provider(undefined, { ...ENV, [name]: "" }).configured()).toBe(false);
    }
    expect(provider(undefined, {}).configured()).toBe(false);
  });

  it("refuses a malformed APIv3 key, public key id or keys", () => {
    expect(provider(undefined, { ...ENV, WECHATPAY_API_V3_KEY: "too-short" }).configured()).toBe(false);
    expect(
      provider(undefined, { ...ENV, WECHATPAY_PUBLIC_KEY_ID: "5157F09EFDC096DE15EBE81A47057A72" }).configured()
    ).toBe(false);
    expect(
      provider(undefined, { ...ENV, WECHATPAY_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnope" }).configured()
    ).toBe(false);
    expect(provider(undefined, { ...ENV, WECHATPAY_PUBLIC_KEY: merchant.privatePem }).configured()).toBe(false);
    expect(provider(undefined, { ...ENV, WECHATPAY_PRIVATE_KEY: "/nonexistent/apiclient_key.pem" }).configured()).toBe(
      false
    );
  });

  it("accepts PEM text with literal \\n escapes and PEM file paths", () => {
    const escaped = merchant.privatePem.trim().replace(/\n/g, "\\n");
    expect(provider(undefined, { ...ENV, WECHATPAY_PRIVATE_KEY: escaped }).configured()).toBe(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechatpay-"));
    try {
      const file = path.join(dir, "pub_key.pem");
      fs.writeFileSync(file, platform.publicPem);
      expect(provider(undefined, { ...ENV, WECHATPAY_PUBLIC_KEY: file }).configured()).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WeChat Pay Native order", () => {
  const order = {
    orderId: "ord_0123456789",
    amountFen: 5000,
    description: "Max Cloud top-up ¥50",
    notifyUrl: "https://max.example.com/cloud/pay/wechat/notify",
    expiresAt: NOW + 15 * 60 * 1000
  };

  it("signs the request as documented and returns code_url from a verified response", async () => {
    const server = wechatServer(() => ({ status: 200, body: '{"code_url":"weixin://wxpay/bizpayurl?pr=abc123"}' }));
    const result = await provider(server.request).createQrOrder(order);
    expect(result).toEqual({ qrCode: "weixin://wxpay/bizpayurl?pr=abc123" });

    const [call] = server.calls;
    expect(call?.url).toBe("https://api.mch.weixin.qq.com/v3/pay/transactions/native");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/json");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Wechatpay-Serial"]).toBe(PUBLIC_KEY_ID);
    const body = String(call?.init.body);
    expect(JSON.parse(body)).toEqual({
      appid: ENV.WECHATPAY_APPID,
      mchid: ENV.WECHATPAY_MCHID,
      description: "Max Cloud top-up ¥50",
      out_trade_no: "ord_0123456789",
      time_expire: "2026-11-18T12:15:00+08:00",
      notify_url: "https://max.example.com/cloud/pay/wechat/notify",
      amount: { total: 5000, currency: "CNY" }
    });
    checkAuthorization(headers.Authorization ?? "", "POST", "/v3/pay/transactions/native", body);
  });

  it("throws when the response signature does not verify", async () => {
    const forged = wechatServer(() => ({
      status: 200,
      body: '{"code_url":"weixin://wxpay/bizpayurl?pr=evil"}',
      signature: platformSign("something else\n")
    }));
    await expect(provider(forged.request).createQrOrder(order)).rejects.toThrow(/signature/);

    const otherKey = rsaPair();
    const wrongKey = wechatServer(() => ({
      status: 200,
      body: '{"code_url":"x"}',
      signature: platformSign("x", otherKey.privatePem)
    }));
    await expect(provider(wrongKey.request).createQrOrder(order)).rejects.toThrow(/signature/);

    const wrongSerial = wechatServer(() => ({ status: 200, body: '{"code_url":"x"}', serial: "PUB_KEY_ID_OTHER" }));
    await expect(provider(wrongSerial.request).createQrOrder(order)).rejects.toThrow(/signature/);

    const unsigned = wechatServer(() => ({ status: 200, body: '{"code_url":"x"}', omitHeaders: true }));
    await expect(provider(unsigned.request).createQrOrder(order)).rejects.toThrow(/signature/);

    const stale = wechatServer(() => ({ status: 200, body: '{"code_url":"x"}', timestamp: NOW_S - 301 }));
    await expect(provider(stale.request).createQrOrder(order)).rejects.toThrow(/signature/);
  });

  it("throws WeChat's code and message on errors without leaking secrets", async () => {
    const server = wechatServer(() => ({
      status: 400,
      body: '{"code":"PARAM_ERROR","message":"参数错误"}',
      omitHeaders: true
    }));
    const error = await provider(server.request)
      .createQrOrder(order)
      .catch((caught: unknown) => caught as Error);
    expect(error.message).toBe("WeChat Pay 400 PARAM_ERROR: 参数错误");
    expect(error.message).not.toContain(API_V3_KEY);
  });

  it("refuses order ids WeChat Pay would reject and non-positive amounts", async () => {
    const server = wechatServer(() => ({ status: 200, body: '{"code_url":"x"}' }));
    await expect(provider(server.request).createQrOrder({ ...order, orderId: "abc" })).rejects.toThrow(/order ids/);
    await expect(provider(server.request).createQrOrder({ ...order, amountFen: 0 })).rejects.toThrow(/amount/);
    expect(server.calls).toHaveLength(0);
  });

  it("refuses to run when not configured", async () => {
    await expect(provider(undefined, {}).createQrOrder(order)).rejects.toThrow(/not configured/);
  });
});

describe("WeChat Pay notifications", () => {
  it("returns the paid order for a valid notification (amount.total, not payer_total)", async () => {
    expect(await provider().parseNotification(notification())).toEqual({
      orderId: "ord_0123456789",
      providerTxnId: "4200000985202611184321098765",
      amountFen: 5000
    });
  });

  it("accepts header names in any case", async () => {
    const valid = notification();
    const headers = Object.fromEntries(
      Object.entries(valid.headers).map(([key, value]) => [key.replace(/(^|-)\w/g, (s) => s.toUpperCase()), value])
    );
    expect(await provider().parseNotification({ headers, rawBody: valid.rawBody })).not.toBeNull();
  });

  it("refuses a tampered body", async () => {
    const tampered = notification({ tamperBody: (body) => body.replace('"支付成功"', '"paid"') });
    expect(await provider().parseNotification(tampered)).toBeNull();
  });

  it("refuses a tampered or foreign signature, including signature probes", async () => {
    const valid = notification();
    const flipped = valid.headers["wechatpay-signature"] as string;
    const tampered = `${flipped.slice(0, 10)}${flipped[10] === "A" ? "B" : "A"}${flipped.slice(11)}`;
    expect(
      await provider().parseNotification({ ...valid, headers: { ...valid.headers, "wechatpay-signature": tampered } })
    ).toBeNull();
    expect(
      await provider().parseNotification({
        ...valid,
        headers: { ...valid.headers, "wechatpay-signature": `WECHATPAY/SIGNTEST/${flipped}` }
      })
    ).toBeNull();
    expect(await provider().parseNotification(notification({ signWith: rsaPair().privatePem }))).toBeNull();
  });

  it("refuses a wrong Wechatpay-Serial", async () => {
    expect(
      await provider().parseNotification(notification({ serial: "PUB_KEY_ID_0000000000000000000000000000000001" }))
    ).toBeNull();
    expect(await provider().parseNotification(notification({ serial: ENV.WECHATPAY_CERT_SERIAL }))).toBeNull();
  });

  it("refuses timestamps more than 5 minutes away", async () => {
    expect(await provider().parseNotification(notification({ timestamp: NOW_S - 300 }))).not.toBeNull();
    expect(await provider().parseNotification(notification({ timestamp: NOW_S - 301 }))).toBeNull();
    expect(await provider().parseNotification(notification({ timestamp: NOW_S + 301 }))).toBeNull();
  });

  it("refuses missing or repeated headers", async () => {
    const valid = notification();
    for (const name of ["wechatpay-timestamp", "wechatpay-nonce", "wechatpay-serial", "wechatpay-signature"]) {
      const headers = { ...valid.headers };
      delete headers[name];
      expect(await provider().parseNotification({ headers, rawBody: valid.rawBody })).toBeNull();
    }
    const repeated = { ...valid.headers, "wechatpay-serial": [PUBLIC_KEY_ID, PUBLIC_KEY_ID] };
    expect(await provider().parseNotification({ headers: repeated, rawBody: valid.rawBody })).toBeNull();
  });

  it("refuses unpaid states and other merchants' or apps' transactions", async () => {
    for (const trade_state of ["NOTPAY", "CLOSED", "REFUND", "PAYERROR", "USERPAYING", "REVOKED"]) {
      expect(
        await provider().parseNotification(notification({ resource: { ...transaction, trade_state } }))
      ).toBeNull();
    }
    expect(
      await provider().parseNotification(notification({ resource: { ...transaction, mchid: "1900000000" } }))
    ).toBeNull();
    expect(
      await provider().parseNotification(notification({ resource: { ...transaction, appid: "wx0000000000000000" } }))
    ).toBeNull();
    expect(
      await provider().parseNotification(notification({ resource: { ...transaction, amount: { total: "5000" } } }))
    ).toBeNull();
  });

  it("refuses resources encrypted with another key and garbage bodies, without throwing", async () => {
    expect(await provider().parseNotification(notification({ key: "vutsrqponmlkjihgfedcba9876543210" }))).toBeNull();
    const garbage = "not json";
    const timestamp = String(NOW_S);
    const headers = {
      "wechatpay-timestamp": timestamp,
      "wechatpay-nonce": "n",
      "wechatpay-serial": PUBLIC_KEY_ID,
      "wechatpay-signature": platformSign(`${timestamp}\nn\n${garbage}\n`)
    };
    expect(await provider().parseNotification({ headers, rawBody: garbage })).toBeNull();
    expect(await provider(undefined, {}).parseNotification(notification())).toBeNull();
    expect(await provider().parseNotification({ headers: {}, rawBody: "" })).toBeNull();
  });

  it("answers WeChat Pay as documented", () => {
    expect(provider().notificationAnswer(true)).toEqual({ status: 204, contentType: "text/plain", body: "" });
    expect(provider().notificationAnswer(false)).toEqual({
      status: 400,
      contentType: "application/json",
      body: '{"code":"FAIL","message":"invalid"}'
    });
  });
});

describe("WeChat Pay query and close", () => {
  it("queries by out_trade_no with a signed GET and returns the paid order", async () => {
    const server = wechatServer(() => ({ status: 200, body: JSON.stringify(transaction) }));
    expect(await provider(server.request).queryOrder("ord_0123456789")).toEqual({
      orderId: "ord_0123456789",
      providerTxnId: "4200000985202611184321098765",
      amountFen: 5000
    });
    const [call] = server.calls;
    const pathWithQuery = "/v3/pay/transactions/out-trade-no/ord_0123456789?mchid=1900007291";
    expect(call?.url).toBe(`https://api.mch.weixin.qq.com${pathWithQuery}`);
    expect(call?.init.method).toBe("GET");
    expect(call?.init.body).toBeUndefined();
    checkAuthorization((call?.init.headers as Record<string, string>).Authorization ?? "", "GET", pathWithQuery, "");
  });

  it("returns null for unpaid, unknown or mismatched orders", async () => {
    const unpaid = wechatServer(() => ({
      status: 200,
      body: JSON.stringify({ ...transaction, trade_state: "NOTPAY" })
    }));
    expect(await provider(unpaid.request).queryOrder("ord_0123456789")).toBeNull();
    const missing = wechatServer(() => ({
      status: 404,
      body: '{"code":"ORDER_NOT_EXIST","message":"订单不存在"}',
      omitHeaders: true
    }));
    expect(await provider(missing.request).queryOrder("ord_0123456789")).toBeNull();
    const other = wechatServer(() => ({ status: 200, body: JSON.stringify(transaction) }));
    expect(await provider(other.request).queryOrder("ord_9999999999")).toBeNull();
  });

  it("throws when the query response is forged or WeChat Pay fails", async () => {
    const forged = wechatServer(() => ({
      status: 200,
      body: JSON.stringify(transaction),
      signature: platformSign("x", rsaPair().privatePem)
    }));
    await expect(provider(forged.request).queryOrder("ord_0123456789")).rejects.toThrow(/signature/);
    const failing = wechatServer(() => ({
      status: 500,
      body: '{"code":"SYSTEM_ERROR","message":"系统错误"}',
      omitHeaders: true
    }));
    await expect(provider(failing.request).queryOrder("ord_0123456789")).rejects.toThrow(/SYSTEM_ERROR/);
  });

  it("closes with a signed POST {mchid} and accepts a signed 204", async () => {
    const server = wechatServer(() => ({ status: 204, body: "" }));
    await provider(server.request).closeOrder("ord_0123456789");
    const [call] = server.calls;
    const pathname = "/v3/pay/transactions/out-trade-no/ord_0123456789/close";
    expect(call?.url).toBe(`https://api.mch.weixin.qq.com${pathname}`);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBe('{"mchid":"1900007291"}');
    checkAuthorization(
      (call?.init.headers as Record<string, string>).Authorization ?? "",
      "POST",
      pathname,
      '{"mchid":"1900007291"}'
    );
  });
});
