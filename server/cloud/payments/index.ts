// Payment providers for Max Cloud top-ups (see docs/superpowers/specs/2026-11-18-max-cloud-design.md).
// Each provider reads its settings from process.env on every call, so configuration changes need no restart.
import { createAlipay } from "./alipay";
import { createTestProvider } from "./test-provider";
import type { PaymentProvider } from "./types";
import { createWechatPay } from "./wechat";

export type { PaidOrder, PaymentProvider, QrOrder } from "./types";
export { markTestOrderPaid } from "./test-provider";

const providers: readonly PaymentProvider[] = [createWechatPay(), createAlipay(), createTestProvider()];

/** A configured payment provider by id. */
export function paymentProvider(id: string): PaymentProvider | undefined {
  return paymentProviders().find((provider) => provider.id === id);
}

/** Every configured payment provider, in the order WeChat Pay, Alipay, test. */
export function paymentProviders(): PaymentProvider[] {
  return providers.filter((provider) => provider.configured());
}
