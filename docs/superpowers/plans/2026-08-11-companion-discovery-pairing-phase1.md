# Companion Discovery Pairing — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rider pairs the iOS app to a helmet with zero typing: the app discovers the helmet over mDNS, the rider taps Pair, the helmet asks aloud, and a spoken 确认 completes the binding.

**Architecture:** The relay stays the only trust anchor. It issues each unpaired connected helmet a rotating secret-free discovery token over the existing `/agent` socket; the board broadcasts it via mDNS; the app sends the token back over the authenticated `/companion` socket; the relay speaks a confirm prompt through the helmet and resolves the rider's 确认/取消 via the embedded grammar, then binds through the existing store/displacement path. The six-digit code flow is untouched fallback.

**Tech Stack:** TypeScript (relay + board agent, vitest), `multicast-dns` (board, pure JS), Swift (`NWBrowser`, XCTest). BLE is Phase 2 (separate plan); Android is Phase 3 (out of scope — no Android companion client exists).

**Spec:** `docs/superpowers/specs/2026-08-11-companion-discovery-pairing-design.md`

## Global Constraints

- Discovery token: 16 random bytes; canonical form is the 32-char lowercase hex string in protocol messages and mDNS TXT. Lifetime 5 minutes (`pairLifetimeMs`); relay pushes a fresh token **one minute before expiry** while the helmet stays connected and unpaired.
- Unpaired helmet reconnect inside the window **reuses** the same token (mirror of the pairing-code reuse fix `8f9c606`). Paired helmets get `token: null` and are radio-silent.
- Confirm slot: at most one pending confirm per device, 30 s lifetime. Different account while occupied → `pair.busy`. Same account re-tap → idempotent, re-speaks prompt, deadline unchanged.
- Speech strings (exact): prompt `检测到配对请求，请说"确认"。`, success `已配对。`. Grammar: utterance containing 确认 accepts, containing 取消 declines; matched **only** while a confirm is pending.
- New `companion.error` codes: `pair.busy`, `pair.declined`, `pair.timeout`. Invalid/expired token reuses `pair.code` and counts toward the existing rate limits; offline helmet reuses `pair.helmetOffline`.
- Never log a raw token or pairing code (board or relay).
- Every relay speech line uses a **fresh** transcript delivery (`createTranscriptDelivery` per line) — clients dedupe by deliveryId.
- The six-digit code flow, HUD redaction, and `MAX_VISION_TOKEN` gating are byte-for-byte untouched.
- mDNS service type: `_maxhelmet._tcp.local`, TXT `dt=<token>`, `v=1`.
- China constraint: no foreign-CDN/network dependencies at runtime; `multicast-dns` is a local npm dep (CI installs via npmmirror).
- Run `npm run check` before the final merge; iOS tests via `cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17'`.

---

### Task 1: Protocol — `companion.discovery` agent event

**Files:**

- Modify: `protocol/agent-events.schema.json` (AgentEvent `oneOf`, next to the `CompanionPairing` entry at ~line 550)
- Modify: `shared/agent.ts` (type + union, next to `CompanionPairingEvent` at ~line 382)
- Regenerate: `shared/generated/agent-protocol.ts`, `ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift`, `android/app/src/main/java/com/horizon/maxhelmet/agent/GeneratedAgentProtocol.kt` via `npm run generate:protocol`

**Interfaces:**

- Produces: `CompanionDiscoveryEvent = { type: "companion.discovery"; token: string | null; expiresAt?: number }`, exported from `shared/agent.ts` and part of `AgentEvent`. Every later task imports this exact shape.

- [ ] **Step 1: Add the schema entry**

In `protocol/agent-events.schema.json`, immediately after the `CompanionPairing` object in the AgentEvent `oneOf`:

```json
{
  "title": "CompanionDiscovery",
  "type": "object",
  "properties": {
    "type": { "const": "companion.discovery" },
    "token": { "type": ["string", "null"] },
    "expiresAt": { "type": "number" }
  },
  "required": ["type", "token"]
},
```

- [ ] **Step 2: Verify the generated files are now stale**

Run: `npm run check:protocol`
Expected: FAIL (generated output no longer matches the schema).

- [ ] **Step 3: Regenerate**

Run: `npm run generate:protocol && npm run check:protocol`
Expected: PASS. `git diff --stat` shows the three generated files gained `companion.discovery`.

- [ ] **Step 4: Add the TypeScript event type**

In `shared/agent.ts`, directly below `CompanionPairingEvent`:

```ts
/** Server → RDK: the discovery token the board should broadcast, or null to
 *  stop broadcasting (paired, or beacon retired). Carries no secret: the
 *  token's whole purpose is to be public on the air. */
export type CompanionDiscoveryEvent = {
  type: "companion.discovery";
  token: string | null;
  expiresAt?: number;
};
```

Add `| CompanionDiscoveryEvent` to the `AgentEvent` union (beside `CompanionPairingEvent`).

- [ ] **Step 5: Typecheck all TS surfaces**

Run: `npx tsc --noEmit && npm run check:rdk`
Expected: PASS.

- [ ] **Step 6: Run the protocol test files**

Run: `npx vitest run tests/agent.test.ts tests/device-protocol.test.ts`
Expected: PASS (these read the generated lists; failures mean a hand-edit broke a generated file).

- [ ] **Step 7: Commit**

```bash
git add protocol/agent-events.schema.json shared/agent.ts shared/generated/agent-protocol.ts ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift android/app/src/main/java/com/horizon/maxhelmet/agent/GeneratedAgentProtocol.kt
git commit -m "feat(protocol): add companion.discovery agent event"
```

---

### Task 2: Companion protocol — `companion.pairDiscover` message

**Files:**

