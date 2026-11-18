# Max Cloud: accounts, projects and prepaid top-ups

Date: 2026-11-18

## Goal

Let a developer sign up, create a project, paste their own model key, and put a voice agent in their product without
running a server. They pay for hosting with prepaid balance topped up by WeChat Pay or Alipay. Keep it small: no
email verification, no teams, no tools in the dashboard, no subscriptions.

Decisions (from the owner): prepaid top-ups at **¥0.15 per minute**, **1,000 free minutes per customer per calendar
month**, packs of **¥50, ¥200, ¥1,000**. A project sets **its model key, voice backend, assistant name, instructions and
greeting**. The owner has WeChat Pay and Alipay merchant accounts and supplies their credentials in `.env`.

## Concepts

- **Customer**: someone who signs up at `/console` with an email and password. Separate from the relay's own staff
  accounts (`server/accounts.ts`, the QA/admin app); the two never mix.
- **Project**: belongs to one customer. Has a project API key (`mpk_…`, shown once, stored as a SHA-256 hash plus an
  8-character display prefix), a voice backend (`openai` | `gemini` | `grok`), the customer's model key for it
  (encrypted at rest), an assistant name, instructions and greeting.
- **Balance**: per customer, in **fen** (¥0.01, integer). Changes only through ledger entries.
- **Free minutes**: 60,000 seconds per customer per calendar month (UTC), used before balance.

## Money rules

- Price: 15 fen per minute. A finished session's cost is
  `ceil(max(0, seconds - freeSecondsLeftThisMonth) * 15 / 60)` fen. Free seconds used are recorded too.
