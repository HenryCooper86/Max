# Running Max Cloud

Max Cloud turns a relay into a hosted service: developers sign up at `/console`, create a project, paste their own
model key, and put a voice agent in their product without running a server. They pay ¥0.15 per minute from a prepaid
balance, after 1,000 free minutes a month. This guide is for whoever operates the relay.

What a customer gets, and what stays private:

- Each project runs on **its own model key** (OpenAI Realtime, Gemini Live or Grok Voice), **its own persona** (name,
  instructions, greeting) and **no tools of yours**. Project sessions are never recorded in the relay's QA evidence.
- Model keys are encrypted at rest (AES-256-GCM, bound to their project) and never shown again after they are saved.
  Passwords are hashed with scrypt; console logins and project keys are stored only as hashes.
- Customers see only their own projects, usage and payments.

## Turn it on

Add to the relay's `.env` and restart:

```bash
# 32 random bytes. Encrypts customers' model keys: back it up with the data folder.
# If it is lost, saved model keys cannot be read and customers must enter them again.
CLOUD_SECRET_KEY=   # openssl rand -base64 32
# The public address of this relay, for payment notifications.
CLOUD_PUBLIC_URL=https://max.example.com
```

Without `CLOUD_SECRET_KEY` every `/cloud` address answers "Max Cloud is not configured" and the console says so.

Data lives in `cloud.sqlite` in the relay's data folder (`STUDIO_DIR`, default `~/.max-relay`), next to the relay's
other data. Back up that folder and `CLOUD_SECRET_KEY` together.

## How customers connect

1. Sign up at `https://<relay>/console` and create a project. The project key (`mpk_…`) is shown once.
2. Choose a backend, paste a model key, set the assistant's name, instructions and greeting.
3. From their own backend, mint a short-lived session token with the project key:

   ```bash
   curl -X POST https://<relay>/v1/session-tokens \
     -H "Authorization: Bearer mpk_…" -H "content-type: application/json" \
     -d '{"userId":"their-user-42"}'
   ```

4. Give the token to the page, exactly as in [getting started](getting-started.md): the widget's `token-url`, or the
   SDK's `token` function.

Limits that keep one account from affecting everyone else:

- **Balance.** A session starts only when the customer has at least 15 seconds left, counting every session they have
  open, and all their sessions are checked every 15 seconds. When the time is used up they are closed with code `4003`
  ("Your Max Cloud balance is used up. Top up in the console."). A balance can go negative by at most one check
  interval per open session.
- **5 simultaneous sessions** per customer; a sixth is refused with code `1013`.
- **Session tokens:** at most 120 minted per minute per project, at most 200 live per project, and 1,000 characters of
  `context`. Cloud tokens are kept apart from the relay's own, so no customer can push them out.
- **Keys:** rotating a project key or deleting the project closes its sessions within 15 seconds, and tokens minted
  with the old key stop working.
- A project without a model key is refused with code `1008`.

Sessions are checkpointed while they run, so a crash or restart cannot lose their charge: on startup the relay books
every session left open, up to its last checkpoint.

## Getting paid

### Today: manual top-ups

Until online payment is set up, the console's **Top up** button tells customers to contact you (GitHub Discussions).
When a customer has paid you some other way, add the balance:

```bash
npm run cloud:credit -- dev@example.com 200 INV-2026-0007
```

The amount is in yuan (`49.50` works; a negative amount removes balance). The reference (an invoice or receipt number)
makes it safe to run twice. Run it on the relay host, in the app directory; the relay sees the change at once.

### Later: WeChat Pay and Alipay

Both need a merchant account, which needs a business licence (for example an individual business licence,
个体工商户). Once you have them, set the variables below and restart: the console's Top up button then offers a QR code
for each configured provider, and balances are credited automatically and exactly once per payment.

**WeChat Pay** (API v3, Native payment)

1. In the merchant platform, activate **Native支付** and bind your AppID to the merchant number.
2. Under 账户中心 → API安全: set the 32-character APIv3 key, apply for the merchant API certificate, and download the
   **WeChat Pay public key** and its ID (`PUB_KEY_ID_…`).
3. Set:

   ```bash
   WECHATPAY_MCHID=
   WECHATPAY_APPID=
   WECHATPAY_CERT_SERIAL=          # serial number of the merchant API certificate
   WECHATPAY_PRIVATE_KEY=          # apiclient_key.pem: the PEM text or a path to the file
   WECHATPAY_API_V3_KEY=
   WECHATPAY_PUBLIC_KEY=           # the WeChat Pay public key: PEM text or a path
   WECHATPAY_PUBLIC_KEY_ID=        # PUB_KEY_ID_…
   ```

4. Notifications arrive at `https://<CLOUD_PUBLIC_URL>/cloud/pay/wechat/notify`; it must be reachable over HTTPS.

**Alipay** (订单码支付, `alipay.trade.precreate`)

1. Create an app in the Alipay open platform with public-key signing (RSA2): upload the app public key and copy the
   **Alipay** public key (not your app's). Put the app online and bind it to your merchant account.
2. Sign up for **订单码支付** (or the older 当面付; then also set `ALIPAY_PRODUCT_CODE=FACE_TO_FACE_PAYMENT`).
3. Set:

   ```bash
   ALIPAY_APP_ID=
   ALIPAY_PRIVATE_KEY=             # the app private key: PEM, a path, or the bare base64 Alipay's tool exports
   ALIPAY_PUBLIC_KEY=              # the Alipay public key
   # ALIPAY_GATEWAY=https://openapi-sandbox.dl.alipaydev.com/gateway.do   # the sandbox, for testing
   ```

4. Notifications arrive at `https://<CLOUD_PUBLIC_URL>/cloud/pay/alipay/notify`. If the app has an IP allowlist, add
   the relay's outbound address.

Every notification's signature is verified, the paid amount must match the order, and an order is credited once
however often the provider repeats the notification. A payment confirmed just after its order expired is still
credited, so a customer is never charged without receiving balance.

### Testing payments without a merchant account

In development (never with `NODE_ENV=production`), `CLOUD_PAYMENTS_TEST=on` adds a **Test payment** method: its QR code
links to a page with a "Mark as paid" button, so the whole top-up flow can be tried with no money involved.

## Prices

¥0.15 per minute, billed by the second, after 60,000 free seconds per customer per calendar month (UTC). Packs are
¥50, ¥200 and ¥1,000. The values live in `server/cloud/billing.ts`; the public copy in `src/lib/pricing.ts`.