- Modify: `shared/companion.ts` (`CompanionClientEvent` union + `parseCompanionClientEvent`)
- Test: `tests/companion-protocol.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `{ type: "companion.pairDiscover"; token: string }` in `CompanionClientEvent`; `parseCompanionClientEvent` accepts exactly `{type, token}` where token matches `/^[0-9a-f]{32}$/`.

- [ ] **Step 1: Write the failing tests**

In `tests/companion-protocol.test.ts`, follow the file's existing parse-test style:

```ts
describe("companion.pairDiscover parsing", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef";

  it("accepts a canonical 32-hex token", () => {
    expect(parseCompanionClientEvent(JSON.stringify({ type: "companion.pairDiscover", token: TOKEN }))).toEqual({
      type: "companion.pairDiscover",
      token: TOKEN
    });
  });

  it.each([
    ["uppercase", "0123456789ABCDEF0123456789ABCDEF"],
    ["short", "0123456789abcdef"],
    ["long", `${"0123456789abcdef".repeat(2)}00`],
    ["non-hex", "zz23456789abcdef0123456789abcdef"],
    ["empty", ""]
  ])("rejects a %s token", (_label, token) => {
    expect(() => parseCompanionClientEvent(JSON.stringify({ type: "companion.pairDiscover", token }))).toThrow(
      /pairDiscover/
    );
  });

  it("rejects extra fields", () => {
    expect(() =>
      parseCompanionClientEvent(JSON.stringify({ type: "companion.pairDiscover", token: TOKEN, extra: 1 }))
    ).toThrow(/pairDiscover/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/companion-protocol.test.ts`
Expected: FAIL with "Unsupported companion client event companion.pairDiscover".

- [ ] **Step 3: Implement**

In `shared/companion.ts`: add to the union

```ts
  | { type: "companion.pairDiscover"; token: string }
```

and in `parseCompanionClientEvent`, after the `companion.pair` block:

```ts
if (value.type === "companion.pairDiscover") {
  if (
    !hasOnlyFields(value, ["type", "token"]) ||
    typeof value.token !== "string" ||
    !/^[0-9a-f]{32}$/.test(value.token)
  ) {
    throw new Error("Invalid companion.pairDiscover token");
  }
  return { type: "companion.pairDiscover", token: value.token };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/companion-protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/companion.ts tests/companion-protocol.test.ts
git commit -m "feat(companion): parse companion.pairDiscover"
```

---

### Task 3: Grammar — `matchPairConfirmReply`

**Files:**

- Modify: `server/device-actions.ts`
- Test: `tests/device-actions.test.ts`

**Interfaces:**

- Produces: `export function matchPairConfirmReply(text: string): "accept" | "decline" | undefined`. Pure, dependency-free (this file's contract). Task 5 imports it into the registry.

- [ ] **Step 1: Write the failing tests**

Append to `tests/device-actions.test.ts` in its existing table style:

```ts
describe("matchPairConfirmReply", () => {
  it.each([
    ["确认", "accept"],
    ["确认。", "accept"],
    ["好，确认", "accept"],
    ["取消", "decline"],
    ["取消配对", "decline"],
    ["算了，取消吧", "decline"]
  ] as const)("matches %s as %s", (text, expected) => {
    expect(matchPairConfirmReply(text)).toBe(expected);
  });

  it.each(["帮我导航到外滩", "确", "好的", "不要", "把音量调大", ""])("leaves %s unmatched", (text) => {
    expect(matchPairConfirmReply(text)).toBeUndefined();
  });

  it("prefers decline when both words appear", () => {
    // 取消确认 means "cancel the confirmation" — never bind on it.
    expect(matchPairConfirmReply("取消确认")).toBe("decline");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/device-actions.test.ts`
Expected: FAIL with "matchPairConfirmReply is not defined" (add the import to the test file's import list from `../server/device-actions`).

- [ ] **Step 3: Implement**

In `server/device-actions.ts`, near the 环境观察 patterns (~line 204):

```ts
/**
 * Companion pairing voice confirm. Deliberately narrow — the registry calls
 * this ONLY while a pairing confirm is pending on the device, so ordinary
 * conversation can never bind a phone. Decline wins over accept so 取消确认
 * ("cancel the confirmation") cannot pair.
 */
export function matchPairConfirmReply(text: string): "accept" | "decline" | undefined {
  if (/取消/.test(text)) return "decline";
  if (/确认/.test(text)) return "accept";
  return undefined;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/device-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/device-actions.ts tests/device-actions.test.ts
git commit -m "feat(device-actions): match pairing confirm replies"
```

---

### Task 4: Registry — discovery-token lifecycle

**Files:**

- Modify: `server/companion-registry.ts`
- Test: `tests/companion-registry.test.ts`

**Interfaces:**

- Consumes: `CompanionDiscoveryEvent` (Task 1).
- Produces (later tasks rely on these exact names):
  - `HelmetPeer.send` union widened to include `CompanionDiscoveryEvent`.
  - `HelmetPeer` gains required `speak(text: string): void`.
  - `createCompanionRegistry` options gain `randomToken?: () => string` (default: `randomBytes(16).toString("hex")` from `node:crypto`).
  - Internal helpers Task 5 calls: `stopDiscovery(deviceId: string): void` (clears token/timer and sends `token: null` to an attached helmet), `discoveryTokens: Map<string, DiscoveryToken>` keyed by token with `DiscoveryToken = { token: string; deviceId: string; expiresAt: number; helmet: HelmetSession }`.
- Constant: `DISCOVERY_REFRESH_LEAD_MS = 60_000`.

**Behavior being built:** on `attachHelmet` — unpaired helmet gets a discovery token (reused if unexpired, exactly like `issuePairCode`'s `reuseUnexpired`), sent as `companion.discovery`; paired helmet gets `{ token: null }`. A refresh timer rotates the token (fresh token, full lifetime) at `expiresAt - 60_000` while the helmet remains attached and unpaired. A successful **code** pair (`handlePair`) calls `stopDiscovery`. `markHelmetUnpaired` issues a fresh discovery token alongside the fresh pair code. Detach cancels the timer but retains the unexpired token entry for reuse (mirror of pair-code retention in the detach closure). `close()` clears maps and timers.

- [ ] **Step 1: Update the harness**

In `tests/companion-registry.test.ts`:

- Widen `HelmetEvent` to include the new event: `type HelmetEvent = CompanionPairingEvent | CompanionDiscoveryEvent | PhoneLocationEvent | PhoneLocationStatusEvent;` (import `CompanionDiscoveryEvent` from `../shared/agent`).
- Add `tokens?: string[]` to harness options; pass `randomToken: () => tokens.shift() ?? "ffffffffffffffffffffffffffffffff"` with default queue `["aaaa...", "bbbb...", "cccc..."]` (use full 32-hex literals: `"a".repeat(32)` is fine).
- Extend `helmet()` to capture speech: `helmet(deviceId, deviceLabel?)` returns `{ events, spoken: string[], detach }` with `speak: (text) => spoken.push(text)` in the peer.
- Fix every existing `registry.attachHelmet({...})` / `h.helmet(...)` call site the compiler flags for the new required `speak`.

- [ ] **Step 2: Write the failing tests**

```ts
describe("companion discovery tokens", () => {
  const TOKEN_A = "a".repeat(32);
  const TOKEN_B = "b".repeat(32);

  it("issues a discovery token to an unpaired helmet on attach", () => {
    const h = harness({ tokens: [TOKEN_A] });
    const helmet = h.helmet("rdk-a");
    expect(latest(helmet.events, "companion.discovery")).toEqual({
      type: "companion.discovery",
      token: TOKEN_A,
      expiresAt: 1_300_000
    });
  });

  it("reuses an unexpired token when the unpaired helmet reconnects", () => {
    const h = harness({ tokens: [TOKEN_A, TOKEN_B] });
    h.helmet("rdk-a");
    h.advance(30_000);
    const replacement = h.helmet("rdk-a");
    expect(latest(replacement.events, "companion.discovery")).toMatchObject({ token: TOKEN_A });
  });

  it("rotates to a fresh token one minute before expiry", () => {
    vi.useFakeTimers();
    const h = harness({ tokens: [TOKEN_A, TOKEN_B] });
    const helmet = h.helmet("rdk-a");
    h.advance(4 * 60_000); // lifetime 5 min − 60 s lead
    expect(latest(helmet.events, "companion.discovery")).toEqual({
      type: "companion.discovery",
      token: TOKEN_B,
      expiresAt: h.now() + 5 * 60_000
    });
  });

  it("sends token null to a paired helmet on attach", async () => {
    const h = harness({ tokens: [TOKEN_A, TOKEN_B] });
    h.helmet("rdk-a");
    const phone = h.phone("acct-a");
    await phone.connection.handle({ type: "companion.pair", code: "123456" });
    const reattached = h.helmet("rdk-a");
    expect(latest(reattached.events, "companion.discovery")).toEqual({
      type: "companion.discovery",
      token: null
    });
  });

  it("stops the beacon when a code pair succeeds", async () => {
    const h = harness({ tokens: [TOKEN_A] });
    const helmet = h.helmet("rdk-a");
    const phone = h.phone("acct-a");
    await phone.connection.handle({ type: "companion.pair", code: "123456" });
    expect(latest(helmet.events, "companion.discovery")).toEqual({
      type: "companion.discovery",
      token: null
    });
  });

  it("does not rotate after detach", () => {
    vi.useFakeTimers();
    const h = harness({ tokens: [TOKEN_A, TOKEN_B] });
    const helmet = h.helmet("rdk-a");
    helmet.detach();
    const sent = helmet.events.length;
    h.advance(10 * 60_000);
    expect(helmet.events.length).toBe(sent);
  });

  it("issues a fresh discovery token on unpair", async () => {
    const h = harness({ tokens: [TOKEN_A, TOKEN_B] });
    const helmet = h.helmet("rdk-a");
    const phone = h.phone("acct-a");
    await phone.connection.handle({ type: "companion.pair", code: "123456" });
    await phone.connection.handle({ type: "companion.unpair" });
    expect(latest(helmet.events, "companion.discovery")).toMatchObject({ token: TOKEN_B });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/companion-registry.test.ts`
Expected: FAIL — first on the compile error for `speak` (fix harness call sites), then on missing `companion.discovery` events.

- [ ] **Step 4: Implement**

In `server/companion-registry.ts`:

```ts
import { randomBytes, randomInt } from "node:crypto";
import type { CompanionDiscoveryEvent /* existing imports */ } from "../shared/agent";

export type HelmetPeer = {
  deviceId: string;
  deviceLabel: string;
  send(event: CompanionPairingEvent | CompanionDiscoveryEvent | PhoneLocationEvent | PhoneLocationStatusEvent): void;
  speak(text: string): void;
};

type DiscoveryToken = { token: string; deviceId: string; expiresAt: number; helmet: HelmetSession };

const DISCOVERY_REFRESH_LEAD_MS = 60_000;

function defaultRandomToken(): string {
  return randomBytes(16).toString("hex");
}
```

Inside `createCompanionRegistry` (new option `randomToken`, validated like `randomCode` — throw unless `/^[0-9a-f]{32}$/`):

```ts
const randomToken = options.randomToken ?? defaultRandomToken;
const discoveryTokens = new Map<string, DiscoveryToken>();
const tokenByDevice = new Map<string, string>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelRefresh(deviceId: string): void {
  const timer = refreshTimers.get(deviceId);
  if (timer !== undefined) clearTimer(timer);
  refreshTimers.delete(deviceId);
}

function deleteDeviceToken(deviceId: string): void {
  const token = tokenByDevice.get(deviceId);
  if (token !== undefined) discoveryTokens.delete(token);
  tokenByDevice.delete(deviceId);
  cancelRefresh(deviceId);
}

function expireDiscoveryTokens(at: number): void {
  for (const [token, entry] of discoveryTokens) {
    if (at >= entry.expiresAt) {
      discoveryTokens.delete(token);
      if (tokenByDevice.get(entry.deviceId) === token) tokenByDevice.delete(entry.deviceId);
    }
  }
}

function issueDiscoveryToken(deviceId: string, helmet: HelmetSession, reuseUnexpired: boolean): DiscoveryToken {
  const at = clock();
  expireDiscoveryTokens(at);
  const currentToken = tokenByDevice.get(deviceId);
  const current = currentToken === undefined ? undefined : discoveryTokens.get(currentToken);
  if (reuseUnexpired && current && at < current.expiresAt) {
    const replacement = { ...current, helmet };
    discoveryTokens.set(current.token, replacement);
    return replacement;
  }
  deleteDeviceToken(deviceId);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const token = randomToken();
    if (!/^[0-9a-f]{32}$/.test(token)) throw new Error("Companion discovery token source must return 32 hex chars");
    if (discoveryTokens.has(token)) continue;
    const entry = { token, deviceId, expiresAt: at + pairLifetimeMs, helmet };
    discoveryTokens.set(token, entry);
    tokenByDevice.set(deviceId, token);
    return entry;
  }
  throw new Error("Unable to allocate a unique companion discovery token");
}

function scheduleDiscoveryRefresh(entry: DiscoveryToken): void {
  cancelRefresh(entry.deviceId);
  const delay = Math.max(0, entry.expiresAt - DISCOVERY_REFRESH_LEAD_MS - clock());
  refreshTimers.set(
    entry.deviceId,
    setTimer(() => {
      refreshTimers.delete(entry.deviceId);
      const helmet = helmets.get(entry.deviceId);
      if (!helmet || helmet !== entry.helmet) return;
      if (options.store.bindingForDevice(entry.deviceId)) return;
      if (tokenByDevice.get(entry.deviceId) !== entry.token) return;
      startDiscovery(entry.deviceId, helmet, false);
    }, delay)
  );
}

function sendDiscovery(helmet: HelmetSession, entry: DiscoveryToken | null): boolean {
  return sendHelmetEvent(
    helmet,
    entry === null
      ? { type: "companion.discovery", token: null }
      : { type: "companion.discovery", token: entry.token, expiresAt: entry.expiresAt }
  );
}

function startDiscovery(deviceId: string, helmet: HelmetSession, reuseUnexpired: boolean): void {
  const entry = issueDiscoveryToken(deviceId, helmet, reuseUnexpired);
  if (!sendDiscovery(helmet, entry)) return;
  scheduleDiscoveryRefresh(entry);
}

function stopDiscovery(deviceId: string): void {
  deleteDeviceToken(deviceId);
  const helmet = helmets.get(deviceId);
  if (helmet) sendDiscovery(helmet, null);
}
```

Wire the lifecycle:

- `attachHelmet`, after the existing `sendPairing(helmet, entry, Boolean(binding))`: `if (binding) { deleteDeviceToken(peer.deviceId); sendDiscovery(helmet, null); } else { startDiscovery(peer.deviceId, helmet, !existingBinding); }`
- `attachHelmet`'s detach closure and `markHelmetBroken`: add `cancelRefresh(peer.deviceId)` (token entry survives for reuse; also add `expireDiscoveryTokens(clock())` beside the existing `expireCodes` call in the no-binding branch).
- `handlePair`, right after `deleteCode(code); pendingPairCodes.delete(code);`: `stopDiscovery(entry.deviceId);`
- `markHelmetUnpaired`, after `sendPairing(helmet, entry, false)`: `startDiscovery(deviceId, helmet, false);`
- `close()`: clear `discoveryTokens`, `tokenByDevice`, and every `refreshTimers` timer.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/companion-registry.test.ts`
Expected: PASS (all pre-existing tests too — the harness change must not disturb them).

- [ ] **Step 6: Commit**

```bash
git add server/companion-registry.ts tests/companion-registry.test.ts
git commit -m "feat(companion): issue rotating discovery tokens to unpaired helmets"
```

---

### Task 5: Registry — `pairDiscover`, confirm slot, and voice resolution

**Files:**

- Modify: `server/companion-registry.ts`
- Test: `tests/companion-registry.test.ts`

**Interfaces:**

- Consumes: Task 4's token table and `stopDiscovery`; Task 3's `matchPairConfirmReply` (import from `./device-actions`); Task 2's `companion.pairDiscover` client event.
- Produces:
  - `CompanionRegistry` gains `handleRiderUtterance(deviceId: string, text: string): void` (Task 6 wires it).
  - `createCompanionRegistry` options gain `confirmLifetimeMs?: number` (default `30_000`).
  - Exported speech constants: `PAIR_CONFIRM_PROMPT = '检测到配对请求，请说"确认"。'` and `PAIR_CONFIRM_OK_SPEECH = "已配对。"`.
  - `connection.handle` accepts `companion.pairDiscover` (lifecycle event, like `companion.pair`).

**Behavior being built:** `handlePairDiscover(session, token)` — rate-limit gate first (`pairingBlocked` → `pair.attempts`); unknown/expired token → `recordPairFailure` + `pair.code`; helmet offline → `pair.helmetOffline`; other-account slot → `pair.busy`; same-account slot → re-speak prompt, keep deadline; otherwise occupy slot `{accountId, expiresAt: at + confirmLifetimeMs}`, start its timer, speak the prompt. `handleRiderUtterance` — no slot or no match → no-op; 取消 → clear slot, `pair.declined`; 确认 → clear slot and run the bind through `enqueueAccount(accountId, ...)` sharing `handlePair`'s post-`store.bind` sequence (extract the shared helper `completeBind(session, deviceId, at)` = store.bind + failure send `pair.persistence` / success: clearPairFailures, phone reset, notifyDisplaced, sendPairing(paired:true) via `currentPairingEntry`, stopDiscovery, reconcileAccount, log). After a confirm-bind success the helmet also speaks `已配对。`. Timer expiry → clear slot + `pair.timeout`. Helmet detach/broken with a pending slot → clear + `pair.helmetOffline` to the slot's phone. Phone detach → clear that account's slots. `close()` clears slot timers.

- [ ] **Step 1: Write the failing tests**

```ts
describe("companion discovery pairing confirm", () => {
  const TOKEN_A = "a".repeat(32);

  async function discover(h: Harness, accountId = "acct-a") {
    const helmet = h.helmet("rdk-a");
    const phone = h.phone(accountId);
    await phone.connection.handle({ type: "companion.pairDiscover", token: TOKEN_A });
    return { helmet, phone };
  }

  it("binds after the rider speaks 确认", async () => {
    const h = harness({ tokens: [TOKEN_A] });
    const { helmet, phone } = await discover(h);
    expect(helmet.spoken).toEqual(['检测到配对请求，请说"确认"。']);

    h.registry.handleRiderUtterance("rdk-a", "确认");
    await vi.waitFor(() => expect(h.store.bindingForAccount("acct-a")?.deviceId).toBe("rdk-a"));
    expect(latest(phone.events, "companion.status")).toMatchObject({ state: "ready" });
    expect(latest(helmet.events, "companion.pairing")).toMatchObject({ paired: true });
    expect(latest(helmet.events, "companion.discovery")).toEqual({ type: "companion.discovery", token: null });
    expect(helmet.spoken.at(-1)).toBe("已配对。");
  });

  it("declines on 取消", async () => {
    const h = harness({ tokens: [TOKEN_A] });
    const { phone } = await discover(h);
    h.registry.handleRiderUtterance("rdk-a", "取消");
    expect(latest(phone.events, "companion.error")).toMatchObject({ code: "pair.declined" });
    expect(h.store.bindingForAccount("acct-a")).toBeUndefined();
  });

  it("times out after 30 seconds of silence", async () => {
    vi.useFakeTimers();
    const h = harness({ tokens: [TOKEN_A] });
    const { phone } = await discover(h);
    h.advance(30_000);
    expect(latest(phone.events, "companion.error")).toMatchObject({ code: "pair.timeout" });
    h.registry.handleRiderUtterance("rdk-a", "确认");
    expect(h.store.bindingForAccount("acct-a")).toBeUndefined();
  });

  it("answers pair.busy to a second account and stays bound to the first", async () => {
    const h = harness({ tokens: [TOKEN_A] });
    const { helmet } = await discover(h, "acct-a");
    const rival = h.phone("acct-b", "203.0.113.99");
    await rival.connection.handle({ type: "companion.pairDiscover", token: TOKEN_A });
    expect(latest(rival.events, "companion.error")).toMatchObject({ code: "pair.busy" });
    h.registry.handleRiderUtterance("rdk-a", "确认");
    await vi.waitFor(() => expect(h.store.bindingForAccount("acct-a")?.deviceId).toBe("rdk-a"));
    expect(h.store.bindingForAccount("acct-b")).toBeUndefined();
    expect(helmet.spoken.filter((line) => line.includes("配对请求")).length).toBe(1);
  });

  it("re-speaks the prompt for a same-account re-tap without resetting the deadline", async () => {
    vi.useFakeTimers();
    const h = harness({ tokens: [TOKEN_A] });
    const { helmet, phone } = await discover(h);
    h.advance(20_000);
    await phone.connection.handle({ type: "companion.pairDiscover", token: TOKEN_A });
    expect(helmet.spoken).toEqual(['检测到配对请求，请说"确认"。', '检测到配对请求，请说"确认"。']);
    h.advance(10_000); // original deadline passes
    expect(latest(phone.events, "companion.error")).toMatchObject({ code: "pair.timeout" });
  });

  it("rejects an unknown token as pair.code and rate-limits", async () => {
    const h = harness({ tokens: [TOKEN_A] });
    h.helmet("rdk-a");
    const phone = h.phone("acct-a");
    for (let i = 0; i < 5; i += 1) {
      await phone.connection.handle({ type: "companion.pairDiscover", token: "f".repeat(32) });
    }
    expect(latest(phone.events, "companion.error")).toMatchObject({ code: "pair.code" });
    await phone.connection.handle({ type: "companion.pairDiscover", token: TOKEN_A });
    expect(latest(phone.events, "companion.error")).toMatchObject({ code: "pair.attempts" });
  });

  it("reports pair.helmetOffline when the helmet detaches mid-confirm", async () => {
    const h = harness({ tokens: [TOKEN_A] });
    const { helmet, phone } = await discover(h);
    helmet.detach();
    expect(latest(phone.events, "companion.error")).toMatchObject({ code: "pair.helmetOffline" });
    h.registry.handleRiderUtterance("rdk-a", "确认");
    expect(h.store.bindingForAccount("acct-a")).toBeUndefined();
  });

  it("ignores 确认 when nothing is pending", () => {
    const h = harness({ tokens: [TOKEN_A] });
    const helmet = h.helmet("rdk-a");
    h.registry.handleRiderUtterance("rdk-a", "确认");
    expect(helmet.spoken).toEqual([]);
    expect(h.store.bindingForDevice("rdk-a")).toBeUndefined();
  });

  it("displaces an existing binding through a discovery pair", async () => {
    const h = harness({ tokens: [TOKEN_A, "b".repeat(32)] });
    const helmet = h.helmet("rdk-a");
    const first = h.phone("acct-a");
    await first.connection.handle({ type: "companion.pair", code: "123456" });
    // Paired → beacon stopped; unpair to restart discovery for the second phone.
    await first.connection.handle({ type: "companion.unpair" });
    const second = h.phone("acct-b", "203.0.113.99");
    await second.connection.handle({ type: "companion.pairDiscover", token: "b".repeat(32) });
    h.registry.handleRiderUtterance("rdk-a", "确认");
    await vi.waitFor(() => expect(h.store.bindingForAccount("acct-b")?.deviceId).toBe("rdk-a"));
    expect(helmet.events.filter((event) => event.type === "companion.pairing").at(-1)).toMatchObject({
      paired: true
    });
  });
});
```

(Registry `close()` in `afterEach` already guards timer leaks; keep `vi.useRealTimers()` in the existing `afterEach`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/companion-registry.test.ts`
Expected: FAIL — `companion.pairDiscover` unhandled, `handleRiderUtterance` missing, `spoken` empty.

- [ ] **Step 3: Implement**

In `server/companion-registry.ts`:

```ts
import { matchPairConfirmReply } from "./device-actions";

export const PAIR_CONFIRM_PROMPT = '检测到配对请求，请说"确认"。';
export const PAIR_CONFIRM_OK_SPEECH = "已配对。";
const DEFAULT_CONFIRM_LIFETIME_MS = 30_000;

type PendingConfirm = { accountId: string; expiresAt: number; timer: ReturnType<typeof setTimeout> };
```

Inside the factory:

```ts
const confirmLifetimeMs = options.confirmLifetimeMs ?? DEFAULT_CONFIRM_LIFETIME_MS;
const pendingConfirms = new Map<string, PendingConfirm>();

function speakHelmet(helmet: HelmetSession, text: string): boolean {
  if (closed || helmets.get(helmet.peer.deviceId) !== helmet) return false;
  try {
    helmet.peer.speak(text);
    return true;
  } catch {
    markHelmetBroken(helmet);
    options.log?.warn("companion helmet speech failed", { deviceId: helmet.peer.deviceId });
    return false;
  }
}

function clearPendingConfirm(deviceId: string, notify?: { code: string; detail: string }): void {
  const pending = pendingConfirms.get(deviceId);
  if (!pending) return;
  pendingConfirms.delete(deviceId);
  clearTimer(pending.timer);
  if (!notify) return;
  const phone = companions.get(pending.accountId);
  if (phone) sendError(phone, notify.code, notify.detail);
}

async function completeBind(session: CompanionSession, deviceId: string, at: number): Promise<void> {
  let result: Awaited<ReturnType<CompanionBindingStore["bind"]>>;
  try {
    result = await options.store.bind(session.peer.accountId, deviceId, at);
  } catch {
    reconcileAccount(session.peer.accountId);
    sendError(session, "pair.persistence", "Pairing could not be persisted");
    return;
  }
  clearPairFailures(session);
  const currentPhone = companions.get(session.peer.accountId);
  if (currentPhone) {
    currentPhone.sharing = false;
    currentPhone.stopped = false;
    cancelStale(currentPhone);
  }
  notifyDisplaced(result.displaced, session.peer.accountId, deviceId);
  const helmet = helmets.get(deviceId);
  const currentCode = codeByDevice.get(deviceId);
  const codeEntry = currentCode ? pairCodes.get(currentCode) : undefined;
  if (helmet && codeEntry) sendPairing(helmet, codeEntry, true);
  stopDiscovery(deviceId);
  reconcileAccount(session.peer.accountId);
  options.log?.info("companion pairing changed", {
    accountId: session.peer.accountId,
    deviceId,
    displaced: result.displaced.length
  });
}

async function handlePairDiscover(session: CompanionSession, token: string): Promise<void> {
  const at = clock();
  if (pairingBlocked(session, at)) {
    sendError(session, "pair.attempts", "Too many pairing attempts");
    return;
  }
  expireDiscoveryTokens(at);
  const entry = discoveryTokens.get(token);
  if (!entry || at >= entry.expiresAt) {
    recordPairFailure(session, at);
    sendError(session, "pair.code", "Discovery token is invalid or expired");
    return;
  }
  const helmet = helmets.get(entry.deviceId);
  if (!helmet || helmet !== entry.helmet) {
    sendError(session, "pair.helmetOffline", "Helmet is temporarily offline");
    return;
  }
  const pending = pendingConfirms.get(entry.deviceId);
  if (pending && pending.accountId !== session.peer.accountId) {
    sendError(session, "pair.busy", "Another phone is pairing with this helmet");
    return;
  }
  if (pending) {
    speakHelmet(helmet, PAIR_CONFIRM_PROMPT);
    return;
  }
  const deviceId = entry.deviceId;
  const timer = setTimer(() => {
    clearPendingConfirm(deviceId, { code: "pair.timeout", detail: "Pairing confirmation timed out" });
  }, confirmLifetimeMs);
  pendingConfirms.set(deviceId, { accountId: session.peer.accountId, expiresAt: at + confirmLifetimeMs, timer });
  if (!speakHelmet(helmet, PAIR_CONFIRM_PROMPT)) {
    clearPendingConfirm(deviceId, { code: "pair.helmetOffline", detail: "Helmet is temporarily offline" });
  }
}
```

Registry method (added to the `registry` object and the `CompanionRegistry` type):

```ts
    handleRiderUtterance(deviceId, text) {
      const pending = pendingConfirms.get(deviceId);
      if (!pending || closed) return;
      const reply = matchPairConfirmReply(text);
      if (reply === undefined) return;
      if (clock() >= pending.expiresAt) return; // its own timer will notify
      clearPendingConfirm(deviceId);
      const phone = companions.get(pending.accountId);
      if (reply === "decline") {
        if (phone) sendError(phone, "pair.declined", "Pairing was declined on the helmet");
        return;
      }
      const helmet = helmets.get(deviceId);
      void enqueueAccount(pending.accountId, async () => {
        const session = companions.get(pending.accountId);
        if (!session) return;
        await completeBind(session, deviceId, clock());
        if (options.store.bindingForAccount(pending.accountId)?.deviceId === deviceId && helmet) {
          speakHelmet(helmet, PAIR_CONFIRM_OK_SPEECH);
        }
      });
    },
```

Wire the cleanup paths:

- `connection.handle` switch: add `case "companion.pairDiscover": await handlePairDiscover(session, event.token); return;` and include it in the `lifecycleEvent` check alongside `companion.pair`/`companion.unpair`.
- `handlePair` (code path): keep as-is — a code pair while a discovery confirm is pending on the same device also calls `stopDiscovery`; additionally call `clearPendingConfirm(entry.deviceId)` beside it.
- `attachHelmet` detach closure and `markHelmetBroken`: `clearPendingConfirm(deviceId, { code: "pair.helmetOffline", detail: "Helmet is temporarily offline" })`.
- `detachCompanion`: iterate `pendingConfirms` and `clearPendingConfirm(deviceId)` for entries whose `accountId === session.peer.accountId`.
- `close()`: clear every pending confirm timer, then `pendingConfirms.clear()`.
- `completeBind` refactor: rewrite `handlePair`'s post-store.bind tail to call `completeBind` (keeping its code-specific `deleteCode`/`pendingPairCodes` handling around it) so the two paths cannot drift.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/companion-registry.test.ts`
Expected: PASS, including all pre-existing pairing lifecycle tests (the `completeBind` refactor must not change code-path behavior).

- [ ] **Step 5: Commit**

```bash
git add server/companion-registry.ts tests/companion-registry.test.ts
git commit -m "feat(companion): pairDiscover with spoken confirm at the helmet"
```

---

### Task 6: Relay wiring — helmet speech and rider-utterance tap

**Files:**

- Modify: `server/session-controller.ts` (hooks type ~line 29, registration ~line 687, `serverEvent` callback ~line 538)
- Modify: `server/index.ts` (hooks construction ~line 781)
- Test: `tests/session.test.ts`

**Interfaces:**

- Consumes: `HelmetPeer.speak` (Task 4), `registry.handleRiderUtterance` (Task 5).
- Produces: `AgentSessionHooks` gains `onRiderUtterance?(deviceId: string, text: string): void`.

- [ ] **Step 1: Write the failing tests**

In `tests/session.test.ts` (reuse its existing fake-client + `makeProvider` helpers and the registration flow its helmet tests use — the file already attaches `HelmetPeer`s via a registry-backed hook):

```ts
describe("companion discovery session wiring", () => {
  it("supplies a speak callback that routes through provider.speakNavLine", async () => {
    const spoken: string[] = [];
    let peer: HelmetPeer | undefined;
    const provider = makeProvider({ speakNavLine: (text: string) => void spoken.push(text) });
    const controller = new AgentSessionController(
      fakeClient(),
      () => provider,
      undefined,
      "203.0.113.5",
      undefined,
      undefined,
      {
        deviceRegistrationAuthorized: true,
        onDeviceRegistered: (registered) => {
          peer = registered;
          return () => undefined;
        }
      }
    );
    await controller.handleMessage(startEvent({ deviceId: "rdk-11111111-1111-4111-8111-111111111111" }), false);
    peer?.speak("检测到配对请求");
    expect(spoken).toEqual(["检测到配对请求"]);
  });

  it("forwards final rider transcripts to onRiderUtterance with the registered deviceId", async () => {
    const utterances: Array<{ deviceId: string; text: string }> = [];
    let serverEventTap: ((payload: unknown, bytes: number) => void) | undefined;
    const factory: ProviderFactory = (_client, telemetry) => {
      serverEventTap = telemetry.serverEvent;
      return makeProvider();
    };
    const controller = new AgentSessionController(
      fakeClient(),
      factory,
      undefined,
      "203.0.113.5",
      undefined,
      undefined,
      {
        deviceRegistrationAuthorized: true,
        onDeviceRegistered: () => () => undefined,
        onRiderUtterance: (deviceId, text) => void utterances.push({ deviceId, text })
      }
    );
    await controller.handleMessage(startEvent({ deviceId: "rdk-11111111-1111-4111-8111-111111111111" }), false);
    serverEventTap?.(
      { type: "transcript", turnId: "t1", deliveryId: "d1", speaker: "rider", text: "确认", final: true },
      10
    );
    serverEventTap?.(
      { type: "transcript", turnId: "t1", deliveryId: "d2", speaker: "rider", text: "确", final: false },
      10
    );
    serverEventTap?.(
      { type: "transcript", turnId: "t2", deliveryId: "d3", speaker: "agent", text: "确认", final: true },
      10
    );
    expect(utterances).toEqual([{ deviceId: "rdk-11111111-1111-4111-8111-111111111111", text: "确认" }]);
  });
});
```

Match the constructor/argument shapes to how `tests/session.test.ts` already builds controllers (fake client helper name may differ — reuse the file's own helper; deviceId must satisfy `RDK_DEVICE_ID`, copy a valid one from an existing test in the file).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/session.test.ts`
Expected: FAIL — `speak` missing from the registered peer (type error) and no `onRiderUtterance` calls.

- [ ] **Step 3: Implement**

In `server/session-controller.ts`:

- Hooks type: `onRiderUtterance?(deviceId: string, text: string): void;`
- Add field `private registeredDeviceId?: string;`
- Registration block (~line 687): set `this.registeredDeviceId = event.deviceId;` and extend the peer:

```ts
this.detachHelmet = this.hooks?.onDeviceRegistered?.({
  deviceId: event.deviceId,
  deviceLabel: event.deviceLabel?.trim() || "RDK X5",
  send: (payload) => this.sendEphemeral(payload),
  speak: (text) => {
    if (this.acceptingMessages) this.provider.speakNavLine?.(text);
  }
});
```

- `serverEvent` callback (~line 538), after the existing telemetry lines:

```ts
if (this.registeredDeviceId && isFinalRiderTranscript(payload)) {
  this.hooks?.onRiderUtterance?.(this.registeredDeviceId, payload.text);
}
```

with a module-level guard beside the file's other payload guards:

```ts
function isFinalRiderTranscript(payload: unknown): payload is { text: string } {
  if (!payload || typeof payload !== "object") return false;
  const event = payload as { type?: unknown; speaker?: unknown; final?: unknown; text?: unknown };
  return (
    event.type === "transcript" && event.speaker === "rider" && event.final === true && typeof event.text === "string"
  );
}
```

In `server/index.ts` (~line 781):

```ts
      onDeviceRegistered: (peer) => companionRegistry.attachHelmet(peer),
      onRiderUtterance: (deviceId, text) => companionRegistry.handleRiderUtterance(deviceId, text)
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/session.test.ts && npx tsc --noEmit`
Expected: PASS. (`tsc` catches any remaining `HelmetPeer` construction missing `speak` — `tests/session.test.ts` builds registry-backed peers; fix any the compiler flags.)

- [ ] **Step 5: Commit**

```bash
git add server/session-controller.ts server/index.ts tests/session.test.ts
git commit -m "feat(relay): wire helmet speech and rider utterances to the companion registry"
```

---

### Task 7: Board — discovery advertiser core

**Files:**

- Create: `rdk/agent/src/discovery/advertiser.ts`
- Test: `tests/rdk-discovery-advertiser.test.ts`

**Interfaces:**

- Produces (Task 8 consumes):

```ts
export type DiscoveryTransport = {
  readonly name: string; // "mdns" (Phase 2 adds "ble")
  start(token: string): Promise<void>; // idempotent re-start with a NEW token = restart
  stop(): Promise<void>;
};
export type DiscoveryAdvertiser = {
  setToken(token: string | null): void;
  status(): string; // "off" | joined active transport names, e.g. "mdns"
  close(): Promise<void>;
};
export function createDiscoveryAdvertiser(options: {
  transports: DiscoveryTransport[];
  onStatus?: (status: string) => void;
  log?: (line: string) => void;
}): DiscoveryAdvertiser;
```

**Behavior:** `setToken(token)` starts every transport with the token; `setToken(null)` stops them; a newer `setToken` supersedes an in-flight one (per-transport serialized op queue — teardown must work from wherever a stop interrupts a startup, same rule as the recent rdk-vision fixes). A transport whose `start` rejects is logged (`[discovery] mdns failed: <message>`, never the token) and excluded from `status()` until a later `setToken` succeeds; other transports carry on. `status()` reflects currently-advertising transports; `onStatus` fires on every status change. `close()` stops everything and resolves when drained; `setToken` after `close` is a no-op.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { createDiscoveryAdvertiser, type DiscoveryTransport } from "../rdk/agent/src/discovery/advertiser";

type FakeTransport = DiscoveryTransport & {
  calls: string[];
  failNextStart(message: string): void;
  gate(): { release(): void };
};

function fakeTransport(name: string): FakeTransport {
  const calls: string[] = [];
  let failure: string | undefined;
  let gate: Promise<void> | undefined;
  let releaseGate: (() => void) | undefined;
  return {
    name,
    calls,
    failNextStart(message) {
      failure = message;
    },
    gate() {
      gate = new Promise((resolve) => {
        releaseGate = resolve;
      });
      return { release: () => releaseGate?.() };
    },
    async start(token) {
      calls.push(`start:${token}`);
      if (gate) {
        const wait = gate;
        gate = undefined;
        await wait;
      }
      if (failure) {
        const message = failure;
        failure = undefined;
        throw new Error(message);
      }
    },
    async stop() {
      calls.push("stop");
    }
  };
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("discovery advertiser", () => {
  const TOKEN = "a".repeat(32);

  it("starts every transport with the token and reports status", async () => {
    const mdns = fakeTransport("mdns");
    const statuses: string[] = [];
    const advertiser = createDiscoveryAdvertiser({ transports: [mdns], onStatus: (s) => statuses.push(s) });
    advertiser.setToken(TOKEN);
    await settled();
    expect(mdns.calls).toEqual([`start:${TOKEN}`]);
    expect(advertiser.status()).toBe("mdns");
    expect(statuses).toEqual(["mdns"]);
    await advertiser.close();
  });

  it("stops on null and reports off", async () => {
    const mdns = fakeTransport("mdns");
    const advertiser = createDiscoveryAdvertiser({ transports: [mdns] });
    advertiser.setToken(TOKEN);
    advertiser.setToken(null);
    await settled();
    expect(mdns.calls).toEqual([`start:${TOKEN}`, "stop"]);
    expect(advertiser.status()).toBe("off");
    await advertiser.close();
  });

  it("tears down cleanly when a stop interrupts a slow start", async () => {
    const mdns = fakeTransport("mdns");
    const gate = mdns.gate();
    const advertiser = createDiscoveryAdvertiser({ transports: [mdns] });
    advertiser.setToken(TOKEN);
    advertiser.setToken(null);
    gate.release();
    await settled();
    expect(mdns.calls).toEqual([`start:${TOKEN}`, "stop"]);
    expect(advertiser.status()).toBe("off");
    await advertiser.close();
  });

  it("keeps other transports alive when one fails, and logs without the token", async () => {
    const mdns = fakeTransport("mdns");
    const flaky = fakeTransport("flaky");
    flaky.failNextStart("dbus unavailable");
    const lines: string[] = [];
    const advertiser = createDiscoveryAdvertiser({ transports: [mdns, flaky], log: (line) => lines.push(line) });
    advertiser.setToken(TOKEN);
    await settled();
    expect(advertiser.status()).toBe("mdns");
    expect(lines.some((line) => line.includes("flaky failed"))).toBe(true);
    expect(lines.every((line) => !line.includes(TOKEN))).toBe(true);
    await advertiser.close();
  });

  it("rotating the token restarts transports with the new one", async () => {
    const mdns = fakeTransport("mdns");
    const advertiser = createDiscoveryAdvertiser({ transports: [mdns] });
    advertiser.setToken(TOKEN);
    await settled();
    advertiser.setToken("b".repeat(32));
    await settled();
    expect(mdns.calls).toEqual([`start:${TOKEN}`, `start:${"b".repeat(32)}`]);
    await advertiser.close();
  });

  it("close stops transports and disables later setToken", async () => {
    const mdns = fakeTransport("mdns");
    const advertiser = createDiscoveryAdvertiser({ transports: [mdns] });
    advertiser.setToken(TOKEN);
    await advertiser.close();
    advertiser.setToken(TOKEN);
    await settled();
    expect(mdns.calls).toEqual([`start:${TOKEN}`, "stop"]);
    expect(advertiser.status()).toBe("off");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/rdk-discovery-advertiser.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`rdk/agent/src/discovery/advertiser.ts`:

```ts
export type DiscoveryTransport = {
  readonly name: string;
  start(token: string): Promise<void>;
  stop(): Promise<void>;
};

export type DiscoveryAdvertiser = {
  setToken(token: string | null): void;
  status(): string;
  close(): Promise<void>;
};

/**
 * Broadcasts the relay-issued discovery token on every transport. Dumb by
 * design: no retries, no policy — the relay decides WHAT to advertise, this
 * decides only that the radios match the latest instruction, including when a
 * stop lands while a start is still in flight.
 */
export function createDiscoveryAdvertiser(options: {
  transports: DiscoveryTransport[];
  onStatus?: (status: string) => void;
  log?: (line: string) => void;
}): DiscoveryAdvertiser {
  const log = options.log ?? ((line: string) => console.log(line));
  const active = new Set<string>();
  let desired: string | null = null;
  let closed = false;
  let lastStatus = "off";

  const applied = new Map<string, string | null>();
  const queues = new Map<string, Promise<void>>();

  function publishStatus(): void {
    const status =
      active.size === 0
        ? "off"
        : options.transports
            .map((transport) => transport.name)
            .filter((name) => active.has(name))
            .join("+");
    if (status === lastStatus) return;
    lastStatus = status;
    options.onStatus?.(status);
  }

  function reconcile(transport: DiscoveryTransport): void {
    const queue = queues.get(transport.name) ?? Promise.resolve();
    const next = queue.then(async () => {
      const target = closed ? null : desired;
      if (applied.get(transport.name) === target) return;
      try {
        if (target === null) {
          await transport.stop();
          active.delete(transport.name);
        } else {
          await transport.start(target);
          active.add(transport.name);
        }
        applied.set(transport.name, target);
      } catch (error) {
        active.delete(transport.name);
        applied.set(transport.name, null);
        const message = error instanceof Error ? error.message : String(error);
        log(`[discovery] ${transport.name} failed: ${message}`);
      }
      publishStatus();
      if ((closed ? null : desired) !== applied.get(transport.name)) reconcile(transport);
    });
    queues.set(
      transport.name,
      next.catch(() => undefined)
    );
  }

  return {
    setToken(token) {
      if (closed) return;
      desired = token;
      for (const transport of options.transports) reconcile(transport);
    },
    status() {
      return lastStatus;
    },
    async close() {
      closed = true;
      desired = null;
      for (const transport of options.transports) reconcile(transport);
      await Promise.all([...queues.values()]);
    }
  };
}
```

(If a test drives a start/stop/start sequence the simple `applied` comparison misses, tighten inside `reconcile` — the invariant under test is: final transport state always matches the last instruction, one op in flight per transport, stop always reachable.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/rdk-discovery-advertiser.test.ts && npm run check:rdk`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/discovery/advertiser.ts tests/rdk-discovery-advertiser.test.ts
git commit -m "feat(rdk): discovery advertiser with interrupt-safe transport lifecycle"
```

---

### Task 8: Board — mDNS transport, main wiring, HUD status

**Files:**

- Create: `rdk/agent/src/discovery/mdns.ts`
- Modify: `rdk/agent/src/main.ts` (relay `onEvent` ~line 388, `onClosed` ~line 412, shutdown ~line 483, advertiser construction near `createHudServer` ~line 270)
- Modify: `rdk/agent/src/hud/state.ts` (HudState + HudEvent + reducer), `rdk/agent/src/hud/index.html` (status row)
- Modify: `package.json` (deps: `multicast-dns`, devDeps: `@types/multicast-dns`)
- Test: `tests/rdk-discovery-mdns.test.ts`, extend `tests/rdk-hud-state.test.ts`

**Interfaces:**

- Consumes: `DiscoveryTransport`, `createDiscoveryAdvertiser` (Task 7); `CompanionDiscoveryEvent` (Task 1).
- Produces: `createMdnsTransport(options: { port: number; mdnsFactory?: () => MdnsLike; log?: (line: string) => void }): DiscoveryTransport` where

```ts
export type MdnsLike = {
  on(event: "query", listener: (query: { questions: Array<{ name: string; type: string }> }) => void): void;
  respond(response: { answers: MdnsAnswer[] }): void;
  destroy(callback?: () => void): void;
};
export type MdnsAnswer =
  | { name: string; type: "PTR"; ttl: number; data: string }
  | { name: string; type: "SRV"; ttl: number; data: { port: number; target: string } }
  | { name: string; type: "TXT"; ttl: number; data: string[] };
```

HudState gains `discovery: string` (initial `"off"`); HudEvent gains `{ type: "rdk.discovery"; discovery: string }`.

- [ ] **Step 1: Install the dependency**

Run: `npm install multicast-dns && npm install -D @types/multicast-dns`
Expected: both land in `package.json`; lockfile updated.

- [ ] **Step 2: Write the failing mDNS tests**

`tests/rdk-discovery-mdns.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMdnsTransport, type MdnsLike } from "../rdk/agent/src/discovery/mdns";

const TOKEN = "a".repeat(32);
const SERVICE = "_maxhelmet._tcp.local";

function fakeMdns() {
  const responses: Array<{ answers: Array<{ name: string; type: string; data: unknown }> }> = [];
  let onQuery: ((query: { questions: Array<{ name: string; type: string }> }) => void) | undefined;
  let destroyed = false;
  const instance: MdnsLike = {
    on(_event, listener) {
      onQuery = listener;
    },
    respond(response) {
      responses.push(response as (typeof responses)[number]);
    },
    destroy(callback) {
      destroyed = true;
      callback?.();
    }
  };
  return {
    instance,
    responses,
    ask: (name: string, type: string) => onQuery?.({ questions: [{ name, type }] }),
    destroyed: () => destroyed
  };
}

describe("mdns discovery transport", () => {
  it("answers a PTR query with instance, SRV, and a TXT carrying the token", async () => {
    const fake = fakeMdns();
    const transport = createMdnsTransport({ port: 8080, mdnsFactory: () => fake.instance });
    await transport.start(TOKEN);
    fake.ask(SERVICE, "PTR");
    expect(fake.responses.length).toBe(1);
    const answers = fake.responses[0].answers;
    const ptr = answers.find((answer) => answer.type === "PTR");
    const srv = answers.find((answer) => answer.type === "SRV");
    const txt = answers.find((answer) => answer.type === "TXT");
    expect(ptr?.name).toBe(SERVICE);
    expect(String(ptr?.data)).toMatch(/\._maxhelmet\._tcp\.local$/);
    expect((srv?.data as { port: number }).port).toBe(8080);
    expect(txt?.data).toEqual([`dt=${TOKEN}`, "v=1"]);
    await transport.stop();
    expect(fake.destroyed()).toBe(true);
  });

  it("ignores unrelated queries and answers nothing after stop", async () => {
    const fake = fakeMdns();
    const transport = createMdnsTransport({ port: 8080, mdnsFactory: () => fake.instance });
    await transport.start(TOKEN);
    fake.ask("_other._tcp.local", "PTR");
    expect(fake.responses).toEqual([]);
    await transport.stop();
    fake.ask(SERVICE, "PTR");
    expect(fake.responses).toEqual([]);
  });

  it("a restart with a new token answers with the new token only", async () => {
    const fake = fakeMdns();
    let created = 0;
    const transport = createMdnsTransport({
      port: 8080,
      mdnsFactory: () => {
        created += 1;
        return fake.instance;
      }
    });
    await transport.start(TOKEN);
    await transport.start("b".repeat(32));
    fake.ask(SERVICE, "PTR");
    const txt = fake.responses.at(-1)?.answers.find((answer) => answer.type === "TXT");
    expect(txt?.data).toEqual([`dt=${"b".repeat(32)}`, "v=1"]);
    expect(created).toBe(2);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/rdk-discovery-mdns.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the transport**

`rdk/agent/src/discovery/mdns.ts`:

```ts
import { hostname } from "node:os";
import makeMdns from "multicast-dns";
import type { DiscoveryTransport } from "./advertiser";

export type MdnsAnswer =
  | { name: string; type: "PTR"; ttl: number; data: string }
  | { name: string; type: "SRV"; ttl: number; data: { port: number; target: string } }
  | { name: string; type: "TXT"; ttl: number; data: string[] };

export type MdnsLike = {
  on(event: "query", listener: (query: { questions: Array<{ name: string; type: string }> }) => void): void;
  respond(response: { answers: MdnsAnswer[] }): void;
  destroy(callback?: () => void): void;
};

const SERVICE = "_maxhelmet._tcp.local";
const TTL_SECONDS = 120;

/**
 * Advertisement-only responder: the beacon IS the payload (TXT dt=<token>).
 * The SRV port points at the HUD only because SRV needs one; nothing
 * pairing-related listens there. Recreated per start so a token rotation can
 * never answer with a stale token.
 */
export function createMdnsTransport(options: {
  port: number;
  mdnsFactory?: () => MdnsLike;
  log?: (line: string) => void;
}): DiscoveryTransport {
  const factory = options.mdnsFactory ?? (() => makeMdns() as unknown as MdnsLike);
  let current: { instance: MdnsLike; token: string } | undefined;

  async function stop(): Promise<void> {
    const running = current;
    current = undefined;
    if (!running) return;
    await new Promise<void>((resolve) => running.instance.destroy(resolve));
  }

  return {
    name: "mdns",
    async start(token) {
      await stop();
      const instance = factory();
      const target = `${hostname()}.local`;
      const running = { instance, token };
      current = running;
      const instanceName = `Max Helmet ${token.slice(0, 4)}.${SERVICE}`;
      instance.on("query", (query) => {
        if (current !== running) return;
        if (!query.questions.some((question) => question.name === SERVICE || question.name === instanceName)) return;
        instance.respond({
          answers: [
            { name: SERVICE, type: "PTR", ttl: TTL_SECONDS, data: instanceName },
            { name: instanceName, type: "SRV", ttl: TTL_SECONDS, data: { port: options.port, target } },
            { name: instanceName, type: "TXT", ttl: TTL_SECONDS, data: [`dt=${token}`, "v=1"] }
          ]
        });
      });
    },
    stop
  };
}
```

Run: `npx vitest run tests/rdk-discovery-mdns.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing HUD state test**

Extend `tests/rdk-hud-state.test.ts` in its existing reducer style:

```ts
it("tracks discovery transport status", () => {
  const state = reduceHud(initialHudState(), { type: "rdk.discovery", discovery: "mdns" });
  expect(state.discovery).toBe("mdns");
  expect(initialHudState().discovery).toBe("off");
});
```

Run: `npx vitest run tests/rdk-hud-state.test.ts` — expected FAIL.

- [ ] **Step 6: Implement HUD state + page + main wiring**

`rdk/agent/src/hud/state.ts`: add `discovery: string` to `HudState`, `discovery: "off"` in `initialHudState()`, `| { type: "rdk.discovery"; discovery: string }` to `HudEvent`, and a reducer case:

```ts
    case "rdk.discovery":
      return { ...state, discovery: event.discovery };
```

`rdk/agent/src/hud/index.html`: add a status row rendering `state.discovery` beside the companion pairing row (e.g. `配对广播 ${state.discovery}`) — non-secret, no redaction path needed (verify `remoteHudSnapshot` copies it untouched; it operates on `companion` only, so it does).

`rdk/agent/src/main.ts`:

```ts
import { createDiscoveryAdvertiser } from "./discovery/advertiser";
import { createMdnsTransport } from "./discovery/mdns";
```

Near HUD construction (~line 270):

```ts
const advertiser = createDiscoveryAdvertiser({
  transports: [createMdnsTransport({ port: config.hudPort })],
  onStatus: (status) => publishHud({ type: "rdk.discovery", discovery: status })
});
```

In relay `onEvent` (~line 388), beside the navigation routing:

```ts
if (event.type === "companion.discovery") {
  advertiser.setToken(event.token);
}
```

In `onClosed` (~line 412), beside `closeNavigationSession()`: `advertiser.setToken(null);`
In the shutdown path (~line 483, where `shuttingDown = true`): `void advertiser.close();` before the existing teardown, and `hud.close()` stays last.

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run tests/rdk-hud-state.test.ts tests/rdk-hud-render.test.ts tests/rdk-hud-server-security.test.ts && npm run check:rdk`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add rdk/agent/src/discovery/mdns.ts rdk/agent/src/main.ts rdk/agent/src/hud/state.ts rdk/agent/src/hud/index.html package.json package-lock.json tests/rdk-discovery-mdns.test.ts tests/rdk-hud-state.test.ts
git commit -m "feat(rdk): broadcast the discovery token over mDNS with HUD status"
```

---

### Task 9: E2E — discovery arm in the companion navigation test

**Files:**

- Test: `tests/rdk-companion-navigation-e2e.test.ts`

**Interfaces:**

- Consumes: everything relay-side (Tasks 1–5). Proves discover → confirm → bind → location → nav route flow with the same fixtures the code-pair arm uses.

- [ ] **Step 1: Write the failing test**

Add a second `it` beside the existing end-to-end case, reusing the file's harness helpers (registry construction, `WGS_FIXES`, `MOCK_ROUTE` plumbing). Shape:

```ts
it("pairs by discovery + voice confirm, then rides the same nav flow", async () => {
  // 1. Registry with deterministic token source: createCompanionRegistry({..., randomToken: () => "a".repeat(32)}).
  // 2. Attach the helmet exactly as the existing arm does, with speak capture:
  //    spoken: string[] on the helmet peer.
  // 3. Expect the helmet received companion.discovery {token: "a".repeat(32)}.
  // 4. Phone connection: parseCompanionClientEvent(JSON.stringify({type: "companion.pairDiscover", token})) → connection.handle.
  // 5. Expect spoken to end with 检测到配对请求，请说"确认"。
  // 6. registry.handleRiderUtterance(DEVICE_ID, "确认"); await the binding (vi.waitFor on store.bindingForAccount).
  // 7. Expect helmet got companion.pairing {paired: true} AND companion.discovery {token: null}.
  // 8. From here, drive companion.start + the first WGS fix and a nav route exactly as the code-pair arm does,
  //    asserting the same "sharing" → nav.route progression (reuse its helpers/assertions verbatim).
});
```

Follow the existing arm's structure literally — same fixture constants, same event pumps; only the pairing entry differs. The timeline assertion for this arm stops at `nav.route` + first prompt (the full ride timeline stays owned by the original arm; do not duplicate it).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/rdk-companion-navigation-e2e.test.ts`
Expected: the new test FAILS only if any Task 1–5 seam is mis-wired; if it passes first run, force one deliberate failure (e.g. assert token `"b".repeat(32)`) to prove the assertions bite, then restore.

- [ ] **Step 3: Run the full relay suite**

Run: `npx vitest run tests/companion-registry.test.ts tests/companion-protocol.test.ts tests/companion-websocket.test.ts tests/rdk-companion-navigation-e2e.test.ts tests/session.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/rdk-companion-navigation-e2e.test.ts
git commit -m "test(companion): discovery pairing end-to-end through nav route flow"
```

---

### Task 10: iOS — pairDiscover protocol, client action, view-model state

**Files:**

- Modify: `ios/MaxHelmet/Companion/RDKCompanionProtocol.swift`
- Modify: `ios/MaxHelmet/Companion/RDKCompanionClient.swift` (~line 181, beside `pair(code:)`)
- Modify: `ios/MaxHelmet/UI/MainViewModel.swift` (client protocol ~line 8, pairing flow ~line 452)
- Test: `ios/MaxHelmetTests/CompanionViewModelTests.swift`, `ios/MaxHelmetTests/CompanionSettingsTests.swift`

**Interfaces:**

- Consumes: relay accepts `companion.pairDiscover` (Task 2/5) and answers `companion.status`/`companion.error` with the new codes.
- Produces (Task 11 consumes): `MainViewModel.pairDiscoveredHelmet(token: String)`; view-model published pairing phase includes a waiting-for-confirm state; error-code → copy mapping for `pair.busy` / `pair.declined` / `pair.timeout`.

- [ ] **Step 1: Write the failing tests**

In `ios/MaxHelmetTests/CompanionViewModelTests.swift`, following the file's existing fake-client pattern (it already fakes the companion client protocol for `pair(code:)`):

```swift
func testPairDiscoverSendsTokenThroughClient() {
    // Arrange the same logged-in, unpaired fixture the existing pair tests use.
    model.pairDiscoveredHelmet(token: String(repeating: "a", count: 32))
    drainMainQueue()
    XCTAssertEqual(fakeClient.pairDiscoverTokens, [String(repeating: "a", count: 32)])
}

func testPairDiscoverRejectsMalformedToken() {
    model.pairDiscoveredHelmet(token: "not-a-token")
    drainMainQueue()
    XCTAssertEqual(fakeClient.pairDiscoverTokens, [])
}

func testPairDiscoverEntersWaitingStateUntilStatusArrives() {
    model.pairDiscoveredHelmet(token: String(repeating: "a", count: 32))
    drainMainQueue()
    XCTAssertTrue(model.isAwaitingHelmetConfirm)
    deliver(status: .paired(deviceId: "rdk-x", label: "Helmet"))  // file's existing status-delivery helper
    XCTAssertFalse(model.isAwaitingHelmetConfirm)
}

func testDiscoveryErrorCodesMapToReadableCopy() {
    XCTAssertEqual(MainViewModel.companionErrorCopy(code: "pair.busy"), "头盔正忙，请稍后再试")
    XCTAssertEqual(MainViewModel.companionErrorCopy(code: "pair.declined"), "头盔侧已取消配对")
    XCTAssertEqual(MainViewModel.companionErrorCopy(code: "pair.timeout"), "确认超时，请重试")
}
```

Adapt fixture/helper names to what `CompanionViewModelTests.swift` actually defines (fake client, main-queue drain, status delivery) — mirror the neighboring `pair(code:)` tests one-for-one. Add `pairDiscoverTokens` recording to the file's fake client.

- [ ] **Step 2: Run to verify failure**

Run: `cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17' 2>&1 | tail -20`
Expected: FAIL — `pairDiscoveredHelmet`/`pairDiscover` unresolved.

- [ ] **Step 3: Implement**

`RDKCompanionProtocol.swift`, beside `pairMessage(code:)`:

```swift
    static func pairDiscoverMessage(token: String) -> String? {
        guard token.count == 32, token.allSatisfy({ $0.isHexDigit && ($0.isNumber || $0.isLowercase) }) else {
            return nil
        }
        return encode(["type": "companion.pairDiscover", "token": token])
    }
```

`RDKCompanionClient.swift`, beside `pair(code:)` (same shape, same action family — a discovery pair and a code pair are the same lifecycle action):

```swift
    func pairDiscover(token: String) {
        onMain { [weak self] in
            guard let self,
                  let message = RDKCompanionProtocol.pairDiscoverMessage(token: token) else {
                return
            }
            self.advanceActionEpoch(.pairing)
            self.sendAction(message, family: .pairing)
        }
    }
```

`MainViewModel.swift`:

- Client protocol (line ~8): add `func pairDiscover(token: String)`.
- Add `@Published private(set) var isAwaitingHelmetConfirm = false`.
- `pairDiscoveredHelmet(token:)` mirrors `pairHelmet()`'s guard chain (`performPairHelmet` ~line 471) minus the six-digit code check, with a token guard reusing the protocol validator (`RDKCompanionProtocol.pairDiscoverMessage(token:) != nil`); on success set `isAwaitingHelmetConfirm = true` and call `companionClient.pairDiscover(token: token)`.
- Clear `isAwaitingHelmetConfirm` wherever the pairing action resolves: on every incoming companion status change and on `companion.error` (find the existing status/error sinks the `pair` flow uses and clear the flag there).
- `static func companionErrorCopy(code: String) -> String?` returning the three new strings above (and `nil` for codes the existing paths already handle); surface it through the same error-copy path the pairing section shows today.

- [ ] **Step 4: Run to verify pass**

Run: the same `xcodebuild test` command.
Expected: PASS (whole iOS suite, not only the new tests).

- [ ] **Step 5: Commit**

```bash
git add ios/MaxHelmet/Companion/RDKCompanionProtocol.swift ios/MaxHelmet/Companion/RDKCompanionClient.swift ios/MaxHelmet/UI/MainViewModel.swift ios/MaxHelmetTests/CompanionViewModelTests.swift ios/MaxHelmetTests/CompanionSettingsTests.swift
git commit -m "feat(ios-companion): pairDiscover action with awaiting-confirm state"
```

---

### Task 11: iOS — Bonjour discovery and pairing UI

**Files:**

- Create: `ios/MaxHelmet/Companion/Discovery/HelmetDiscovery.swift`
- Create: `ios/MaxHelmet/Companion/Discovery/BonjourHelmetDiscovery.swift`
- Modify: `ios/MaxHelmet/UI/MainViewModel.swift`, `ios/MaxHelmet/UI/AgentSettingsPanel.swift` (companion section, ~lines 180–280)
- Modify: `ios/MaxHelmet/Info.plist`, `ios/MaxHelmet/Info-Debug.plist`
- Test: `ios/MaxHelmetTests/HelmetDiscoveryTests.swift` (new)

**Interfaces:**

- Consumes: `MainViewModel.pairDiscoveredHelmet(token:)`, `isAwaitingHelmetConfirm` (Task 10).
- Produces:

```swift
struct DiscoveredHelmet: Equatable, Identifiable {
    let token: String       // 32 lowercase hex chars
    let transport: String   // "mdns" (Phase 2 adds "ble")
    var id: String { token }
}

protocol HelmetDiscovering: AnyObject {
    var onUpdate: (([DiscoveredHelmet]) -> Void)? { get set }
    func start()
    func stop()
}
```

- [ ] **Step 1: Write the failing tests**

`ios/MaxHelmetTests/HelmetDiscoveryTests.swift` — test the pure parts (per `ios-build-and-test` constraints, no UI hosting):

```swift
import XCTest
@testable import MaxHelmet

final class HelmetDiscoveryTests: XCTestCase {
    func testTxtRecordParsing() {
        let token = String(repeating: "a", count: 32)
        XCTAssertEqual(BonjourHelmetDiscovery.token(fromTxt: ["dt": token, "v": "1"]), token)
        XCTAssertNil(BonjourHelmetDiscovery.token(fromTxt: ["dt": "short", "v": "1"]))
        XCTAssertNil(BonjourHelmetDiscovery.token(fromTxt: ["v": "1"]))
        XCTAssertNil(BonjourHelmetDiscovery.token(fromTxt: ["dt": token.uppercased(), "v": "1"]))
    }

    func testDedupeKeepsOneEntryPerToken() {
        let token = String(repeating: "a", count: 32)
        let merged = DiscoveredHelmet.merged([
            DiscoveredHelmet(token: token, transport: "mdns"),
            DiscoveredHelmet(token: token, transport: "mdns"),
            DiscoveredHelmet(token: String(repeating: "b", count: 32), transport: "mdns")
        ])
        XCTAssertEqual(merged.count, 2)
    }
}
```

Run the `xcodebuild test` command — expected FAIL (types missing).

- [ ] **Step 2: Implement discovery**

`HelmetDiscovery.swift`: the `DiscoveredHelmet` struct + `HelmetDiscovering` protocol above, plus:

```swift
extension DiscoveredHelmet {
    static func merged(_ items: [DiscoveredHelmet]) -> [DiscoveredHelmet] {
        var seen = Set<String>()
        return items.filter { seen.insert($0.token).inserted }
    }
}
```

`BonjourHelmetDiscovery.swift`:

```swift
import Network

/// Browses _maxhelmet._tcp and surfaces one DiscoveredHelmet per beacon token.
/// Scan lifetime is owned by the pairing screen: start() on appear, stop() on
/// disappear — no background radio use.
final class BonjourHelmetDiscovery: HelmetDiscovering {
    var onUpdate: (([DiscoveredHelmet]) -> Void)?
    private var browser: NWBrowser?

    static func token(fromTxt txt: [String: String]) -> String? {
        guard let value = txt["dt"], value.count == 32,
              value.allSatisfy({ $0.isHexDigit && ($0.isNumber || $0.isLowercase) }) else {
            return nil
        }
        return value
    }

    func start() {
        stop()
        let descriptor = NWBrowser.Descriptor.bonjourWithTXTRecord(type: "_maxhelmet._tcp", domain: nil)
        let browser = NWBrowser(for: descriptor, using: .tcp)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let helmets = results.compactMap { result -> DiscoveredHelmet? in
                guard case let .bonjour(record) = result.metadata,
                      let token = Self.token(fromTxt: record.dictionary) else {
                    return nil
                }
                return DiscoveredHelmet(token: token, transport: "mdns")
            }
            self?.onUpdate?(DiscoveredHelmet.merged(helmets))
        }
        self.browser = browser
        browser.start(queue: .main)
    }

    func stop() {
        browser?.cancel()
        browser = nil
        onUpdate?([])
    }
}
```

- [ ] **Step 3: Wire the view model and panel**

`MainViewModel.swift`:

- `@Published private(set) var discoveredHelmets: [DiscoveredHelmet] = []`
- Own a `HelmetDiscovering` (default `BonjourHelmetDiscovery()`, injectable for tests) with `onUpdate` assigning `discoveredHelmets` on main.
- `func startHelmetDiscovery()` / `func stopHelmetDiscovery()` delegating to it — call from the settings panel's pairing section `onAppear`/`onDisappear`.

`AgentSettingsPanel.swift` companion section: above the existing code field, render the discovered list —

```swift
if !companion.discoveredHelmets.isEmpty {
    Section("附近的头盔") {
        ForEach(companion.discoveredHelmets) { helmet in
            HStack {
                Text("Max 头盔")
                Spacer()
                Button("配对") { companion.pairDiscovered(helmet.token) }
                    .disabled(!companion.isPairEnabledForDiscovery)
            }
        }
        if companion.isAwaitingHelmetConfirm {
            Text("等待头盔确认…请对头盔说\u{201C}确认\u{201D}")
        }
    }
}
```

with the panel's existing model-struct plumbing (extend the `companion` view-state struct at ~line 82 with `discoveredHelmets`, `isAwaitingHelmetConfirm`, `isPairEnabledForDiscovery` — the latter reuses `isPairEnabled`'s gates minus `exactCode`) and demote the manual field's label to 手动输入配对码. Follow the panel's existing section idiom rather than this sketch where they differ.

`Info.plist` AND `Info-Debug.plist`:

```xml
<key>NSBonjourServices</key>
<array><string>_maxhelmet._tcp</string></array>
<key>NSLocalNetworkUsageDescription</key>
<string>用于在本地网络上发现附近的 Max 头盔以便配对。</string>
```

(`NSBluetoothAlwaysUsageDescription` waits for Phase 2 — do not add unused permission strings.)

- [ ] **Step 4: Run to verify pass**

Run: the `xcodebuild test` command (full suite).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/MaxHelmet/Companion/Discovery ios/MaxHelmet/UI/MainViewModel.swift ios/MaxHelmet/UI/AgentSettingsPanel.swift ios/MaxHelmet/Info.plist ios/MaxHelmet/Info-Debug.plist ios/MaxHelmetTests/HelmetDiscoveryTests.swift
git commit -m "feat(ios-companion): discover nearby helmets over Bonjour"
```

---

### Task 12: Docs and the full gate

**Files:**

- Modify: `rdk/README.md` (pairing section)
- Modify: `CHANGELOG.md` (follow its existing entry format)

- [ ] **Step 1: Document the flow**

In `rdk/README.md`'s pairing/companion section, add a short paragraph: unpaired boards broadcast a discovery beacon (`_maxhelmet._tcp`, rotating token, no secrets); the iOS app lists nearby helmets and pairing completes with a spoken 确认; the six-digit code path (HDMI HUD / SSH forward) remains the fallback and is unchanged. Note the HUD's 配对广播 status line and that a `discovery: off` line while unpaired means both transports failed — check the journal for `[discovery]` lines.

- [ ] **Step 2: Changelog entry**

Add the feature line in `CHANGELOG.md` following the file's format.

- [ ] **Step 3: Full gate**

Run: `npm run check`
Expected: PASS (protocol check, format, lint, knip, rdk tsc, full vitest, fault matrix, build). Knip note: every new export must have a consumer — `PAIR_CONFIRM_PROMPT`/`PAIR_CONFIRM_OK_SPEECH` are consumed by tests and registry; if knip flags a genuinely unconsumed export, narrow the export rather than suppressing.

Run: the iOS `xcodebuild test` command once more.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add rdk/README.md CHANGELOG.md
git commit -m "docs(companion): document discovery pairing and its fallback"
```

---

## Out of scope for this plan

- **Phase 2 (BLE):** board bluez/D-Bus advertiser + iOS `CBCentralManager` scanning — separate plan; the `DiscoveryTransport` seam and `DiscoveredHelmet.transport` field are already shaped for it.
- **Phase 3 (Android):** no Android companion client exists.
- Live bench verification (real board + phone): follows the merge via `dns-sd -B _maxhelmet._tcp`, a spoken 确认 on the board, and the acceptance flow — human-in-the-loop, not a plan task.