- A customer may **start** a session when free seconds remain or balance > 0.
- A session in progress is checked every 15 s and closed (code 4003, message "Your Max Cloud balance is used up. Top
  up in the console.") when free seconds plus balance-equivalent seconds are used up. The balance can therefore go
  negative by at most about 15 s of usage (≤ 4 fen); the next top-up covers it.
- Top-ups credit the balance **once** per paid order (idempotent on `orderId`), only after a verified provider
  notification or a verified order query, and only when the paid amount equals the order amount.

## Storage

SQLite (`node:sqlite`, like `server/testing-store.ts`) at `$STUDIO_DIR/cloud.sqlite`, WAL mode. Tables:

- `customers(id TEXT PK, email TEXT UNIQUE COLLATE NOCASE, password_hash TEXT, password_salt TEXT, created_at INT)`
- `customer_sessions(token_hash TEXT PK, customer_id TEXT, expires_at INT)` — 30-day bearer tokens `mcs_…`
- `projects(id TEXT PK, customer_id TEXT, name TEXT, key_hash TEXT UNIQUE, key_prefix TEXT, backend TEXT,
model_key_enc TEXT NULL, assistant_name TEXT, instructions TEXT, greeting TEXT, created_at INT, deleted_at INT NULL)`
- `ledger(id INTEGER PK AUTOINCREMENT, customer_id TEXT, kind TEXT CHECK(kind IN ('topup','usage','adjust')),
amount_fen INT, free_seconds INT DEFAULT 0, seconds INT DEFAULT 0, project_id TEXT NULL, ref TEXT NULL,
month TEXT, created_at INT)` with `UNIQUE(kind, ref)` for idempotency (`ref` = orderId for top-ups, sessionId for
  usage).
- `orders(id TEXT PK, customer_id TEXT, provider TEXT, pack TEXT, amount_fen INT, status TEXT CHECK(status IN
('pending','paid','closed')), provider_txn_id TEXT NULL, created_at INT, paid_at INT NULL, expires_at INT)`

Balance = `SUM(amount_fen)` over the customer's ledger. Free seconds used this month = `SUM(free_seconds)` over usage
entries with that `month`.

Model keys are encrypted with AES-256-GCM under `CLOUD_SECRET_KEY` (32 bytes, base64 or hex). **Cloud is off unless
`CLOUD_SECRET_KEY` is set**: every `/cloud/*` route answers 503 `{ ok:false, error:"Max Cloud is not configured" }`.

## Modules and contracts

### `server/cloud/index.ts` (core)

```ts
export function cloudEnabled(): boolean;
/** JSON API under /cloud/api. Call after express.json(). */
export function registerCloudRoutes(app: express.Express): void;
/** Payment notification routes under /cloud/pay. They need the raw body: call BEFORE express.json(). */
export function registerCloudPaymentRoutes(app: express.Express): void;
/** The project a project API key belongs to (live projects only). */
export function projectForApiKey(apiKey: string): { projectId: string; customerId: string } | undefined;
/** What a session of this project runs with; undefined when the project is gone or has no model key. */
export function projectRuntime(projectId: string): ProjectRuntime | undefined;
export type ProjectRuntime = {
  projectId: string;
  customerId: string;
  backend: "openai" | "gemini" | "grok";
  modelKey: string; // decrypted
  assistantName: string;
  instructions?: string;
  greeting?: string;
};
/** Seconds this customer can still talk: free seconds left this month + balance converted at 15 fen/min. */
export function remainingSeconds(customerId: string, at?: number): number;
/** Books one finished session (idempotent on sessionId). */
export function chargeSession(usage: {
  customerId: string;
  projectId: string;
  sessionId: string;
  seconds: number;
  endedAt: number;
}): void;
```

### HTTP API (`/cloud/api`, JSON, bearer `mcs_…` token except signup/login/packs)

| Method & path                             | Body                                                                                                  | Answer                                                                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /cloud/api/signup`                  | `{ email, password }` (password ≥ 10 chars)                                                           | `201 { token, customer }`                                                                                                                                                                 |
| `POST /cloud/api/login`                   | `{ email, password }`                                                                                 | `{ token, customer }`                                                                                                                                                                     |
| `POST /cloud/api/logout`                  | —                                                                                                     | `{ ok: true }`                                                                                                                                                                            |
| `GET /cloud/api/me`                       | —                                                                                                     | `{ customer: { id, email, createdAt }, balance: { fen, freeSecondsLeft, month } }`                                                                                                        |
| `GET /cloud/api/projects`                 | —                                                                                                     | `{ projects: Project[] }`                                                                                                                                                                 |
| `POST /cloud/api/projects`                | `{ name }`                                                                                            | `201 { project, apiKey }` (key shown once)                                                                                                                                                |
| `PATCH /cloud/api/projects/:id`           | `{ name?, backend?, modelKey?, assistantName?, instructions?, greeting? }` (`modelKey: ""` clears it) | `{ project }`                                                                                                                                                                             |
| `POST /cloud/api/projects/:id/rotate-key` | —                                                                                                     | `{ project, apiKey }`                                                                                                                                                                     |
| `DELETE /cloud/api/projects/:id`          | —                                                                                                     | `{ ok: true }` (soft delete)                                                                                                                                                              |
| `GET /cloud/api/usage?month=YYYY-MM`      | —                                                                                                     | `{ month, seconds, minutes, freeSecondsUsed, chargedFen, projects: [{ projectId, name, seconds, chargedFen }] }`                                                                          |
| `GET /cloud/api/ledger`                   | —                                                                                                     | `{ entries: [{ id, kind, amountFen, seconds, projectId?, ref?, createdAt }] }` (latest 100)                                                                                               |
| `GET /cloud/api/packs`                    | —                                                                                                     | `{ packs: [{ id:"cny50", fen:5000 }, { id:"cny200", fen:20000 }, { id:"cny1000", fen:100000 }], providers: ["wechat","alipay"] }` (only configured providers, plus `"test"` in test mode) |
| `POST /cloud/api/topups`                  | `{ pack, provider }`                                                                                  | `201 { orderId, provider, amountFen, qrCode, expiresAt }` — `qrCode` is the string to render as a QR code                                                                                 |
| `GET /cloud/api/topups/:orderId`          | —                                                                                                     | `{ status: "pending" \| "paid" \| "closed" }` (queries the provider when still pending)                                                                                                   |

`Project` = `{ id, name, keyPrefix, backend, hasModelKey, assistantName, instructions, greeting, createdAt }`. The model
key is write-only and never returned. Errors: `{ ok:false, error }` with 400/401/404/409/429. Signup and login use
`checkAuthRateLimit` from `server/auth.ts`. Limits: name ≤ 60, assistantName ≤ 24, instructions ≤ 8000, greeting ≤ 300,
modelKey ≤ 400 chars; ≤ 20 live projects per customer.

### `server/cloud/payments/` (payment providers)

```ts
export type QrOrder = { orderId: string; amountFen: number; description: string; notifyUrl: string; expiresAt: number };
export type PaidOrder = { orderId: string; providerTxnId: string; amountFen: number };
export type PaymentProvider = {
  id: "wechat" | "alipay" | "test";
  configured(): boolean;
  /** Creates a QR-code order; returns the string to encode as the QR code. */
  createQrOrder(order: QrOrder): Promise<{ qrCode: string }>;
  /** Verifies a notification's signature and returns the paid order, or null (invalid, unpaid, or unrelated). */
  parseNotification(request: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
  }): Promise<PaidOrder | null>;
  /** What to answer the provider: WeChat expects HTTP 200/204 (or JSON {code:"FAIL"} with 4xx/5xx), Alipay the text "success". */
  notificationAnswer(accepted: boolean): { status: number; contentType: string; body: string };
  /** Asks the provider whether an order was paid (polling fallback). */
  queryOrder(orderId: string): Promise<PaidOrder | null>;
  /** Closes an unpaid order at the provider (best effort). */
  closeOrder(orderId: string): Promise<void>;
};
export function paymentProvider(id: string): PaymentProvider | undefined; // configured ones only
export function paymentProviders(): PaymentProvider[]; // configured ones only
```

- **WeChat Pay** (API v3, Native payment: `POST /v3/pay/transactions/native` → `code_url`): request signing with the
  merchant private key (`WECHATPAY-SHA256-RSA2048` Authorization header), notification signature verification with the
  WeChat Pay public key (`Wechatpay-Signature`, `Wechatpay-Timestamp`, `Wechatpay-Nonce`, `Wechatpay-Serial`;
  refuse timestamps more than 5 minutes off), resource decryption with AES-256-GCM under the APIv3 key, query by
  `out-trade-no`, close order. Env: `WECHATPAY_MCHID`, `WECHATPAY_APPID`, `WECHATPAY_CERT_SERIAL`,
  `WECHATPAY_PRIVATE_KEY` (PEM text or a file path), `WECHATPAY_API_V3_KEY`, `WECHATPAY_PUBLIC_KEY` (PEM or path),
  `WECHATPAY_PUBLIC_KEY_ID`. Amounts in fen, currency CNY.
- **Alipay** (`alipay.trade.precreate` → `qr_code`): RSA2 (SHA256withRSA) request signing with the app private key,
  response and notification verification with the Alipay public key, `alipay.trade.query`, `alipay.trade.close`.
  Notification is form-encoded; paid when `trade_status` is `TRADE_SUCCESS` or `TRADE_FINISHED`; check `app_id`
  matches. Env: `ALIPAY_APP_ID`, `ALIPAY_PRIVATE_KEY` (PEM or path), `ALIPAY_PUBLIC_KEY` (PEM or path),
  `ALIPAY_GATEWAY` (default `https://openapi.alipay.com/gateway.do`; sandbox
  `https://openapi-sandbox.dl.alipaydev.com/gateway.do`). Amounts in yuan strings with two decimals (`"50.00"`).
