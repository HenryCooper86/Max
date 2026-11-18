import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markTestOrderPaid, paymentProvider, paymentProviders } from "../server/cloud/payments";
import { createTestProvider } from "../server/cloud/payments/test-provider";
import { chinaDateTime, chinaRfc3339, fenToYuan, headerValue, yuanToFen } from "../server/cloud/payments/util";

describe("fen and yuan", () => {
  it("formats fen as exact two-decimal yuan", () => {
    expect(fenToYuan(1)).toBe("0.01");
    expect(fenToYuan(10)).toBe("0.10");
    expect(fenToYuan(5000)).toBe("50.00");
    expect(fenToYuan(20000)).toBe("200.00");
    expect(fenToYuan(100000)).toBe("1000.00");
    expect(fenToYuan(0)).toBe("0.00");
    expect(fenToYuan(123456789)).toBe("1234567.89");
    expect(() => fenToYuan(1.5)).toThrow();
    expect(() => fenToYuan(-1)).toThrow();
  });

  it("parses yuan strings without floating-point drift", () => {
    expect(yuanToFen("0.01")).toBe(1);
    expect(yuanToFen("50.00")).toBe(5000);
    expect(yuanToFen("1000.00")).toBe(100000);
    expect(yuanToFen("10.1")).toBe(1010);
    expect(yuanToFen("0.29")).toBe(29); // 0.29 * 100 = 28.999999999999996 in floating point
    expect(yuanToFen("1.005")).toBeNull();
    expect(yuanToFen("20")).toBe(2000);
    for (const bad of ["", "-1.00", "1e3", "1,000.00", ".5", "5.", "abc", "NaN", "Infinity"]) {
      expect(yuanToFen(bad)).toBeNull();
    }
  });

  it("round-trips", () => {
    for (const fen of [1, 9, 99, 100, 5000, 20000, 100000, 999999]) expect(yuanToFen(fenToYuan(fen))).toBe(fen);
  });
});

describe("China time formatting", () => {
  it("formats in UTC+8 regardless of the host time zone", () => {
    const at = Date.UTC(2026, 11, 31, 16, 30, 5); // 2027-01-01 00:30:05 in China
    expect(chinaRfc3339(at)).toBe("2027-01-01T00:30:05+08:00");
    expect(chinaDateTime(at)).toBe("2027-01-01 00:30:05");
  });
});

describe("headerValue", () => {
  it("finds headers case-insensitively and refuses repeats", () => {
    expect(headerValue({ "Wechatpay-Nonce": "a" }, "wechatpay-nonce")).toBe("a");
    expect(headerValue({ "wechatpay-nonce": ["a", "b"] }, "Wechatpay-Nonce")).toBeUndefined();
    expect(headerValue({ "wechatpay-nonce": "a", "WECHATPAY-NONCE": "b" }, "Wechatpay-Nonce")).toBeUndefined();
    expect(headerValue({}, "x")).toBeUndefined();
  });
});

