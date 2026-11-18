import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAlipay } from "../server/cloud/payments/alipay";

function rsaPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    privatePkcs1Pem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString()
  };
}

/** The bare base64 body of a PEM, as Alipay's key tool exports keys. */
function bare(pem: string): string {
  return pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
}

// The app (us) and the Alipay platform each hold a key pair.
const app = rsaPair();
const alipay = rsaPair();

const NOW = Date.UTC(2026, 10, 18, 4, 0, 0); // 2026-11-18 12:00:00 in China
const APP_ID = "2021000123456789";
const ENV = {
  ALIPAY_APP_ID: APP_ID,
  ALIPAY_PRIVATE_KEY: bare(app.privatePem),
  ALIPAY_PUBLIC_KEY: bare(alipay.publicPem)
};

function alipaySign(content: string, key = alipay.privatePem): string {
  return createSign("RSA-SHA256").update(content, "utf8").sign(key, "base64");
}

type Captured = { url: URL; init: RequestInit; params: Record<string, string>; biz: Record<string, unknown> };

/**
 * A fetch playing the Alipay gateway: records the request and answers `{"<method>_response":<raw>,"sign":…}` where
 * the signature covers `signedRaw` (the raw text by default).
 */
function gateway(
  answer: (request: Captured) => {
    raw: string;
    signedRaw?: string;
    sign?: string | null;
    key?: string;
    status?: number;
  }
) {
  const calls: Captured[] = [];
  const request = async (url: string, init: RequestInit) => {
    const parsedUrl = new URL(url);
    const params: Record<string, string> = Object.fromEntries(parsedUrl.searchParams);
    for (const [key, value] of new URLSearchParams(String(init.body))) params[key] = value;
    const captured = { url: parsedUrl, init, params, biz: JSON.parse(params.biz_content ?? "{}") };
    calls.push(captured);
    const { raw, signedRaw, sign, key, status = 200 } = answer(captured);
    const responseKey = `${params.method?.replace(/\./g, "_")}_response`;
    const signature = sign === undefined ? alipaySign(signedRaw ?? raw, key) : sign;
    const text = `{"${responseKey}":${raw}${signature === null ? "" : `,"sign":"${signature}"`}}`;
    return new Response(text, { status, headers: { "Content-Type": "text/html;charset=utf-8" } });
  };
  return { calls, request };
}

function provider(request?: (url: string, init: RequestInit) => Promise<Response>, env: Record<string, string> = ENV) {
  return createAlipay({
    env,
    now: () => NOW,
    request: request ?? (async () => new Response("unexpected", { status: 500 }))
  });
}