- **Test provider** (`CLOUD_PAYMENTS_TEST=on`, refused when `NODE_ENV=production`): `qrCode` is a URL to
  `/cloud/pay/test/:orderId`; `POST /cloud/pay/test/:orderId` marks it paid. For development and the console's tests.
- `CLOUD_PUBLIC_URL` (e.g. `https://max.bionicloud.net`) builds notify URLs: `/cloud/pay/wechat/notify`,
  `/cloud/pay/alipay/notify`.
- No secrets in logs. No network calls in tests: inject `fetch`, and test signing and verification with keys generated
  in the test.

### Relay integration (session core)

- `POST /v1/session-tokens` also accepts `Authorization: Bearer mpk_…`: the token's grant carries `projectId`; body
  `userId` becomes the end user (the customer's own user), as today.
- A connection whose grant has a `projectId`: refused (4003, message above) when `remainingSeconds` ≤ 0; otherwise the
  session runs on the project's backend with its model key and an `app`-device profile built from its name,
  instructions and greeting (`languages` default `["en"]`, wake word off), regardless of the relay's own assistant.
  When it ends, `chargeSession` books it. Checked every 15 s.
- Engines take an optional API key override; `server/providers/live/session.ts` takes an optional `profile`.

### Console (`/console`)

A new public surface in the web app, in the site's style and both languages: sign up / log in; projects list; project
page (API key shown once with copy, backend select, model key field that is write-only, name, instructions, greeting,
a ready-to-paste snippet for the widget and for minting tokens); balance with free minutes left; top up (pick pack,
pick WeChat Pay or Alipay, QR code shown, polled every 2 s until paid, then balance refreshes); usage this month;
ledger. QR codes rendered client-side with the `qrcode` npm package.