describe("test payment provider", () => {
  const on = { CLOUD_PAYMENTS_TEST: "on", NODE_ENV: "development", CLOUD_PUBLIC_URL: "https://max.example.com/" };
  const order = {
    orderId: "ord_test_1",
    amountFen: 5000,
    description: "test",
    notifyUrl: "https://max.example.com/cloud/pay/test/notify",
    expiresAt: Date.now() + 60_000
  };

  it("is enabled only with CLOUD_PAYMENTS_TEST=on outside production", () => {
    expect(createTestProvider({ env: on }).configured()).toBe(true);
    expect(createTestProvider({ env: { ...on, CLOUD_PAYMENTS_TEST: "yes" } }).configured()).toBe(false);
    expect(createTestProvider({ env: { ...on, NODE_ENV: "production" } }).configured()).toBe(false);
    expect(createTestProvider({ env: {} }).configured()).toBe(false);
  });

  it("returns a pay URL and reports the order paid once marked", async () => {
    const provider = createTestProvider({ env: on });
    expect(await provider.createQrOrder(order)).toEqual({
      qrCode: "https://max.example.com/cloud/pay/test/ord_test_1"
    });
    expect(await provider.queryOrder("ord_test_1")).toBeNull();
    expect(markTestOrderPaid("ord_test_1", on)).toEqual({
      orderId: "ord_test_1",
      providerTxnId: "test_ord_test_1",
      amountFen: 5000
    });
    expect(await provider.queryOrder("ord_test_1")).toEqual({
      orderId: "ord_test_1",
      providerTxnId: "test_ord_test_1",
      amountFen: 5000
    });
    expect(await provider.parseNotification({ headers: {}, rawBody: "anything" })).toBeNull();
  });

  it("defaults the URL to localhost, forgets closed orders and refuses when off", async () => {
    const provider = createTestProvider({ env: { CLOUD_PAYMENTS_TEST: "on" } });
    expect((await provider.createQrOrder({ ...order, orderId: "ord_test_2" })).qrCode).toBe(
      "http://localhost:8787/cloud/pay/test/ord_test_2"
    );
    await provider.closeOrder("ord_test_2");
    expect(markTestOrderPaid("ord_test_2", on)).toBeNull();
    expect(markTestOrderPaid("unknown", on)).toBeNull();

    await provider.createQrOrder({ ...order, orderId: "ord_test_3" });
    expect(markTestOrderPaid("ord_test_3", { ...on, NODE_ENV: "production" })).toBeNull();
    const off = createTestProvider({ env: { ...on, NODE_ENV: "production" } });
    await expect(off.createQrOrder(order)).rejects.toThrow(/off/);
  });
});

describe("paymentProviders", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const settings = [
    "WECHATPAY_MCHID",
    "WECHATPAY_APPID",
    "WECHATPAY_CERT_SERIAL",
    "WECHATPAY_PRIVATE_KEY",
    "WECHATPAY_API_V3_KEY",
    "WECHATPAY_PUBLIC_KEY",
    "WECHATPAY_PUBLIC_KEY_ID",
    "ALIPAY_APP_ID",
    "ALIPAY_PRIVATE_KEY",
    "ALIPAY_PUBLIC_KEY",
    "ALIPAY_GATEWAY",
    "CLOUD_PAYMENTS_TEST"
  ];

  function clearAll() {
    for (const name of settings) vi.stubEnv(name, undefined);
  }

  it("lists only configured providers, in order, reading the environment on each call", () => {
    clearAll();
    expect(paymentProviders()).toEqual([]);
    expect(paymentProvider("wechat")).toBeUndefined();

    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CLOUD_PAYMENTS_TEST", "on");
    expect(paymentProviders().map((provider) => provider.id)).toEqual(["test"]);

    const pem = (kind: "private" | "public") => {
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      return kind === "private"
        ? pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
        : pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    };
    vi.stubEnv("ALIPAY_APP_ID", "2021000123456789");
    vi.stubEnv("ALIPAY_PRIVATE_KEY", pem("private"));
    vi.stubEnv("ALIPAY_PUBLIC_KEY", pem("public"));
    vi.stubEnv("WECHATPAY_MCHID", "1900007291");
    vi.stubEnv("WECHATPAY_APPID", "wxd678efh567hg6787");
    vi.stubEnv("WECHATPAY_CERT_SERIAL", "408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB");
    vi.stubEnv("WECHATPAY_PRIVATE_KEY", pem("private"));
    vi.stubEnv("WECHATPAY_API_V3_KEY", "0123456789abcdefghijklmnopqrstuv");
    vi.stubEnv("WECHATPAY_PUBLIC_KEY", pem("public"));
    vi.stubEnv("WECHATPAY_PUBLIC_KEY_ID", "PUB_KEY_ID_0000000000000024101100397200000006");
    expect(paymentProviders().map((provider) => provider.id)).toEqual(["wechat", "alipay", "test"]);
    expect(paymentProvider("alipay")?.id).toBe("alipay");

    vi.stubEnv("NODE_ENV", "production");
    expect(paymentProviders().map((provider) => provider.id)).toEqual(["wechat", "alipay"]);
    expect(paymentProvider("test")).toBeUndefined();
    expect(paymentProvider("paypal")).toBeUndefined();
  });
});