/** The request `sign` must verify with the app public key over the sorted non-empty parameters except sign. */
function checkRequestSignature(params: Record<string, string>) {
  const content = Object.keys(params)
    .filter((key) => key !== "sign" && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  const valid = createVerify("RSA-SHA256")
    .update(content, "utf8")
    .verify(app.publicPem, params.sign ?? "", "base64");
  expect(valid).toBe(true);
}

const order = {
  orderId: "ord_0123456789",
  amountFen: 5000,
  description: "Max Cloud top-up ¥50",
  notifyUrl: "https://max.example.com/cloud/pay/alipay/notify",
  expiresAt: NOW + 15 * 60 * 1000
};

describe("Alipay configuration", () => {
  it("is configured only when the app id and both keys are present and parse", () => {
    expect(provider().configured()).toBe(true);
    for (const name of Object.keys(ENV)) expect(provider(undefined, { ...ENV, [name]: "" }).configured()).toBe(false);
    expect(provider(undefined, {}).configured()).toBe(false);
    expect(provider(undefined, { ...ENV, ALIPAY_PRIVATE_KEY: "MIIEnotakey" }).configured()).toBe(false);
    expect(provider(undefined, { ...ENV, ALIPAY_PUBLIC_KEY: bare(app.privatePem) }).configured()).toBe(false);
    expect(provider(undefined, { ...ENV, ALIPAY_GATEWAY: "http://openapi.alipay.com/gateway.do" }).configured()).toBe(
      false
    );
  });

  it("accepts PEM text, escaped PEM, bare PKCS#8 and bare PKCS#1 private keys", () => {
    for (const key of [
      app.privatePem,
      app.privatePem.trim().replace(/\n/g, "\\n"),
      bare(app.privatePem),
      bare(app.privatePkcs1Pem),
      app.privatePkcs1Pem
    ]) {
      expect(provider(undefined, { ...ENV, ALIPAY_PRIVATE_KEY: key }).configured()).toBe(true);
    }
    expect(provider(undefined, { ...ENV, ALIPAY_PUBLIC_KEY: alipay.publicPem }).configured()).toBe(true);
  });
});

describe("Alipay precreate", () => {
  it("signs the documented parameters and returns qr_code from a verified response", async () => {
    // Alipay escapes slashes in its JSON; the signature covers the text exactly as sent.
    const raw =
      '{"code":"10000","msg":"Success","out_trade_no":"ord_0123456789",' +
      '"qr_code":"https:\\/\\/qr.alipay.com\\/bax03206ug0kulveltqc80a8"}';
    const server = gateway(() => ({ raw }));
    expect(await provider(server.request).createQrOrder(order)).toEqual({
      qrCode: "https://qr.alipay.com/bax03206ug0kulveltqc80a8"
    });

    const [call] = server.calls;
    expect(`${call?.url.origin}${call?.url.pathname}`).toBe("https://openapi.alipay.com/gateway.do");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect((call?.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded;charset=utf-8"
    );
    // Platform parameters travel in the query, biz_content in the form body.
    expect(call?.url.searchParams.get("charset")).toBe("utf-8");
    expect(call?.url.searchParams.has("biz_content")).toBe(false);
    expect([...new URLSearchParams(String(call?.init.body)).keys()]).toEqual(["biz_content"]);
    const params = call?.params ?? {};
    expect(params).toMatchObject({
      app_id: APP_ID,
      method: "alipay.trade.precreate",
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: "2026-11-18 12:00:00",
      version: "1.0",
      notify_url: "https://max.example.com/cloud/pay/alipay/notify"
    });
    expect(call?.biz).toEqual({
      out_trade_no: "ord_0123456789",
      total_amount: "50.00",
      subject: "Max Cloud top-up ¥50",
      product_code: "QR_CODE_OFFLINE",
      time_expire: "2026-11-18 12:15:00"
    });
    checkRequestSignature(params);
  });

  it("uses a custom gateway and product code", async () => {
    const server = gateway(() => ({ raw: '{"code":"10000","msg":"Success","qr_code":"https://qr.alipay.com/x"}' }));
    const sandbox = provider(server.request, {
      ...ENV,
      ALIPAY_GATEWAY: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
      ALIPAY_PRODUCT_CODE: "FACE_TO_FACE_PAYMENT"
    });
    await sandbox.createQrOrder({ ...order, amountFen: 1, description: "a/b=c&d" });
    expect(server.calls[0]?.url.host).toBe("openapi-sandbox.dl.alipaydev.com");
    expect(server.calls[0]?.biz).toMatchObject({
      total_amount: "0.01",
      product_code: "FACE_TO_FACE_PAYMENT",
      subject: "a b c d"
    });
  });

  it("accepts a signature made over slash-escaped text, as the docs suggest", async () => {
    const raw = '{"code":"10000","msg":"Success","qr_code":"https://qr.alipay.com/bax1"}';
    const server = gateway(() => ({ raw, signedRaw: raw.replace(/\//g, "\\/") }));
    expect(await provider(server.request).createQrOrder(order)).toEqual({ qrCode: "https://qr.alipay.com/bax1" });
  });

  it("verifies the exact response object even when its text appears elsewhere", async () => {
    // A decoy key inside a string value must not confuse the extraction.
    const raw =
      '{"code":"10000","msg":"x \\"alipay_trade_precreate_response\\":{} }","qr_code":"https://qr.alipay.com/ok"}';
    const server = gateway(() => ({ raw }));
    expect(await provider(server.request).createQrOrder(order)).toEqual({ qrCode: "https://qr.alipay.com/ok" });
  });

  it("throws when the response signature is wrong or missing", async () => {
    const raw = '{"code":"10000","msg":"Success","qr_code":"https://qr.alipay.com/evil"}';
    const tampered = gateway(() => ({ raw, signedRaw: raw.replace("evil", "good") }));
    await expect(provider(tampered.request).createQrOrder(order)).rejects.toThrow(/signature is invalid/);
    const foreign = gateway(() => ({ raw, key: rsaPair().privatePem }));
    await expect(provider(foreign.request).createQrOrder(order)).rejects.toThrow(/signature is invalid/);
    const unsigned = gateway(() => ({ raw, sign: null }));
    await expect(provider(unsigned.request).createQrOrder(order)).rejects.toThrow(/not signed/);
  });

  it("throws Alipay's error codes", async () => {
    const raw = '{"code":"40004","msg":"Business Failed","sub_code":"ACQ.ACCESS_FORBIDDEN","sub_msg":"无权限使用接口"}';
    const server = gateway(() => ({ raw }));
    await expect(provider(server.request).createQrOrder(order)).rejects.toThrow(
      "Alipay 40004 ACQ.ACCESS_FORBIDDEN: 无权限使用接口"
    );
    const unsignedError = gateway(() => ({
      raw: '{"code":"40002","msg":"Invalid Arguments","sub_code":"isv.invalid-app-id","sub_msg":"无效的AppID参数"}',
      sign: null
    }));
    await expect(provider(unsignedError.request).createQrOrder(order)).rejects.toThrow(/isv.invalid-app-id/);
    const httpError = gateway(() => ({ raw: "{}", status: 502 }));
    await expect(provider(httpError.request).createQrOrder(order)).rejects.toThrow(/HTTP 502/);
  });

  it("refuses bad order ids and amounts before calling Alipay", async () => {
    const server = gateway(() => ({ raw: "{}" }));
    await expect(provider(server.request).createQrOrder({ ...order, orderId: "ord-1" })).rejects.toThrow(/order ids/);
    await expect(provider(server.request).createQrOrder({ ...order, amountFen: 1.5 })).rejects.toThrow(/amount/);
    expect(server.calls).toHaveLength(0);
  });
});

/** A notification exactly as Alipay posts it: form-encoded, signed over sorted params without sign and sign_type. */
function notification(overrides: Record<string, string | undefined> = {}, signWith?: string) {
  const params: Record<string, string> = {
    gmt_create: "2026-11-18 11:59:30",
    charset: "utf-8",
    seller_email: "merchant@example.com",
    subject: "Max Cloud top-up ¥50",
    buyer_id: "2088102116773037",
    invoice_amount: "50.00",
    notify_id: "2026111800222120001012345678901234",
    fund_bill_list: '[{"amount":"50.00","fundChannel":"ALIPAYACCOUNT"}]',
    notify_type: "trade_status_sync",
    trade_status: "TRADE_SUCCESS",
    receipt_amount: "50.00",
    buyer_pay_amount: "50.00",
    app_id: APP_ID,
    auth_app_id: APP_ID,
    notify_time: "2026-11-18 12:00:01",
    point_amount: "0.00",
    total_amount: "50.00",
    seller_id: "2088102119685838",
    trade_no: "2026111822001437451234567890",
    gmt_payment: "2026-11-18 12:00:00",
    out_trade_no: "ord_0123456789",
    version: "1.0"
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete params[key];
    else params[key] = value;
  }
  const content = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  const form = new URLSearchParams({ ...params, sign_type: "RSA2", sign: alipaySign(content, signWith) });
  return { headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, rawBody: form.toString() };
}

function withField(rawBody: string, key: string, value: string): string {
  const form = new URLSearchParams(rawBody);
  form.set(key, value);
  return form.toString();
}

describe("Alipay notifications", () => {
  it("returns the paid order for a valid notification", async () => {
    expect(await provider().parseNotification(notification())).toEqual({
      orderId: "ord_0123456789",
      providerTxnId: "2026111822001437451234567890",
      amountFen: 5000
    });
    expect(await provider().parseNotification(notification({ trade_status: "TRADE_FINISHED" }))).not.toBeNull();
  });

  it("converts total_amount exactly", async () => {
    for (const [yuan, fen] of [
      ["0.01", 1],
      ["10.1", 1010],
      ["1000.00", 100000],
      ["20", 2000],
      ["0.29", 29]
    ] as const) {
      expect((await provider().parseNotification(notification({ total_amount: yuan })))?.amountFen).toBe(fen);
    }
    expect(await provider().parseNotification(notification({ total_amount: "1e3" }))).toBeNull();
    expect(await provider().parseNotification(notification({ total_amount: "0.00" }))).toBeNull();
  });

  it("refuses tampered parameters and signatures", async () => {
    const valid = notification();
    expect(
      await provider().parseNotification({ ...valid, rawBody: withField(valid.rawBody, "total_amount", "5000.00") })
    ).toBeNull();
    expect(
      await provider().parseNotification({ ...valid, rawBody: withField(valid.rawBody, "out_trade_no", "ord_other") })
    ).toBeNull();
    const sign = new URLSearchParams(valid.rawBody).get("sign") ?? "";
    const flipped = `${sign.slice(0, 20)}${sign[20] === "A" ? "B" : "A"}${sign.slice(21)}`;
    expect(
      await provider().parseNotification({ ...valid, rawBody: withField(valid.rawBody, "sign", flipped) })
    ).toBeNull();
    expect(await provider().parseNotification(notification({}, rsaPair().privatePem))).toBeNull();
    const unsigned = new URLSearchParams(valid.rawBody);
    unsigned.delete("sign");
    expect(await provider().parseNotification({ ...valid, rawBody: unsigned.toString() })).toBeNull();
  });

  it("refuses another app's notification even when properly signed", async () => {
    expect(await provider().parseNotification(notification({ app_id: "2021009999999999" }))).toBeNull();
  });

  it("refuses unpaid statuses", async () => {
    for (const trade_status of ["WAIT_BUYER_PAY", "TRADE_CLOSED", ""]) {
      expect(await provider().parseNotification(notification({ trade_status }))).toBeNull();
    }
  });

  it("refuses RSA (SHA1) sign types, repeated parameters and garbage without throwing", async () => {
    const valid = notification();
    expect(
      await provider().parseNotification({ ...valid, rawBody: withField(valid.rawBody, "sign_type", "RSA") })
    ).toBeNull();
    expect(
      await provider().parseNotification({ ...valid, rawBody: `${valid.rawBody}&trade_status=TRADE_SUCCESS` })
    ).toBeNull();
    expect(await provider().parseNotification({ headers: {}, rawBody: "%%%&&&=" })).toBeNull();
    expect(await provider().parseNotification({ headers: {}, rawBody: "" })).toBeNull();
    expect(await provider(undefined, {}).parseNotification(valid)).toBeNull();
  });

  it("answers Alipay as documented", () => {
    expect(provider().notificationAnswer(true)).toEqual({ status: 200, contentType: "text/plain", body: "success" });
    expect(provider().notificationAnswer(false)).toEqual({ status: 200, contentType: "text/plain", body: "fail" });
  });
});

describe("Alipay query and close", () => {
  it("queries by out_trade_no and returns the paid order", async () => {
    const server = gateway(() => ({
      raw:
        '{"code":"10000","msg":"Success","trade_no":"2026111822001437451234567890","out_trade_no":"ord_0123456789",' +
        '"trade_status":"TRADE_SUCCESS","total_amount":"1000.00","buyer_pay_amount":"999.00"}'
    }));
    expect(await provider(server.request).queryOrder("ord_0123456789")).toEqual({
      orderId: "ord_0123456789",
      providerTxnId: "2026111822001437451234567890",
      amountFen: 100000
    });
    const [call] = server.calls;
    expect(call?.params.method).toBe("alipay.trade.query");
    expect(call?.params.notify_url).toBeUndefined();
    expect(call?.biz).toEqual({ out_trade_no: "ord_0123456789" });
    checkRequestSignature(call?.params ?? {});
  });

  it("returns null while unpaid or not yet scanned", async () => {
    const waiting = gateway(() => ({
      raw: '{"code":"10000","msg":"Success","trade_no":"1","out_trade_no":"ord_0123456789","trade_status":"WAIT_BUYER_PAY","total_amount":"50.00"}'
    }));
    expect(await provider(waiting.request).queryOrder("ord_0123456789")).toBeNull();
    const missing = gateway(() => ({
      raw: '{"code":"40004","msg":"Business Failed","sub_code":"ACQ.TRADE_NOT_EXIST","sub_msg":"交易不存在"}'
    }));
    expect(await provider(missing.request).queryOrder("ord_0123456789")).toBeNull();
  });

  it("throws when the query response signature is wrong", async () => {
    const forged = gateway(() => ({
      raw: '{"code":"10000","msg":"Success","trade_no":"1","out_trade_no":"ord_0123456789","trade_status":"TRADE_SUCCESS","total_amount":"50.00"}',
      key: rsaPair().privatePem
    }));
    await expect(provider(forged.request).queryOrder("ord_0123456789")).rejects.toThrow(/signature/);
  });

  it("closes by out_trade_no and tolerates orders never scanned", async () => {
    const server = gateway(() => ({ raw: '{"code":"10000","msg":"Success","out_trade_no":"ord_0123456789"}' }));
    await provider(server.request).closeOrder("ord_0123456789");
    expect(server.calls[0]?.params.method).toBe("alipay.trade.close");
    expect(server.calls[0]?.biz).toEqual({ out_trade_no: "ord_0123456789" });
    checkRequestSignature(server.calls[0]?.params ?? {});

    const missing = gateway(() => ({
      raw: '{"code":"40004","msg":"Business Failed","sub_code":"ACQ.TRADE_NOT_EXIST","sub_msg":"交易不存在"}'
    }));
    await expect(provider(missing.request).closeOrder("ord_0123456789")).resolves.toBeUndefined();
    const paid = gateway(() => ({
      raw: '{"code":"40004","msg":"Business Failed","sub_code":"ACQ.TRADE_STATUS_ERROR","sub_msg":"交易状态不合法"}'
    }));
    await expect(provider(paid.request).closeOrder("ord_0123456789")).rejects.toThrow(/ACQ.TRADE_STATUS_ERROR/);
  });
});
