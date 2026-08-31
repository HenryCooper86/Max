# Crash Detection & Emergency Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During a hands-free session, the iOS app detects a crash from the phone's IMU, checks in on the rider, and escalates — local alarm + call button, plus a truthful relay-side notification to the emergency contact.

**Architecture:** A pure `CrashEngine` state machine (`armed → impactCandidate → checkIn → alarm → escalated`) on iOS, fed by a thin CoreMotion adapter and driven by a `CrashController` that owns all I/O. Four new protocol events (`crash.alert`, `crash.cancel` client→server; `crash.ack`, `crash.simulate` server→client) flow through the generated contract. The relay's `crash-escalation` module holds a pluggable `CrashNotifier` (log-only by default) and answers with a truthful ack. A mock 事故 scenario rehearses the whole flow.

**Tech Stack:** TypeScript (Express relay, vitest), JSON Schema codegen (`npm run generate:protocol`), Swift/SwiftUI + XCTest (iOS 17 target), CoreMotion.

Spec: `docs/superpowers/specs/2026-08-03-crash-detection-design.md`.

## Global Constraints

- All rider-facing copy is Chinese-first (Max speaks Chinese by default).
- Truthful speech rule: Max only claims "已通知紧急联系人" after a `crash.ack` with `status: "notified"`; failures are spoken as failures.
- The contact number leaves the device only inside an actual `crash.alert`, and only when the settings opt-in (default **off**) is on.
- Detection and every countdown run on the phone; the network is delivery-only.
- Never hand-edit `shared/generated/agent-protocol.ts`, `ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift`, or `android/.../GeneratedAgentProtocol.kt` — edit `protocol/agent-events.schema.json` and run `npm run generate:protocol`.
- Web and Android must ignore the new server events without erroring (web's `validateAgentEvent` already returns `null` for types without a case — do not add cases there).
- No foreign CDNs or Google-hosted assets anywhere (China-facing constraint). Map links in SMS bodies use amap (`https://uri.amap.com/marker?position=<lon>,<lat>`).
- Server verification: `npm test` (vitest), full gate `npm run check`. iOS verification (Simulator cannot rotate or render; tests only):
  ```bash
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild \
    -project ios/MaxHelmet.xcodeproj -scheme MaxHelmet \
    -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
  ```
- Work on branch `feat/crash-detection` (branched from `docs/crash-detection-spec`, which holds the spec).
- The new `ios/MaxHelmet/Crash/` folder is picked up automatically (Xcode 16 `PBXFileSystemSynchronizedRootGroup`); no pbxproj edit.

---

### Task 1: Protocol events + generated contracts

**Files:**

- Modify: `protocol/agent-events.schema.json`
- Modify: `shared/agent.ts` (ClientEvent union ~line 228, AgentEvent union ~line 279)
- Regenerate (never hand-edit): `shared/generated/agent-protocol.ts`, `ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift`, `android/app/src/main/java/com/horizon/maxhelmet/agent/GeneratedAgentProtocol.kt`
- Test: `tests/crash-protocol.test.ts`

**Interfaces:**

- Produces: wire names `crash.alert`, `crash.cancel` (client→server), `crash.ack`, `crash.simulate` (server→client); TS types `CrashAckStatus`, and the four union members in `ClientEvent`/`AgentEvent`. Later tasks import `CrashAckStatus` and `Extract<ClientEvent, { type: "crash.alert" }>` from `../shared/agent`.

- [ ] **Step 1: Write the failing test**

Create `tests/crash-protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CLIENT_EVENT_TYPES, SERVER_EVENT_TYPES } from "../shared/generated/agent-protocol";

describe("generated protocol", () => {
  it("includes the crash events", () => {
    expect(CLIENT_EVENT_TYPES).toContain("crash.alert");
    expect(CLIENT_EVENT_TYPES).toContain("crash.cancel");
    expect(SERVER_EVENT_TYPES).toContain("crash.ack");
    expect(SERVER_EVENT_TYPES).toContain("crash.simulate");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/crash-protocol.test.ts`
Expected: FAIL — the generated lists don't contain the crash events yet.

- [ ] **Step 3: Add the schema entries**

In `protocol/agent-events.schema.json`, append to `$defs.ClientEvent.oneOf` (before its closing `]`, ~line 180) — every entry follows the file's convention: `title`, `properties.type.const`, `required` starting with `"type"`:

```json
{
  "title": "CrashAlert",
  "type": "object",
  "properties": {
    "type": { "const": "crash.alert" },
    "incidentId": { "type": "string", "minLength": 1 },
    "lat": { "type": "number" },
    "lon": { "type": "number" },
    "speedKmhRecent": { "type": "number" },
    "contactNumber": { "type": "string" },
    "contactOptIn": { "type": "boolean" },
    "detectedAt": { "type": "number" }
  },
  "required": ["type", "incidentId", "contactOptIn"]
},
{
  "title": "CrashCancel",
  "type": "object",
  "properties": {
    "type": { "const": "crash.cancel" },
    "incidentId": { "type": "string", "minLength": 1 }
  },
  "required": ["type", "incidentId"]
}
```

Append to `$defs.AgentEvent.oneOf` (before its closing `]`, ~line 448):

```json
{
  "title": "CrashAck",
  "type": "object",
  "properties": {
    "type": { "const": "crash.ack" },
    "incidentId": { "type": "string", "minLength": 1 },
    "status": { "enum": ["notified", "failed", "unconfigured"] },
    "detail": { "type": "string" }
  },
  "required": ["type", "incidentId", "status"]
},
{
  "title": "CrashSimulate",
  "type": "object",
  "properties": {
    "type": { "const": "crash.simulate" }
  },
  "required": ["type"]
}
```

Note: `lat`/`lon` are deliberately **not** required — the phone may have no GPS fix at escalation; the alert must still go out.

- [ ] **Step 4: Regenerate the contracts**

Run: `npm run generate:protocol`
Expected: rewrites all three generated files. Then `npm run check:protocol` exits 0.

- [ ] **Step 5: Extend the hand-written unions in `shared/agent.ts`**

Add near the other shared vocabularies (top-level, before the unions):

```ts
/** Truthful outcome of relay-side crash escalation. "unconfigured" covers
 *  both "no SMS channel" and "rider didn't opt in" — nobody was texted. */
export type CrashAckStatus = "notified" | "failed" | "unconfigured";
```

Append to the `ClientEvent` union (~line 228):

```ts
  | {
      // Client → server: the phone's crash detector escalated. lat/lon are
      // present only when a GPS fix existed; contactNumber only when the
      // rider opted in to relay escalation (the one privacy carve-out).
      type: "crash.alert";
      incidentId: string;
      lat?: number;
      lon?: number;
      speedKmhRecent?: number;
      contactNumber?: string;
      contactOptIn: boolean;
      detectedAt?: number;
    }
  | {
      // Client → server: the rider cancelled after escalation — the relay
      // sends the false-alarm follow-up so the contact stops worrying.
      type: "crash.cancel";
      incidentId: string;
    }
```

Append to the `AgentEvent` union (~line 279):

```ts
  | {
      // Server → client: the real outcome of crash escalation. Max only
      // claims the contact was notified when status is "notified".
      type: "crash.ack";
      incidentId: string;
      status: CrashAckStatus;
      detail?: string;
    }
  | {
      // Server → client (mock scenarios only): rehearse the crash flow by
      // promoting the client's detector straight to check-in. The embedded
      // board never receives this (it detects for real).
      type: "crash.simulate";
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/crash-protocol.test.ts` — PASS.
Run: `npm run check:protocol && npx tsc --noEmit` — clean.

- [ ] **Step 7: Commit**

```bash
git add protocol/agent-events.schema.json shared/agent.ts shared/generated/agent-protocol.ts \
  ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift \
  android/app/src/main/java/com/horizon/maxhelmet/agent/GeneratedAgentProtocol.kt \
  tests/crash-protocol.test.ts
git commit -m "feat(protocol): crash.alert / crash.cancel / crash.ack / crash.simulate events"
```

---

### Task 2: parseClientEvent validation for the crash events

**Files:**

- Modify: `server/session-controller.ts` (`parseClientEvent`, add blocks after the `hazard.report` block ~line 234, before the `session.start` fallthrough ~line 267)
- Test: `tests/crash-protocol.test.ts`

**Interfaces:**

- Consumes: `parseClientEvent(data: RawData): ClientEvent` (existing export).
- Produces: `parseClientEvent` accepts well-formed `crash.alert`/`crash.cancel` and throws `Invalid crash.alert <field>` otherwise. Task 4 relies on parsed events reaching the dispatch run.

- [ ] **Step 1: Write the failing tests**

Append to `tests/crash-protocol.test.ts`:

```ts
import { parseClientEvent } from "../server/session-controller";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("parseClientEvent crash events", () => {
  it("accepts a minimal crash.alert", () => {
    const event = parseClientEvent(encode({ type: "crash.alert", incidentId: "i1", contactOptIn: false }));
    expect(event).toMatchObject({ type: "crash.alert", incidentId: "i1", contactOptIn: false });
  });

  it("accepts a full crash.alert", () => {
    const event = parseClientEvent(
      encode({
        type: "crash.alert",
        incidentId: "i2",
        lat: 31.23,
        lon: 121.47,
        speedKmhRecent: 42,
        contactNumber: "+8613800000000",
        contactOptIn: true,
        detectedAt: 1754200000000
      })
    );
    expect(event).toMatchObject({ type: "crash.alert", lat: 31.23, contactNumber: "+8613800000000" });
  });

  it("rejects crash.alert without an incidentId", () => {
    expect(() => parseClientEvent(encode({ type: "crash.alert", contactOptIn: true }))).toThrow(/incidentId/);
    expect(() => parseClientEvent(encode({ type: "crash.alert", incidentId: "", contactOptIn: true }))).toThrow(
      /incidentId/
    );
  });

  it("rejects crash.alert without contactOptIn or with bad field types", () => {
    expect(() => parseClientEvent(encode({ type: "crash.alert", incidentId: "i3" }))).toThrow(/contactOptIn/);
    expect(() =>
      parseClientEvent(encode({ type: "crash.alert", incidentId: "i3", contactOptIn: true, lat: "north" }))
    ).toThrow(/lat/);
  });

  it("accepts crash.cancel and rejects one without an incidentId", () => {
    expect(parseClientEvent(encode({ type: "crash.cancel", incidentId: "i4" }))).toMatchObject({
      type: "crash.cancel"
    });
    expect(() => parseClientEvent(encode({ type: "crash.cancel" }))).toThrow(/incidentId/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/crash-protocol.test.ts`
Expected: FAIL — `parseClientEvent` currently falls through without crash blocks (unknown-type or unvalidated).

- [ ] **Step 3: Add the validation blocks**

In `parseClientEvent`, mirroring the `device.result` block's exact idiom (throw `Invalid <type> <field>`, then the same `return` shape the neighboring blocks use):

```ts
if (value.type === "crash.alert") {
  if (typeof value.incidentId !== "string" || value.incidentId.length === 0)
    throw new Error("Invalid crash.alert incidentId");
  if (typeof value.contactOptIn !== "boolean") throw new Error("Invalid crash.alert contactOptIn");
  if (value.lat !== undefined && typeof value.lat !== "number") throw new Error("Invalid crash.alert lat");
  if (value.lon !== undefined && typeof value.lon !== "number") throw new Error("Invalid crash.alert lon");
  if (value.speedKmhRecent !== undefined && typeof value.speedKmhRecent !== "number")
    throw new Error("Invalid crash.alert speedKmhRecent");
  if (value.contactNumber !== undefined && typeof value.contactNumber !== "string")
    throw new Error("Invalid crash.alert contactNumber");
  if (value.detectedAt !== undefined && typeof value.detectedAt !== "number")
    throw new Error("Invalid crash.alert detectedAt");
  return value as ClientEvent;
}

if (value.type === "crash.cancel") {
  if (typeof value.incidentId !== "string" || value.incidentId.length === 0)
    throw new Error("Invalid crash.cancel incidentId");
  return value as ClientEvent;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/crash-protocol.test.ts` — PASS. Also `npx vitest run tests/device-protocol.test.ts` — still PASS (no regression in the shared parser).

- [ ] **Step 5: Commit**

```bash
git add server/session-controller.ts tests/crash-protocol.test.ts
git commit -m "feat(relay): validate crash.alert and crash.cancel client events"
```

---

### Task 3: Crash escalation module + config

**Files:**

- Create: `server/crash-escalation.ts`
- Modify: `server/config.ts` (config object ~line 26, `describeConfig` ~line 127, `validateConfig` ~line 151)
- Modify: `.env.example`
- Test: `tests/crash-escalation.test.ts`

**Interfaces:**

- Consumes: `CrashAckStatus`, `ClientEvent` from `shared/agent.ts` (Task 1); `appendTestingAudit(actor, action, targetType, targetId, detail?, now?)` from `server/testing-store.ts:1066`.
- Produces (Task 4 imports these):
  - `type CrashAlertEvent = Extract<ClientEvent, { type: "crash.alert" }>`
  - `type CrashCancelEvent = Extract<ClientEvent, { type: "crash.cancel" }>`
  - `type CrashNotifyOutcome = { status: CrashAckStatus; detail?: string }`
  - `type CrashNotifier = { name: string; notify(alert: CrashAlertEvent): Promise<CrashNotifyOutcome>; followUp(cancel: CrashCancelEvent): Promise<void> }`
  - `createLogNotifier(): CrashNotifier`
  - `selectCrashNotifier(name: string): CrashNotifier`
  - `crashSmsBody(alert: CrashAlertEvent): string`, `crashCancelSmsBody(): string`
  - `handleCrashAlert(alert: CrashAlertEvent, notifier: CrashNotifier, send: (payload: unknown) => void, audit?: typeof appendTestingAudit): Promise<void>`
  - `handleCrashCancel(cancel: CrashCancelEvent, notifier: CrashNotifier, audit?: typeof appendTestingAudit): Promise<void>`
- Config: `config.crashNotifier: string` (env `CRASH_NOTIFIER`, default `"log"`).

- [ ] **Step 1: Write the failing tests**

Create `tests/crash-escalation.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createLogNotifier,
  crashCancelSmsBody,
  crashSmsBody,
  handleCrashAlert,
  handleCrashCancel,
  selectCrashNotifier,
  type CrashAlertEvent,
  type CrashNotifier
} from "../server/crash-escalation";

const alert = (overrides: Partial<CrashAlertEvent> = {}): CrashAlertEvent => ({
  type: "crash.alert",
  incidentId: "i1",
  contactOptIn: true,
  contactNumber: "+8613800000000",
  lat: 31.23,
  lon: 121.47,
  speedKmhRecent: 42,
  detectedAt: 1754200000000,
  ...overrides
});

describe("crashSmsBody", () => {
  it("names the incident, the location, and an amap link", () => {
    const body = crashSmsBody(alert());
    expect(body).toContain("Max");
    expect(body).toContain("31.23");
    expect(body).toContain("https://uri.amap.com/marker?position=121.47,31.23");
  });

  it("omits the location line when there is no fix", () => {
    const body = crashSmsBody(alert({ lat: undefined, lon: undefined }));
    expect(body).not.toContain("amap");
    expect(body).toContain("位置未知");
  });

  it("has a false-alarm follow-up", () => {
    expect(crashCancelSmsBody()).toContain("误报");
  });
});

describe("notifier selection", () => {
  it("defaults to the log notifier and falls back on unknown names", () => {
    expect(createLogNotifier().name).toBe("log");
    expect(selectCrashNotifier("log").name).toBe("log");
    expect(selectCrashNotifier("aliyun-sms").name).toBe("log");
  });
});

describe("handleCrashAlert", () => {
  it("acks unconfigured when only the log notifier exists", async () => {
    const send = vi.fn();
    const audit = vi.fn();
    await handleCrashAlert(alert(), createLogNotifier(), send, audit as never);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "crash.ack", incidentId: "i1", status: "unconfigured" })
    );
    expect(audit).toHaveBeenCalledWith("relay", "crash.alert", "session", "i1", expect.any(Object));
  });

  it("acks unconfigured without calling notify when the rider did not opt in", async () => {
    const send = vi.fn();
    const notify = vi.fn();
    const notifier: CrashNotifier = { name: "spy", notify, followUp: vi.fn() };
    await handleCrashAlert(alert({ contactOptIn: false, contactNumber: undefined }), notifier, send, vi.fn() as never);
    expect(notify).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ status: "unconfigured" }));
  });

  it("acks failed when the notifier throws", async () => {
    const send = vi.fn();
    const notifier: CrashNotifier = {
      name: "boom",
      notify: vi.fn().mockRejectedValue(new Error("sms down")),
      followUp: vi.fn()
    };
    await handleCrashAlert(alert(), notifier, send, vi.fn() as never);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "crash.ack", status: "failed" }));
  });
});

describe("handleCrashCancel", () => {
  it("audits and forwards the follow-up", async () => {
    const followUp = vi.fn().mockResolvedValue(undefined);
    const audit = vi.fn();
    await handleCrashCancel(
      { type: "crash.cancel", incidentId: "i1" },
      { name: "spy", notify: vi.fn(), followUp },
      audit as never
    );
    expect(followUp).toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith("relay", "crash.cancel", "session", "i1", expect.any(Object));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/crash-escalation.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `server/crash-escalation.ts`**

```ts
import type { ClientEvent, CrashAckStatus } from "../shared/agent";
import { appendTestingAudit } from "./testing-store";

export type CrashAlertEvent = Extract<ClientEvent, { type: "crash.alert" }>;
export type CrashCancelEvent = Extract<ClientEvent, { type: "crash.cancel" }>;

export type CrashNotifyOutcome = { status: CrashAckStatus; detail?: string };

/** A delivery channel for crash escalation. The log notifier is the honest
 *  default: it records the incident but texts nobody, so its outcome is
 *  "unconfigured" — Max must tell the rider to dial by hand. */
export type CrashNotifier = {
  name: string;
  notify(alert: CrashAlertEvent): Promise<CrashNotifyOutcome>;
  followUp(cancel: CrashCancelEvent): Promise<void>;
};

export function crashSmsBody(alert: CrashAlertEvent): string {
  const location =
    typeof alert.lat === "number" && typeof alert.lon === "number"
      ? `位置：${alert.lat.toFixed(5)},${alert.lon.toFixed(5)} https://uri.amap.com/marker?position=${alert.lon.toFixed(5)},${alert.lat.toFixed(5)}`
      : "位置未知";
  const when = alert.detectedAt
    ? new Date(alert.detectedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
    : "";
  return `【Max头盔】检测到骑手疑似摔车，且未响应确认。${location}。${when ? `时间：${when}。` : ""}请尽快联系骑手或报警。`;
}

export function crashCancelSmsBody(): string {
  return "【Max头盔】刚才的事故警报是误报，骑手已确认没事。";
}

export function createLogNotifier(): CrashNotifier {
  return {
    name: "log",
    async notify() {
      return { status: "unconfigured", detail: "未配置短信通道" };
    },
    async followUp() {
      /* nothing to send; the incident audit already records the cancel */
    }
  };
}

export function selectCrashNotifier(name: string): CrashNotifier {
  if (name !== "log") {
    console.warn(`[crash] 未知的通知通道 "${name}"，退回仅记录模式`);
  }
  return createLogNotifier();
}

export async function handleCrashAlert(
  alert: CrashAlertEvent,
  notifier: CrashNotifier,
  send: (payload: unknown) => void,
  audit: typeof appendTestingAudit = appendTestingAudit
): Promise<void> {
  audit("relay", "crash.alert", "session", alert.incidentId, {
    lat: alert.lat,
    lon: alert.lon,
    speedKmhRecent: alert.speedKmhRecent,
    contactOptIn: alert.contactOptIn,
    notifier: notifier.name
  });

  let outcome: CrashNotifyOutcome;
  if (!alert.contactOptIn || !alert.contactNumber) {
    outcome = { status: "unconfigured", detail: "未开启紧急联系人通知" };
  } else {
    try {
      outcome = await notifier.notify(alert);
    } catch (error) {
      outcome = { status: "failed", detail: error instanceof Error ? error.message : "notify failed" };
    }
  }

  send({
    type: "crash.ack",
    incidentId: alert.incidentId,
    status: outcome.status,
    ...(outcome.detail ? { detail: outcome.detail } : {})
  });
}

export async function handleCrashCancel(
  cancel: CrashCancelEvent,
  notifier: CrashNotifier,
  audit: typeof appendTestingAudit = appendTestingAudit
): Promise<void> {
  audit("relay", "crash.cancel", "session", cancel.incidentId, { notifier: notifier.name });
  try {
    await notifier.followUp(cancel);
  } catch {
    /* follow-up is best-effort; the audit row is the durable record */
  }
}
```

Note: `"session"` is a member of `TestingAuditEvent["targetType"]` (`shared/testing.ts:289`), so the audit calls above type-check as written.

- [ ] **Step 4: Add the config entry**

In `server/config.ts`, add to the `config` object (comment style matches neighbors):

```ts
  // Crash escalation delivery channel. Only "log" exists today: incidents are
  // audited but nobody is texted, and the ack says so honestly.
  crashNotifier: process.env.CRASH_NOTIFIER?.trim().toLowerCase() || "log",
```

In `describeConfig()` add: `` `事故通知通道: ${config.crashNotifier}` ``.
In `validateConfig()` add:

```ts
if (config.crashNotifier !== "log") {
  warnings.push(`CRASH_NOTIFIER=${config.crashNotifier} 不是已实现的通道，事故升级将只记录、不发送短信。`);
}
```

(The accumulator in `validateConfig` is `const warnings: string[]` — `server/config.ts:152`.)

In `.env.example` add a commented block near the other relay options:

```
# Crash escalation delivery channel. "log" (default) records incidents in the
# testing audit but sends no SMS — the crash.ack honestly reports "unconfigured".
# CRASH_NOTIFIER=log
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/crash-escalation.test.ts` — PASS. `npx tsc --noEmit` — clean.

- [ ] **Step 6: Commit**

```bash
git add server/crash-escalation.ts server/config.ts .env.example tests/crash-escalation.test.ts
git commit -m "feat(relay): crash escalation module with pluggable, honest notifier"
```

---

### Task 4: Session-controller dispatch + end-to-end relay test

**Files:**

- Modify: `server/session-controller.ts` (dispatch run ~lines 445-450; constructor area for the notifier field)
- Test: `tests/crash-escalation.test.ts` (append an integration describe)

**Interfaces:**

- Consumes: `selectCrashNotifier`, `handleCrashAlert`, `handleCrashCancel` (Task 3); `config.crashNotifier` (Task 3); the controller's private `send(payload)` (session-controller.ts:472).
- Produces: a live relay session answers `crash.alert` with `crash.ack` on both mock and doubao providers (dispatch is provider-agnostic).

- [ ] **Step 1: Write the failing integration test**

Append to `tests/crash-escalation.test.ts` (harness copied from `tests/websocket.test.ts:1-58` — same lifecycle, trimmed to what this test needs):

```ts
import http from "node:http";
import { afterEach } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { AgentSessionController } from "../server/session-controller";
import { createMockProvider } from "../server/providers/mock";
import { metrics } from "../server/metrics";

let server: http.Server | undefined;
let wss: WebSocketServer | undefined;

afterEach(async () => {
  for (const client of wss?.clients ?? []) client.terminate();
  await new Promise<void>((resolve) => wss?.close(() => resolve()) ?? resolve());
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  wss = undefined;
  server = undefined;
  metrics.reset();
});

describe("crash escalation over the relay", () => {
  it("answers crash.alert with a truthful crash.ack", async () => {
    server = http.createServer();
    wss = new WebSocketServer({ server, path: "/agent" });
    wss.on("connection", (client) => {
      const session = new AgentSessionController(client, createMockProvider);
      client.on("message", (data, isBinary) => void session.handleMessage(data, isBinary));
      client.on("close", () => void session.close());
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server port");

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/agent`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const ack = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no crash.ack")), 5000);
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "session.started") {
          socket.send(JSON.stringify({ type: "crash.alert", incidentId: "e2e-1", contactOptIn: false }));
        }
        if (event.type === "crash.ack") {
          clearTimeout(timeout);
          resolve(event);
        }
      });
    });

    socket.send(JSON.stringify({ type: "session.start", sampleRate: 16000, channels: 1 }));

    const event = await ack;
    expect(event).toMatchObject({ type: "crash.ack", incidentId: "e2e-1", status: "unconfigured" });
    socket.terminate();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/crash-escalation.test.ts`
Expected: the new describe FAILS with "no crash.ack" (event parsed but never dispatched).

- [ ] **Step 3: Wire the dispatch**

In `server/session-controller.ts`, add imports and a field:

```ts
import { handleCrashAlert, handleCrashCancel, selectCrashNotifier } from "./crash-escalation";
```

On the class: `private readonly crashNotifier = selectCrashNotifier(config.crashNotifier);` (the file already imports `config`; if not, add it).

In the dispatch run (after the `camera.frame` line ~450):

```ts
if (event.type === "crash.alert") await handleCrashAlert(event, this.crashNotifier, (payload) => this.send(payload));
if (event.type === "crash.cancel") await handleCrashCancel(event, this.crashNotifier);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/crash-escalation.test.ts tests/websocket.test.ts` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/session-controller.ts tests/crash-escalation.test.ts
git commit -m "feat(relay): dispatch crash events through the session controller"
```

---

### Task 5: Mock 事故 scenario + crash.simulate injector

**Files:**

- Modify: `shared/ride.ts` (`DemoScenario` line 3, `SCENARIO_LABELS` ~line 53, `scenarioDefaultMode` ~line 70)
- Modify: `shared/events.ts` (~line 20, the hand-listed `DEMO_SCENARIOS` set)
- Modify: `server/session-controller.ts` (~line 37, the other hand-listed scenario set)
- Modify: `server/hazard-injector.ts` (add `createCrashSimulator`)
- Modify: `server/providers/mock.ts` (`SCENARIOS` map ~line 54, `enterScenario` ~line 338, `close`)
- Modify: `src/lib/constants.ts:84` (web scenario picker array) and `src/components/WebSettingsSheet.tsx:211-218` (English label map)
- Test: `tests/crash-escalation.test.ts` (append)

**Interfaces:**

- Consumes: the `send` / `platform` wiring pattern of `createHazardInjector` (`server/hazard-injector.ts:12-33`).
- Produces: `createCrashSimulator(options: { send: (payload: unknown) => void; platform?: () => string | undefined }): { start(delayMs: number): void; stop(): void }`; `DemoScenario` gains `"crash"`, label `事故`, default mode `emergency`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/crash-escalation.test.ts`:

```ts
import { createCrashSimulator } from "../server/hazard-injector";
import { scenarioDefaultMode, scenarioLabel } from "../shared/ride";

describe("crash demo scenario", () => {
  it("is registered with label and emergency mode", () => {
    expect(scenarioLabel("crash")).toBe("事故");
    expect(scenarioDefaultMode("crash")).toBe("emergency");
  });

  it("emits crash.simulate after the delay, but never to the embedded board", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const sim = createCrashSimulator({ send });
    sim.start(6000);
    vi.advanceTimersByTime(5999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledWith({ type: "crash.simulate" });

    send.mockClear();
    const embedded = createCrashSimulator({ send, platform: () => "embedded" });
    embedded.start(1000);
    vi.advanceTimersByTime(2000);
    expect(send).not.toHaveBeenCalled();

    sim.stop();
    embedded.stop();
    vi.useRealTimers();
  });

  it("stop() cancels a scheduled simulate", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const sim = createCrashSimulator({ send });
    sim.start(1000);
    sim.stop();
    vi.advanceTimersByTime(5000);
    expect(send).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

(Add `vi` to the vitest import at the top of the file if not already there.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/crash-escalation.test.ts` — FAIL (`"crash"` not a `DemoScenario`; `createCrashSimulator` missing). TypeScript errors count as the failure.

- [ ] **Step 3: Register the scenario**

`shared/ride.ts`:

- Line 3: `export type DemoScenario = "commute" | "wind" | "fuel" | "group" | "emergency" | "adas" | "crash";`
- `SCENARIO_LABELS`: add `crash: "事故"`.
- `scenarioDefaultMode`: change the first line to `if (scenario === "emergency" || scenario === "crash") return "emergency";`

Add `"crash"` to the hand-listed scenario sets in `shared/events.ts` (~line 20) and `server/session-controller.ts` (~line 37) — grep for `"adas"` in each to find the exact literal.

Web picker: append `"crash"` to `export const SCENARIOS: DemoScenario[]` in `src/lib/constants.ts:84`, and add `crash: "Crash"` to the hand-listed English label map in `src/components/WebSettingsSheet.tsx` (~line 211-218; the Chinese label comes from `scenarioLabel`). The web has no crash detector — selecting 事故 there simply shows the scenario context while the client ignores `crash.simulate`. (The Android picker is not updated in this plan; Android ignores the unknown scenario events per the spec's non-goals.)

- [ ] **Step 4: Implement `createCrashSimulator` in `server/hazard-injector.ts`**

```ts
export type CrashSimulatorOptions = {
  send: (payload: unknown) => void;
  /** The embedded board detects crashes for real — never simulate at it. */
  platform?: () => string | undefined;
};

export function createCrashSimulator({ send, platform }: CrashSimulatorOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    start(delayMs: number) {
      if (platform?.() === "embedded") return;
      clearTimeout(timer);
      timer = setTimeout(() => send({ type: "crash.simulate" }), delayMs);
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}
```

- [ ] **Step 5: Add the mock scenario profile and wire the simulator**

In `server/providers/mock.ts` `SCENARIOS` map, add (field shapes exactly as the `commute` entry at lines 55-80):

```ts
  crash: {
    speedKmh: 0,
    routePhase: "事故演示 — 练习取消与升级",
    network: "online",
    batteryPct: 58,
    weather: {
      description: "多云",
      temperatureC: 24,
      windSpeedKmh: 12,
      isDay: true,
      riskLevel: "critical",
      riderAdvice: "演示：几秒后触发疑似摔车，练习「我没事」取消或等待升级。"
    },
    turns: [
      {
        rider: "刚才发生了什么？",
        agent: "刚才是事故演示。检测到疑似摔车后我会先问你还好吗；你不回应就会拉响警报，最后通知紧急联系人。",
        latencyBase: 320
      }
    ]
  },
```

Next to the existing `hazardInjector` construction (~line 335) add:

```ts
const crashSimulator = createCrashSimulator({ send, platform: () => sessionPlatform });
```

(import `createCrashSimulator` alongside `createHazardInjector`). In `enterScenario` (~line 357-358), mirror the hazard-injector cadence switch:

```ts
crashSimulator.stop();
if (scenario === "crash") crashSimulator.start(6000);
```

In the provider's `close()` add `crashSimulator.stop();`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/crash-escalation.test.ts tests/adas.test.ts` — PASS. Then the full server suite: `npm test` — PASS (scenario Record types force every `Record<DemoScenario, …>` to include `crash`; the compiler will point at any missed map — fix each by adding a `crash` entry consistent with its neighbors).

- [ ] **Step 7: Commit**

```bash
git add shared/ride.ts shared/events.ts server/session-controller.ts server/hazard-injector.ts server/providers/mock.ts tests/crash-escalation.test.ts
git commit -m "feat(mock): 事故 demo scenario injects crash.simulate for full-flow rehearsal"
```

---

### Task 6: iOS Swift protocol surface

**Files:**

- Modify: `ios/MaxHelmet/Agent/AgentProtocol.swift` (`AgentEvent` enum ~line 333, `parseAgentEvent` switch ~line 352, builders ~line 589)
- Test: `ios/MaxHelmetTests/CrashProtocolTests.swift`

**Interfaces:**

- Consumes: generated `ServerEventTypes.crashAck` / `.crashSimulate`, `ClientEventTypes.crashAlert` / `.crashCancel` (Task 1); the parser's `str/int/bool` local helpers and required-field gate (AgentProtocol.swift:358-367).
- Produces (Task 10 consumes):
  - `enum CrashAckStatus: String { case notified, failed, unconfigured }` with `static func fromWire(_ raw: String) -> CrashAckStatus` (unknown → `.failed`, the conservative reading)
  - `AgentEvent` cases: `.crashAck(incidentId: String, status: CrashAckStatus, detail: String?)`, `.crashSimulate`
  - `func buildCrashAlert(incidentId: String, lat: Double?, lon: Double?, speedKmhRecent: Double?, contactNumber: String?, contactOptIn: Bool, detectedAt: Double) -> String`
  - `func buildCrashCancel(incidentId: String) -> String`

- [ ] **Step 1: Write the failing tests**

Create `ios/MaxHelmetTests/CrashProtocolTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

final class CrashProtocolTests: XCTestCase {

    func testParsesCrashAck() {
        let event = parseAgentEvent(#"{"type":"crash.ack","incidentId":"i1","status":"notified"}"#)
        guard case let .crashAck(incidentId, status, detail) = event else {
            return XCTFail("expected crashAck, got \(event)")
        }
        XCTAssertEqual(incidentId, "i1")
        XCTAssertEqual(status, .notified)
        XCTAssertNil(detail)
    }

    func testUnknownAckStatusReadsAsFailed() {
        let event = parseAgentEvent(#"{"type":"crash.ack","incidentId":"i1","status":"delivered-maybe"}"#)
        guard case let .crashAck(_, status, _) = event else { return XCTFail("expected crashAck") }
        XCTAssertEqual(status, .failed, "an unknown outcome must never read as success")
    }

    func testParsesCrashSimulate() {
        guard case .crashSimulate = parseAgentEvent(#"{"type":"crash.simulate"}"#) else {
            return XCTFail("expected crashSimulate")
        }
    }

    func testBuildCrashAlertRoundTripsAndOmitsContactWhenNil() throws {
        let json = buildCrashAlert(incidentId: "i2", lat: 31.23, lon: 121.47, speedKmhRecent: 42,
                                   contactNumber: nil, contactOptIn: false, detectedAt: 1_754_200_000_000)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(parsed["type"] as? String, ClientEventTypes.crashAlert)
        XCTAssertEqual(parsed["incidentId"] as? String, "i2")
        XCTAssertEqual(parsed["contactOptIn"] as? Bool, false)
        XCTAssertNil(parsed["contactNumber"])

        let optedIn = buildCrashAlert(incidentId: "i3", lat: nil, lon: nil, speedKmhRecent: nil,
                                      contactNumber: "+8613800000000", contactOptIn: true, detectedAt: 0)
        let parsedIn = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(optedIn.utf8)) as? [String: Any])
        XCTAssertEqual(parsedIn["contactNumber"] as? String, "+8613800000000")
        XCTAssertNil(parsedIn["lat"])
    }

    func testBuildCrashCancelRoundTrips() throws {
        let json = buildCrashCancel(incidentId: "i4")
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(parsed["type"] as? String, ClientEventTypes.crashCancel)
        XCTAssertEqual(parsed["incidentId"] as? String, "i4")
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run the xcodebuild test command from Global Constraints, adding `-only-testing:MaxHelmetTests/CrashProtocolTests`.
Expected: BUILD FAIL (missing cases/builders) — that is the failing state for compiled languages.

- [ ] **Step 3: Implement**

In `ios/MaxHelmet/Agent/AgentProtocol.swift`:

Near the other wire enums (~line 276):

```swift
enum CrashAckStatus: String {
    case notified, failed, unconfigured
    /// Unknown outcomes read as failure — Max must never claim success it wasn't told about.
    static func fromWire(_ raw: String) -> CrashAckStatus { CrashAckStatus(rawValue: raw) ?? .failed }
}
```

In `enum AgentEvent` add:

```swift
    case crashAck(incidentId: String, status: CrashAckStatus, detail: String?)
    case crashSimulate
```

In `parseAgentEvent`'s `switch type` (the required-field gate already guarantees `incidentId`/`status` exist):

```swift
        case ServerEventTypes.crashAck:
            return .crashAck(incidentId: str("incidentId") ?? "",
                             status: CrashAckStatus.fromWire(str("status") ?? ""),
                             detail: str("detail"))
        case ServerEventTypes.crashSimulate:
            return .crashSimulate
```

Builders, next to `buildDeviceResult` (~line 589), following its exact JSON-building idiom:

```swift
func buildCrashAlert(incidentId: String, lat: Double?, lon: Double?, speedKmhRecent: Double?,
                     contactNumber: String?, contactOptIn: Bool, detectedAt: Double) -> String {
    var payload: [String: Any] = [
        "type": ClientEventTypes.crashAlert,
        "incidentId": incidentId,
        "contactOptIn": contactOptIn,
        "detectedAt": detectedAt
    ]
    if let lat { payload["lat"] = lat }
    if let lon { payload["lon"] = lon }
    if let speedKmhRecent { payload["speedKmhRecent"] = speedKmhRecent }
    if let contactNumber, contactOptIn { payload["contactNumber"] = contactNumber }
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return "{}" }
    return String(data: data, encoding: .utf8) ?? "{}"
}

func buildCrashCancel(incidentId: String) -> String {
    let payload: [String: Any] = ["type": ClientEventTypes.crashCancel, "incidentId": incidentId]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return "{}" }
    return String(data: data, encoding: .utf8) ?? "{}"
}
```

(If `buildDeviceResult` uses a shared encoding helper instead of raw `JSONSerialization`, use that helper.)

Also extend the hand-written Swift scenario enum so the iOS settings chips offer the rehearsal scenario (`AgentProtocol.swift:99-138`): add `crash` to `case commute, wind, fuel, group, emergency, adas`, add `case .crash: return "事故"` to `label`, add `.crash` to the `.critical` branch of `hazard`, and add `.crash` to the `.emergency` branch of `scenarioDefaultMode(_:)` (mirroring `shared/ride.ts`).

- [ ] **Step 4: Run tests to verify they pass**

Run the xcodebuild test command with `-only-testing:MaxHelmetTests/CrashProtocolTests` — PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/MaxHelmet/Agent/AgentProtocol.swift ios/MaxHelmetTests/CrashProtocolTests.swift
git commit -m "feat(ios): crash event parsing and builders"
```

---

### Task 7: CrashEngine — detection core

**Files:**

- Create: `ios/MaxHelmet/Crash/CrashEngine.swift`
- Test: `ios/MaxHelmetTests/CrashEngineTests.swift`

**Interfaces:**

- Produces (Tasks 8-10 consume; exact declarations below):
  - `struct CrashTuning` (all thresholds; `static let standard`)
  - `struct CrashSample: Equatable { var t: TimeInterval; var accelG: Double; var rotationRadS: Double; var speedKmh: Double? }`
  - `enum CrashPhase: Equatable { case armed, impactCandidate(since: TimeInterval), checkIn(since: TimeInterval), alarm(since: TimeInterval), escalated(at: TimeInterval) }`
  - `struct CrashState: Equatable { var phase: CrashPhase; var recent: [CrashSample]; var impactStart: TimeInterval?; var tumbleStart: TimeInterval?; static let armed: CrashState }`
  - `enum CrashEffect: Equatable { case speakCheckIn, showAlarm, escalate, dismiss, logNearMiss, sendCancel }`
  - `struct CrashUpdate: Equatable { var state: CrashState; var effects: [CrashEffect] }`
  - `enum CrashEngine` with `static func step(sample:state:tuning:) -> CrashUpdate` (this task) and `tick` / `riderCancelled` / `simulate` (Task 8)

- [ ] **Step 1: Write the failing tests**

Create `ios/MaxHelmetTests/CrashEngineTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

/// Trace helpers: literal IMU sequences at 100 Hz, GuidanceEngineTests-style.
private func trace(from t0: TimeInterval, seconds: Double, accelG: Double, rotation: Double = 0.3,
                   speedKmh: Double?, hz: Double = 100) -> [CrashSample] {
    stride(from: 0.0, to: seconds, by: 1.0 / hz).map {
        CrashSample(t: t0 + $0, accelG: accelG, rotationRadS: rotation, speedKmh: speedKmh)
    }
}

private func run(_ samples: [CrashSample], from state: CrashState = .armed,
                 tuning: CrashTuning = .standard) -> (CrashState, [CrashEffect]) {
    var s = state
    var effects: [CrashEffect] = []
    for sample in samples {
        let update = CrashEngine.step(sample: sample, state: s, tuning: tuning)
        s = update.state
        effects.append(contentsOf: update.effects)
    }
    return (s, effects)
}

final class CrashEngineDetectionTests: XCTestCase {

    /// Riding baseline: 0.3 g noise at 60 km/h.
    private func riding(_ seconds: Double, from t0: TimeInterval = 0) -> [CrashSample] {
        trace(from: t0, seconds: seconds, accelG: 0.3, speedKmh: 60)
    }

    func testNarrowSpikeDoesNotPromote() {
        // One 10 ms spike (a pothole) — below the 20 ms sustain requirement.
        var samples = riding(1.0)
        samples.append(CrashSample(t: 1.0, accelG: 6.0, rotationRadS: 0.3, speedKmh: 60))
        let (state, effects) = run(samples + riding(1.0, from: 1.01))
        XCTAssertEqual(state.phase, .armed)
        XCTAssertTrue(effects.isEmpty)
    }

    func testSustainedImpactThenStillnessReachesCheckIn() {
        var samples = riding(1.0)
        samples += trace(from: 1.0, seconds: 0.05, accelG: 6.0, speedKmh: 60)       // 50 ms crash pulse
        samples += trace(from: 1.05, seconds: 2.0, accelG: 0.02, speedKmh: 0)       // still on the ground
        let (state, effects) = run(samples)
        guard case .checkIn = state.phase else { return XCTFail("expected checkIn, got \(state.phase)") }
        XCTAssertEqual(effects, [.speakCheckIn])
    }

    func testTumbleAtSpeedPromotes() {
        var samples = riding(1.0)
        samples += trace(from: 1.0, seconds: 0.15, accelG: 1.0, rotation: 8.0, speedKmh: 60)
        let (state, _) = run(samples)
        guard case .impactCandidate = state.phase else { return XCTFail("expected impactCandidate, got \(state.phase)") }
    }

    func testStandstillSingleSignalNeverPromotes() {
        // Dropped phone at 0 km/h: a big spike but no tumble — both are required below the speed gate.
        var samples = trace(from: 0, seconds: 1.0, accelG: 0.05, speedKmh: 0)
        samples += trace(from: 1.0, seconds: 0.05, accelG: 7.0, speedKmh: 0)
        let (state, _) = run(samples)
        XCTAssertEqual(state.phase, .armed)
    }

    func testStandstillBothSignalsPromote() {
        var samples = trace(from: 0, seconds: 1.0, accelG: 0.05, speedKmh: 0)
        samples += trace(from: 1.0, seconds: 0.15, accelG: 6.0, rotation: 8.0, speedKmh: 0)
        let (state, _) = run(samples)
        guard case .impactCandidate = state.phase else { return XCTFail("expected impactCandidate, got \(state.phase)") }
    }

    func testUnknownSpeedIsTreatedAsBelowGate() {
        var samples = trace(from: 0, seconds: 1.0, accelG: 0.3, speedKmh: nil)
        samples += trace(from: 1.0, seconds: 0.05, accelG: 6.0, speedKmh: nil)
        let (state, _) = run(samples)
        XCTAssertEqual(state.phase, .armed, "single signal with unknown speed must not promote")
    }

    func testResumedRidingReturnsToArmed() {
        // Candidate, then normal riding through the 5 s confirm window: silent re-arm.
        var samples = riding(1.0)
        samples += trace(from: 1.0, seconds: 0.05, accelG: 6.0, speedKmh: 60)
        samples += riding(6.0, from: 1.05)
        let (state, effects) = run(samples)
        XCTAssertEqual(state.phase, .armed)
        XCTAssertTrue(effects.isEmpty)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run xcodebuild test with `-only-testing:MaxHelmetTests/CrashEngineDetectionTests`. Expected: BUILD FAIL — the types don't exist.

- [ ] **Step 3: Implement `ios/MaxHelmet/Crash/CrashEngine.swift`**

```swift
import Foundation

/// Every detection threshold in one place, mirroring the ADAS tuning
/// dataclass. v1 numbers come from the spec; tune from recorded traces.
struct CrashTuning: Equatable {
    var impactThresholdG = 4.5
    var impactSustainS = 0.02
    var tumbleThresholdRadS = 6.0
    var tumbleSustainS = 0.10
    var speedGateKmh = 10.0
    var confirmWindowS = 5.0
    var confirmMinDelayS = 0.5
    var stillSpeedKmh = 2.0
    var stillVarianceG2 = 0.05
    var stillWindowS = 1.0
    var checkInWindowS = 15.0
    var alarmWindowS = 30.0
    var preContextS = 5.0
    static let standard = CrashTuning()
}

struct CrashSample: Equatable {
    var t: TimeInterval        // monotonic seconds
    var accelG: Double         // |userAcceleration| in g
    var rotationRadS: Double   // |rotationRate| in rad/s
    var speedKmh: Double?      // ride-context speed; nil = unknown
}

enum CrashPhase: Equatable {
    case armed
    case impactCandidate(since: TimeInterval)
    case checkIn(since: TimeInterval)
    case alarm(since: TimeInterval)
    case escalated(at: TimeInterval)
}

struct CrashState: Equatable {
    var phase: CrashPhase = .armed
    var recent: [CrashSample] = []
    var impactStart: TimeInterval?
    var tumbleStart: TimeInterval?
    static let armed = CrashState()
}

enum CrashEffect: Equatable {
    case speakCheckIn   // interrupt playback and ask 你还好吗
    case showAlarm      // full-screen alarm + siren
    case escalate       // send crash.alert
    case dismiss        // clear banner/alarm UI
    case logNearMiss    // cancelled incident — keep the trace for tuning
    case sendCancel     // post-escalation cancel — relay sends the 误报 follow-up
}

struct CrashUpdate: Equatable {
    var state: CrashState
    var effects: [CrashEffect] = []
}

/// Pure crash detection and escalation timing — no CoreMotion, no timers,
/// no I/O. Every decision the rider's safety depends on lives here, so it
/// can be table-tested from literal IMU traces.
enum CrashEngine {

    static func step(sample: CrashSample, state: CrashState, tuning: CrashTuning = .standard) -> CrashUpdate {
        var s = state
        s.recent.append(sample)
        let cutoff = sample.t - tuning.preContextS
        s.recent.removeAll { $0.t < cutoff }

        switch s.phase {
        case .armed:
            s.impactStart = sample.accelG >= tuning.impactThresholdG ? (s.impactStart ?? sample.t) : nil
            s.tumbleStart = sample.rotationRadS >= tuning.tumbleThresholdRadS ? (s.tumbleStart ?? sample.t) : nil
            let impact = s.impactStart.map { sample.t - $0 >= tuning.impactSustainS } ?? false
            let tumble = s.tumbleStart.map { sample.t - $0 >= tuning.tumbleSustainS } ?? false
            let recentSpeed = s.recent.compactMap(\.speedKmh).max()
            let fast = (recentSpeed ?? 0) >= tuning.speedGateKmh
            if (fast && (impact || tumble)) || (impact && tumble) {
                s.phase = .impactCandidate(since: sample.t)
                s.impactStart = nil
                s.tumbleStart = nil
            }
            return CrashUpdate(state: s)

        case .impactCandidate(let since):
            let renewed = sample.t - since >= tuning.confirmMinDelayS &&
                (sample.accelG >= tuning.impactThresholdG || sample.rotationRadS >= tuning.tumbleThresholdRadS)
            let still = sample.t - since >= tuning.confirmMinDelayS && stillness(s.recent, at: sample.t, tuning: tuning)
            if renewed || still {
                s.phase = .checkIn(since: sample.t)
                return CrashUpdate(state: s, effects: [.speakCheckIn])
            }
            if sample.t - since >= tuning.confirmWindowS {
                s.phase = .armed
            }
            return CrashUpdate(state: s)

        case .checkIn, .alarm, .escalated:
            // One incident at a time: sensor input never spawns or resets an
            // incident past check-in. Timing advances via tick().
            return CrashUpdate(state: s)
        }
    }

    /// What a real crash leaves behind: the rider and phone stop moving.
    private static func stillness(_ recent: [CrashSample], at t: TimeInterval, tuning: CrashTuning) -> Bool {
        let window = recent.filter { $0.t >= t - tuning.stillWindowS }
        guard window.count >= 10 else { return false }
        if window.contains(where: { ($0.speedKmh ?? 0) >= tuning.stillSpeedKmh }) { return false }
        let values = window.map(\.accelG)
        let mean = values.reduce(0, +) / Double(values.count)
        let variance = values.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / Double(values.count)
        return variance < tuning.stillVarianceG2
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run xcodebuild test with `-only-testing:MaxHelmetTests/CrashEngineDetectionTests` — PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/MaxHelmet/Crash/CrashEngine.swift ios/MaxHelmetTests/CrashEngineTests.swift
git commit -m "feat(ios): pure CrashEngine detection core with trace tests"
```

---

### Task 8: CrashEngine — escalation timing, cancel, latching

**Files:**

- Modify: `ios/MaxHelmet/Crash/CrashEngine.swift`
- Test: `ios/MaxHelmetTests/CrashEngineTests.swift` (append)

**Interfaces:**

- Produces (Task 10 consumes):
  - `static func tick(now: TimeInterval, state: CrashState, tuning: CrashTuning = .standard) -> CrashUpdate`
  - `static func riderCancelled(state: CrashState) -> CrashUpdate`
  - `static func simulate(now: TimeInterval, state: CrashState) -> CrashUpdate`

- [ ] **Step 1: Write the failing tests**

Append to `ios/MaxHelmetTests/CrashEngineTests.swift`:

```swift
final class CrashEngineEscalationTests: XCTestCase {

    private func checkInState(at t: TimeInterval = 10) -> CrashState {
        var s = CrashState.armed
        s.phase = .checkIn(since: t)
        return s
    }

    func testCheckInTimesOutIntoAlarm() {
        let update = CrashEngine.tick(now: 10 + 15, state: checkInState(at: 10))
        guard case .alarm = update.state.phase else { return XCTFail("expected alarm, got \(update.state.phase)") }
        XCTAssertEqual(update.effects, [.showAlarm])

        let early = CrashEngine.tick(now: 10 + 14.9, state: checkInState(at: 10))
        guard case .checkIn = early.state.phase else { return XCTFail("must not fire early") }
        XCTAssertTrue(early.effects.isEmpty)
    }

    func testAlarmTimesOutIntoExactlyOneEscalation() {
        var s = checkInState(at: 10)
        s.phase = .alarm(since: 25)
        let update = CrashEngine.tick(now: 25 + 30, state: s)
        guard case .escalated = update.state.phase else { return XCTFail("expected escalated") }
        XCTAssertEqual(update.effects, [.escalate])

        let again = CrashEngine.tick(now: 25 + 60, state: update.state)
        XCTAssertTrue(again.effects.isEmpty, "escalation must be latched, never repeated")
    }

    func testCancelFromCheckInAndAlarmLogsNearMiss() {
        for phase in [CrashPhase.checkIn(since: 10), CrashPhase.alarm(since: 10)] {
            var s = CrashState.armed
            s.phase = phase
            let update = CrashEngine.riderCancelled(state: s)
            XCTAssertEqual(update.state.phase, .armed)
            XCTAssertEqual(update.effects, [.dismiss, .logNearMiss])
        }
    }

    func testCancelAfterEscalationSendsTheFollowUp() {
        var s = CrashState.armed
        s.phase = .escalated(at: 55)
        let update = CrashEngine.riderCancelled(state: s)
        XCTAssertEqual(update.state.phase, .armed)
        XCTAssertEqual(update.effects, [.dismiss, .sendCancel])
    }

    func testCancelWhileArmedIsANoOp() {
        let update = CrashEngine.riderCancelled(state: .armed)
        XCTAssertEqual(update.state.phase, .armed)
        XCTAssertTrue(update.effects.isEmpty)
    }

    func testSimulatePromotesOnlyFromArmed() {
        let update = CrashEngine.simulate(now: 5, state: .armed)
        guard case .checkIn = update.state.phase else { return XCTFail("expected checkIn") }
        XCTAssertEqual(update.effects, [.speakCheckIn])

        let latched = CrashEngine.simulate(now: 6, state: update.state)
        XCTAssertTrue(latched.effects.isEmpty, "simulate must not restack an active incident")
    }

    func testSensorInputDuringIncidentIsIgnored() {
        var s = checkInState(at: 10)
        let spike = CrashSample(t: 11, accelG: 9.0, rotationRadS: 9.0, speedKmh: 0)
        let update = CrashEngine.step(sample: spike, state: s)
        guard case .checkIn = update.state.phase else { return XCTFail("second spike must not spawn a second incident") }
        XCTAssertTrue(update.effects.isEmpty)
        s.phase = .escalated(at: 12)
        let latched = CrashEngine.step(sample: spike, state: s)
        guard case .escalated = latched.state.phase else { return XCTFail("escalated must stay latched") }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run xcodebuild test with `-only-testing:MaxHelmetTests/CrashEngineEscalationTests`. Expected: BUILD FAIL — `tick`/`riderCancelled`/`simulate` don't exist.

- [ ] **Step 3: Implement in `CrashEngine`**

```swift
    static func tick(now: TimeInterval, state: CrashState, tuning: CrashTuning = .standard) -> CrashUpdate {
        var s = state
        switch s.phase {
        case .impactCandidate(let since) where now - since >= tuning.confirmWindowS:
            s.phase = .armed
            return CrashUpdate(state: s)
        case .checkIn(let since) where now - since >= tuning.checkInWindowS:
            s.phase = .alarm(since: now)
            return CrashUpdate(state: s, effects: [.showAlarm])
        case .alarm(let since) where now - since >= tuning.alarmWindowS:
            s.phase = .escalated(at: now)
            return CrashUpdate(state: s, effects: [.escalate])
        default:
            return CrashUpdate(state: s)
        }
    }

    static func riderCancelled(state: CrashState) -> CrashUpdate {
        var s = state
        switch s.phase {
        case .checkIn, .alarm:
            s.phase = .armed
            return CrashUpdate(state: s, effects: [.dismiss, .logNearMiss])
        case .escalated:
            s.phase = .armed
            return CrashUpdate(state: s, effects: [.dismiss, .sendCancel])
        case .armed, .impactCandidate:
            return CrashUpdate(state: s)
        }
    }

    static func simulate(now: TimeInterval, state: CrashState) -> CrashUpdate {
        guard case .armed = state.phase else { return CrashUpdate(state: state) }
        var s = state
        s.phase = .checkIn(since: now)
        return CrashUpdate(state: s, effects: [.speakCheckIn])
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run xcodebuild test with `-only-testing:MaxHelmetTests/CrashEngineDetectionTests -only-testing:MaxHelmetTests/CrashEngineEscalationTests` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/MaxHelmet/Crash/CrashEngine.swift ios/MaxHelmetTests/CrashEngineTests.swift
git commit -m "feat(ios): CrashEngine escalation timing, cancel paths, and latching"
```

---

### Task 9: MotionFeed, SirenSource, SirenPlayer

**Files:**

- Create: `ios/MaxHelmet/Crash/MotionFeed.swift`
- Create: `ios/MaxHelmet/Crash/Siren.swift`
- Modify: `ios/MaxHelmet/Info.plist`
- Test: `ios/MaxHelmetTests/SirenSourceTests.swift`

**Interfaces:**

- Consumes: `CrashSample` (Task 7); `PcmPlayer.play(_ pcm: Data)` / `stopPlayback()` semantics (PcmPlayer.swift:78/127 — 24 kHz PCM16 mono, the shared `voiceEngine` so AEC keeps working).
- Produces (Task 10 consumes):
  - `protocol MotionStreaming: AnyObject { var onSample: ((CrashSample) -> Void)? { get set }; func start(); func stop() }`
  - `final class SystemMotionFeed: MotionStreaming` with `init(speedProvider: @escaping () -> Double?)`
  - `enum SirenSource { static func makePcm(durationS: Double) -> Data }` (24 kHz PCM16 mono two-tone)
  - `final class SirenPlayer { init(play: @escaping (Data) -> Void, stop: @escaping () -> Void); func start(); func stop(); private(set) var running: Bool }`

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/SirenSourceTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

final class SirenSourceTests: XCTestCase {

    func testPcmHasTheRightShapeAndIsLoud() {
        let pcm = SirenSource.makePcm(durationS: 2.0)
        XCTAssertEqual(pcm.count, Int(2.0 * 24_000) * 2, "24 kHz PCM16 mono: 2 bytes per sample")

        let samples: [Int16] = pcm.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        let rms = (samples.map { Double($0) * Double($0) }.reduce(0, +) / Double(samples.count)).squareRoot()
        XCTAssertGreaterThan(rms, 10_000, "the siren must be near full scale, not polite")
    }

    func testSirenPlayerLoopsUntilStopped() {
        var played = 0
        var stopped = 0
        let player = SirenPlayer(play: { _ in played += 1 }, stop: { stopped += 1 })
        player.start()
        XCTAssertEqual(played, 1, "first blast plays immediately")
        XCTAssertTrue(player.running)
        player.start()
        XCTAssertEqual(played, 1, "start is idempotent while running")
        player.stop()
        XCTAssertEqual(stopped, 1)
        XCTAssertFalse(player.running)
        player.stop()
        XCTAssertEqual(stopped, 1, "stop is idempotent")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run xcodebuild test with `-only-testing:MaxHelmetTests/SirenSourceTests`. Expected: BUILD FAIL.

- [ ] **Step 3: Implement `ios/MaxHelmet/Crash/Siren.swift`**

```swift
import Foundation

/// Loopable two-tone siren rendered as 24 kHz PCM16 mono — the same format
/// PcmPlayer speaks, so the siren goes through the shared voice engine and
/// echo cancellation keeps working.
enum SirenSource {
    static let sampleRate = 24_000.0
    static let highHz = 950.0
    static let lowHz = 700.0
    static let toneS = 0.5

    static func makePcm(durationS: Double = 2.0) -> Data {
        let total = Int(durationS * sampleRate)
        var data = Data(capacity: total * 2)
        for i in 0..<total {
            let t = Double(i) / sampleRate
            let hz = Int(t / toneS) % 2 == 0 ? highHz : lowHz
            let value = Int16(0.85 * Double(Int16.max) * sin(2 * .pi * hz * t))
            withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
        }
        return data
    }
}

/// Owns the repeat loop; the injected closures do the actual audio I/O so
/// tests never touch AVAudioEngine.
final class SirenPlayer {
    private let play: (Data) -> Void
    private let stopPlayback: () -> Void
    private var timer: Timer?
    private let pcm = SirenSource.makePcm()
    private(set) var running = false

    init(play: @escaping (Data) -> Void, stop: @escaping () -> Void) {
        self.play = play
        self.stopPlayback = stop
    }

    func start() {
        guard !running else { return }
        running = true
        play(pcm)
        timer = Timer.scheduledTimer(withTimeInterval: 1.9, repeats: true) { [weak self] _ in
            guard let self, self.running else { return }
            self.play(self.pcm)
        }
    }

    func stop() {
        guard running else { return }
        running = false
        timer?.invalidate()
        timer = nil
        stopPlayback()
    }
}
```

- [ ] **Step 4: Implement `ios/MaxHelmet/Crash/MotionFeed.swift`**

```swift
import CoreMotion
import Foundation

protocol MotionStreaming: AnyObject {
    var onSample: ((CrashSample) -> Void)? { get set }
    func start()
    func stop()
}

/// Thin CoreMotion adapter: ~100 Hz device motion while a session is live.
/// No decisions here — magnitudes go straight into CrashEngine.
final class SystemMotionFeed: MotionStreaming {
    private let manager = CMMotionManager()
    private let queue = OperationQueue()
    private let speedProvider: () -> Double?
    var onSample: ((CrashSample) -> Void)?

    init(speedProvider: @escaping () -> Double?) {
        self.speedProvider = speedProvider
        queue.maxConcurrentOperationCount = 1
    }

    func start() {
        guard manager.isDeviceMotionAvailable, !manager.isDeviceMotionActive else { return }
        manager.deviceMotionUpdateInterval = 1.0 / 100.0
        manager.startDeviceMotionUpdates(to: queue) { [weak self] motion, _ in
            guard let self, let m = motion else { return }
            let a = m.userAcceleration
            let r = m.rotationRate
            let sample = CrashSample(
                t: m.timestamp,
                accelG: (a.x * a.x + a.y * a.y + a.z * a.z).squareRoot(),
                rotationRadS: (r.x * r.x + r.y * r.y + r.z * r.z).squareRoot(),
                speedKmh: self.speedProvider()
            )
            DispatchQueue.main.async { self.onSample?(sample) }
        }
    }

    func stop() {
        manager.stopDeviceMotionUpdates()
    }
}
```

- [ ] **Step 5: Add the Info.plist usage string**

In `ios/MaxHelmet/Info.plist`, next to the other usage strings (~line 46):

```xml
<key>NSMotionUsageDescription</key>
<string>检测摔车事故需要读取运动传感器。</string>
```

- [ ] **Step 6: Run tests to verify they pass**

Run xcodebuild test with `-only-testing:MaxHelmetTests/SirenSourceTests` — PASS.

- [ ] **Step 7: Commit**

```bash
git add ios/MaxHelmet/Crash/MotionFeed.swift ios/MaxHelmet/Crash/Siren.swift ios/MaxHelmet/Info.plist ios/MaxHelmetTests/SirenSourceTests.swift
git commit -m "feat(ios): CoreMotion feed and loopable siren for the crash path"
```

---

### Task 10: CrashController + AgentSession wiring

**Files:**

- Create: `ios/MaxHelmet/Crash/CrashController.swift`
- Modify: `ios/MaxHelmet/Agent/AgentSession.swift` (lazy controller near `deviceRouter` ~line 169; `handleEvent` cases ~line 758; transcript case ~line 793; `start()` update block ~line 269; `stop()` teardown ~line 350; `sessionStarted` case ~line 760; `State` struct)
- Test: `ios/MaxHelmetTests/CrashControllerTests.swift`

**Interfaces:**

- Consumes: `CrashEngine` + types (Tasks 7-8), `MotionStreaming`/`SirenPlayer` (Task 9), `buildCrashAlert`/`buildCrashCancel`/`CrashAckStatus`/`.crashAck`/`.crashSimulate` (Task 6).
- Produces:
  - `struct CrashSettings { var contactNumber: String?; var relayOptIn: Bool; var callTarget: String; var logOnly: Bool }` (Task 12 supplies real values; default `CrashSettings(contactNumber: nil, relayOptIn: false, callTarget: "120", logOnly: false)`)
  - `@MainActor final class CrashController` — full API in the code below; key entry points `arm()`, `disarm()`, `sessionEnded()`, `handleSample(_:)`, `handleTick()`, `riderTapCancelled()`, `riderTranscript(_:)`, `handleAck(incidentId:status:detail:)`, `handleSimulate()`, `socketBecameReady()`
  - `enum CrashUIPhase: Equatable { case hidden, checkIn(sinceT: TimeInterval), alarm(sinceT: TimeInterval), escalated(ackText: String?) }` published to `AgentSession.State.crashPhase`
  - `AgentSession.State` gains `var crashPhase: CrashUIPhase = .hidden` and `var crashLocationText: String?` (Task 11 renders these)

- [ ] **Step 1: Write the failing tests**

Create `ios/MaxHelmetTests/CrashControllerTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

private final class FakeMotion: MotionStreaming, @unchecked Sendable {
    var onSample: ((CrashSample) -> Void)?
    var started = false
    func start() { started = true }
    func stop() { started = false }
}

@MainActor
final class CrashControllerTests: XCTestCase {

    private var sent: [String] = []
    private var spoken: [String] = []
    private var sirenOn = 0
    private var sirenOff = 0
    private var interrupted = 0
    private var phases: [CrashUIPhase] = []
    private var now: TimeInterval = 100
    private var settings = CrashSettings(contactNumber: "+8613800000000", relayOptIn: true, callTarget: "120", logOnly: false)
    private var motion = FakeMotion()

    private func makeController() -> CrashController {
        let controller = CrashController(
            motion: motion,
            locate: { completion in completion(.init(latitude: 31.23, longitude: 121.47)) },
            speak: { [weak self] line in self?.spoken.append(line) },
            interruptPlayback: { [weak self] in self?.interrupted += 1 },
            siren: SirenPlayer(play: { [weak self] _ in self?.sirenOn += 1 }, stop: { [weak self] in self?.sirenOff += 1 }),
            send: { [weak self] json in self?.sent.append(json) },
            settings: { [weak self] in self!.settings },
            now: { [weak self] in self!.now }
        )
        controller.onUIChange = { [weak self] phase in self?.phases.append(phase) }
        return controller
    }

    func testArmStartsMotionAndSimulateSpeaksCheckIn() {
        let controller = makeController()
        controller.arm()
        XCTAssertTrue(motion.started)
        controller.handleSimulate()
        XCTAssertEqual(interrupted, 1, "check-in cuts agent speech first")
        XCTAssertEqual(spoken.count, 1)
        XCTAssertTrue(spoken[0].contains("你还好吗"))
        guard case .checkIn = phases.last else { return XCTFail("UI must show check-in") }
    }

    func testFullTimeoutFlowEscalatesWithOptedInContact() throws {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        now += 15
        controller.handleTick()
        XCTAssertEqual(sirenOn, 1, "alarm starts the siren")
        guard case .alarm = phases.last else { return XCTFail("UI must show alarm") }
        now += 30
        controller.handleTick()
        XCTAssertEqual(sent.count, 1)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sent[0].utf8)) as? [String: Any])
        XCTAssertEqual(parsed["type"] as? String, ClientEventTypes.crashAlert)
        XCTAssertEqual(parsed["contactOptIn"] as? Bool, true)
        XCTAssertEqual(parsed["contactNumber"] as? String, "+8613800000000")
        XCTAssertEqual(parsed["lat"] as? Double ?? 0, 31.23, accuracy: 0.001)
    }

    /// Advance the staged countdowns: 15 s check-in → alarm, then 30 s alarm → escalated.
    private func escalate(_ controller: CrashController) {
        now += 15
        controller.handleTick()
        now += 30
        controller.handleTick()
    }

    func testAckOutcomesSpeakTheTruth() {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        escalate(controller)
        let incidentId = controller.activeIncidentIdForTesting ?? ""
        controller.handleAck(incidentId: incidentId, status: .notified, detail: nil)
        XCTAssertTrue(spoken.last?.contains("已通知紧急联系人") ?? false)

        spoken = []
        controller.handleAck(incidentId: incidentId, status: .unconfigured, detail: nil)
        XCTAssertTrue(spoken.last?.contains("请手动拨打") ?? false, "unconfigured must never sound like success")
    }

    func testTapCancelDuringAlarmStopsSirenAndNeverEscalates() {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        now += 15
        controller.handleTick()
        controller.riderTapCancelled()
        XCTAssertEqual(sirenOff, 1)
        XCTAssertEqual(phases.last, .hidden)
        now += 60
        controller.handleTick()
        XCTAssertTrue(sent.isEmpty, "cancelled incident must not escalate")
    }

    func testVoiceCancelMatchesMeiShi() {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        controller.riderTranscript("我没事，刚才手滑了")
        XCTAssertEqual(phases.last, .hidden)
    }

    func testCancelAfterEscalationSendsCrashCancel() throws {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        escalate(controller)
        controller.riderTapCancelled()
        XCTAssertEqual(sent.count, 2)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sent[1].utf8)) as? [String: Any])
        XCTAssertEqual(parsed["type"] as? String, ClientEventTypes.crashCancel)
    }

    func testUnackedAlertResendsWhenSocketBecomesReady() {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        escalate(controller)
        XCTAssertEqual(sent.count, 1)
        controller.socketBecameReady()
        XCTAssertEqual(sent.count, 2, "pending crash.alert resends on reconnect")
        let incidentId = controller.activeIncidentIdForTesting ?? ""
        controller.handleAck(incidentId: incidentId, status: .notified, detail: nil)
        controller.socketBecameReady()
        XCTAssertEqual(sent.count, 2, "acked alert must not resend")
    }

    func testLogOnlyModeDetectsButStaysSilent() {
        settings.logOnly = true
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        XCTAssertTrue(spoken.isEmpty)
        XCTAssertTrue(sent.isEmpty)
        XCTAssertTrue(phases.isEmpty || phases.last == .hidden)
    }

    func testDisarmClearsEverything() {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        now += 15
        controller.handleTick()
        controller.disarm()
        XCTAssertFalse(motion.started)
        XCTAssertEqual(sirenOff, 1)
        XCTAssertEqual(phases.last, .hidden)
    }

    func testNoAckShowsManualDialNotice() {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        escalate(controller)
        now += 10
        controller.handleTick()
        guard case let .escalated(ackText) = phases.last else { return XCTFail("expected escalated") }
        XCTAssertTrue(ackText?.contains("服务器未确认") ?? false, "nobody may believe a notification that didn't happen")
    }

    func testSessionEndDuringAlarmKeepsTheAlarmRunning() {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        now += 15
        controller.handleTick()
        controller.sessionEnded()
        XCTAssertFalse(motion.started, "detection stops with the session")
        XCTAssertEqual(sirenOff, 0, "but an active alarm keeps running")
        now += 30
        controller.handleTick()
        XCTAssertEqual(sent.count, 1, "escalation still fires after session death")
    }

    func testSessionEndWhileMerelyArmedDisarms() {
        let controller = makeController()
        controller.arm()
        controller.sessionEnded()
        XCTAssertFalse(motion.started)
        XCTAssertEqual(phases.last ?? .hidden, .hidden)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run xcodebuild test with `-only-testing:MaxHelmetTests/CrashControllerTests`. Expected: BUILD FAIL.

- [ ] **Step 3: Implement `ios/MaxHelmet/Crash/CrashController.swift`**

```swift
import CoreLocation
import Foundation

struct CrashSettings {
    var contactNumber: String?
    var relayOptIn: Bool
    var callTarget: String   // "contact" or "120"
    var logOnly: Bool
}

enum CrashUIPhase: Equatable {
    case hidden
    case checkIn(sinceT: TimeInterval)
    case alarm(sinceT: TimeInterval)
    case escalated(ackText: String?)
}

/// The glue between the pure CrashEngine and the world: motion samples in,
/// speech/siren/UI/relay events out. Owns nothing safety-critical itself —
/// every decision comes back from CrashEngine as an effect.
@MainActor
final class CrashController {
    struct Lines {
        var checkIn = "检测到疑似摔车。你还好吗？没事请回答“我没事”，或点一下屏幕。"
        var ackNotified = "已通知紧急联系人。"
        var ackFailed = "紧急联系人通知失败，请手动拨打求助电话。"
        var ackUnconfigured = "服务器没有配置通知通道，请手动拨打求助电话。"
        var noAck = "服务器未确认 — 请手动拨打"
    }

    private let motion: MotionStreaming
    private let locate: (@escaping (CLLocationCoordinate2D?) -> Void) -> Void
    private let speak: (String) -> Void
    private let interruptPlayback: () -> Void
    private let siren: SirenPlayer
    private let send: (String) -> Void
    private let settings: () -> CrashSettings
    private let now: () -> TimeInterval
    private let tuning: CrashTuning
    private let lines = Lines()

    private var state = CrashState.armed
    private var armed = false
    private var tickTimer: Timer?
    private var pendingAlertJson: String?
    private var activeIncidentId: String?
    private var acked = false
    private var alertSentAt: TimeInterval?
    private var noAckNoticeShown = false
    private let ackTimeoutS: TimeInterval = 10

    var onUIChange: ((CrashUIPhase) -> Void)?
    var onLocationText: ((String?) -> Void)?
    var activeIncidentIdForTesting: String? { activeIncidentId }

    init(motion: MotionStreaming,
         locate: @escaping (@escaping (CLLocationCoordinate2D?) -> Void) -> Void,
         speak: @escaping (String) -> Void,
         interruptPlayback: @escaping () -> Void,
         siren: SirenPlayer,
         send: @escaping (String) -> Void,
         settings: @escaping () -> CrashSettings,
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         tuning: CrashTuning = .standard) {
        self.motion = motion
        self.locate = locate
        self.speak = speak
        self.interruptPlayback = interruptPlayback
        self.siren = siren
        self.send = send
        self.settings = settings
        self.now = now
        self.tuning = tuning
        motion.onSample = { [weak self] sample in self?.handleSample(sample) }
    }

    /// Idempotent: a new session while an old incident is still alarming
    /// restarts detection without touching the incident.
    func arm() {
        armed = true
        motion.start()
        if tickTimer == nil {
            tickTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in self?.handleTick() }
            }
        }
    }

    func disarm() {
        armed = false
        motion.stop()
        tickTimer?.invalidate()
        tickTimer = nil
        siren.stop()
        state = .armed
        pendingAlertJson = nil
        activeIncidentId = nil
        acked = false
        alertSentAt = nil
        noAckNoticeShown = false
        onUIChange?(.hidden)
        onLocationText?(nil)
    }

    /// The alarm outlives the session: detection stops (no more samples), but
    /// an incident past check-in keeps its countdowns, siren, and UI.
    func sessionEnded() {
        switch state.phase {
        case .armed, .impactCandidate:
            disarm()
        case .checkIn, .alarm, .escalated:
            motion.stop()
        }
    }

    func handleSample(_ sample: CrashSample) {
        guard armed else { return }
        apply(CrashEngine.step(sample: sample, state: state, tuning: tuning))
    }

    func handleTick() {
        guard armed else { return }
        apply(CrashEngine.tick(now: now(), state: state, tuning: tuning))
        if case .escalated = state.phase, let sentAt = alertSentAt, !acked, !noAckNoticeShown,
           now() - sentAt >= ackTimeoutS {
            noAckNoticeShown = true
            onUIChange?(.escalated(ackText: lines.noAck))
        }
    }

    func handleSimulate() {
        guard armed else { return }
        apply(CrashEngine.simulate(now: now(), state: state))
    }

    func riderTapCancelled() {
        apply(CrashEngine.riderCancelled(state: state))
    }

    func riderTranscript(_ text: String) {
        guard case .armed = state.phase else {
            if text.contains("没事") || text.contains("取消") {
                apply(CrashEngine.riderCancelled(state: state))
            }
            return
        }
    }

    func handleAck(incidentId: String, status: CrashAckStatus, detail: String?) {
        guard incidentId == activeIncidentId else { return }
        acked = true
        pendingAlertJson = nil
        alertSentAt = nil
        let line: String
        switch status {
        case .notified: line = lines.ackNotified
        case .failed: line = detail.map { "\(lines.ackFailed)（\($0)）" } ?? lines.ackFailed
        case .unconfigured: line = lines.ackUnconfigured
        }
        speak(line)
        if case .escalated = state.phase { onUIChange?(.escalated(ackText: line)) }
    }

    func socketBecameReady() {
        if let pendingAlertJson, !acked { send(pendingAlertJson) }
    }

    private func apply(_ update: CrashUpdate) {
        state = update.state
        for effect in update.effects { perform(effect) }
    }

    private func perform(_ effect: CrashEffect) {
        if settings().logOnly {
            // Harvest mode: record what would have happened, do nothing.
            print("[crash] log-only: \(effect) at \(now())")
            if effect == .speakCheckIn { state = .armed }
            return
        }
        switch effect {
        case .speakCheckIn:
            interruptPlayback()
            speak(lines.checkIn)
            onUIChange?(.checkIn(sinceT: now()))
        case .showAlarm:
            siren.start()
            onUIChange?(.alarm(sinceT: now()))
        case .escalate:
            escalate()
        case .dismiss:
            siren.stop()
            onUIChange?(.hidden)
            onLocationText?(nil)
        case .logNearMiss:
            print("[crash] near-miss cancelled at \(now())")
        case .sendCancel:
            if let activeIncidentId { send(buildCrashCancel(incidentId: activeIncidentId)) }
        }
    }

    private func escalate() {
        let incidentId = UUID().uuidString
        activeIncidentId = incidentId
        acked = false
        noAckNoticeShown = false
        let current = settings()
        let speedRecent = state.recent.compactMap(\.speedKmh).max()
        onUIChange?(.escalated(ackText: nil))
        locate { [weak self] coordinate in
            guard let self else { return }
            if let coordinate {
                self.onLocationText?(String(format: "%.5f, %.5f", coordinate.latitude, coordinate.longitude))
            }
            let json = buildCrashAlert(
                incidentId: incidentId,
                lat: coordinate?.latitude,
                lon: coordinate?.longitude,
                speedKmhRecent: speedRecent,
                contactNumber: current.relayOptIn ? current.contactNumber : nil,
                contactOptIn: current.relayOptIn,
                detectedAt: Date().timeIntervalSince1970 * 1000
            )
            self.pendingAlertJson = json
            self.alertSentAt = self.now()
            self.send(json)
        }
    }
}
```

- [ ] **Step 4: Run controller tests**

Run xcodebuild test with `-only-testing:MaxHelmetTests/CrashControllerTests` — PASS. (The `testVoiceCancelMatchesMeiShi` guard-based transcript matcher: cancel phrases only act while an incident is active.)

- [ ] **Step 5: Wire into `AgentSession`**

In `ios/MaxHelmet/Agent/AgentSession.swift`:

State additions (in the `State` struct):

```swift
    var crashPhase: CrashUIPhase = .hidden
    var crashLocationText: String?
```

Settings injection point (near the other public vars):

```swift
    /// Supplied by MainViewModel (Task 12); safe defaults until then.
    var crashSettingsProvider: () -> CrashSettings = {
        CrashSettings(contactNumber: nil, relayOptIn: false, callTarget: "120", logOnly: false)
    }
```

Lazy controller, next to `deviceRouter` (~line 169), following its closure-injection idiom:

```swift
    private lazy var crashLocationProvider = LocationProvider()
    private(set) lazy var crashController = CrashController(
        motion: SystemMotionFeed(speedProvider: { [weak self] in
            guard let self, self.state.value.hasRideContext else { return nil }
            return Double(self.state.value.rideContext.speedKmh)
        }),
        locate: { [weak self] completion in self?.crashLocationProvider.resolve(completion) ?? completion(nil) },
        speak: { [weak self] line in self?.speak(line) },
        interruptPlayback: { [weak self] in self?.stopAgentSpeech() },
        siren: SirenPlayer(
            play: { [weak self] pcm in self?.player.play(pcm) },
            stop: { [weak self] in self?.player.stopPlayback() }
        ),
        send: { [weak self] json in self?.webSocket?.send(.string(json)) { _ in } },
        settings: { [weak self] in self?.crashSettingsProvider() ?? CrashSettings(contactNumber: nil, relayOptIn: false, callTarget: "120", logOnly: false) }
    )
```

Wire the UI callbacks right after the session's init (or first use):

```swift
        crashController.onUIChange = { [weak self] phase in self?.update { $0.crashPhase = phase } }
        crashController.onLocationText = { [weak self] text in self?.update { $0.crashLocationText = text } }
```

`handleEvent` cases (next to `.hazardAlert` ~line 835):

```swift
        case let .crashAck(incidentId, status, detail):
            crashController.handleAck(incidentId: incidentId, status: status, detail: detail)
        case .crashSimulate:
            crashController.handleSimulate()
```

In the `.sessionStarted` case (~line 760), after the existing state flip: `crashController.socketBecameReady()`.

In the transcript case (~line 793), inside `if speaker == .rider { … }`: `crashController.riderTranscript(text)`.

In `start()` after the `update { … }` block (~line 278): `crashController.arm()`.
In `stop()` teardown (~line 350): `crashController.sessionEnded()` — **not** `disarm()`, and do **not** clear `$0.crashPhase` in the teardown block: the alarm outlives the session (spec: "Session death mid-incident"). The controller's `onUIChange` callback is the only writer of `crashPhase`.

Note: `speak(_:)` and `stopAgentSpeech()` are `private` on AgentSession — the closures above live inside AgentSession, so access is fine. Note the siren plays binary PCM through the same `player` used for voice (24 kHz PCM16 — `PcmPlayer.play(Data)`).

- [ ] **Step 6: Run the full iOS suite**

Run the xcodebuild test command (whole `MaxHelmetTests`) — all PASS, including the existing `SessionLifecycleTests`.

- [ ] **Step 7: Commit**

```bash
git add ios/MaxHelmet/Crash/CrashController.swift ios/MaxHelmet/Agent/AgentSession.swift ios/MaxHelmetTests/CrashControllerTests.swift
git commit -m "feat(ios): CrashController glue — engine effects to speech, siren, relay, UI"
```

---

### Task 11: Check-in banner + CrashAlarmView

**Files:**

- Create: `ios/MaxHelmet/Crash/CrashAlarmView.swift`
- Modify: `ios/MaxHelmet/UI/AgentScreen.swift` (`alerts` builder ~line 221; top-level ZStack for the full-screen cover)
- Modify: `ios/MaxHelmet/UI/AgentScreenLayout.swift` (visibility flags feeding `captionsHeight`/`helmetDiameter`)
- Test: `ios/MaxHelmetTests/AgentScreenLayoutTests.swift` (append)

**Interfaces:**

- Consumes: `AgentSession.State.crashPhase` / `.crashLocationText` (Task 10); `session.crashController.riderTapCancelled()`; `SystemURLOpener` (`CallDialer.swift:8`) for the call button; `HudColors` / `HudTheme` styling; the existing `hazardVisible` layout-flag pattern (`AgentScreen.swift:150-168`, `AgentScreenLayout.swift`).
- Produces: `CrashCheckInBanner` (tappable banner in the `alerts` stack) and `CrashAlarmView` (full-screen overlay for `.alarm`/`.escalated`); `AgentScreenLayout` functions gain a `crashVisible: Bool` parameter.

- [ ] **Step 1: Write the failing layout test**

Append to `ios/MaxHelmetTests/AgentScreenLayoutTests.swift` (`portraitChromeHeight(captionsVisible:hazardVisible:recordingVisible:guidanceVisible:)` and `helmetDiameter(layout:available:captionsVisible:hazardVisible:recordingVisible:guidanceVisible:)` are the existing signatures — both gain a defaulted `crashVisible: Bool = false`):

```swift
    func testCrashBannerReservesChromeLikeAHazardBanner() {
        let without = portraitChromeHeight(captionsVisible: false, hazardVisible: false, recordingVisible: false)
        let with = portraitChromeHeight(
            captionsVisible: false, hazardVisible: false, recordingVisible: false, crashVisible: true
        )
        XCTAssertEqual(with - without, HudMetrics.hazardBanner,
                       "the check-in banner reserves the same vertical space as a hazard banner")
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run xcodebuild test with `-only-testing:MaxHelmetTests/AgentScreenLayoutTests`. Expected: BUILD FAIL — `crashVisible` parameter doesn't exist.

- [ ] **Step 3: Extend the layout budget**

In `AgentScreenLayout.swift`, add `crashVisible: Bool = false` to `portraitChromeHeight(...)`, `helmetDiameter(...)`, and `captionsHeight(...)`, flowing exactly as `hazardVisible` does, contributing `HudMetrics.hazardBanner` height when true (in the landscape branch of `helmetDiameter`, subtract it alongside the existing hazard term). In `AgentScreen.swift` (~line 150-168), compute it:

```swift
        let crashVisible: Bool = {
            if case .checkIn = state.crashPhase { return true }
            return false
        }()
```

and pass it through both layout calls. (Only the check-in banner participates in layout; alarm/escalated is a full-screen cover that bypasses the stack.)

- [ ] **Step 4: Build the views**

Create `ios/MaxHelmet/Crash/CrashAlarmView.swift`:

```swift
import SwiftUI

/// Check-in: a tappable banner in the alerts stack, HazardBanner-sized.
struct CrashCheckInBanner: View {
    let onCancel: () -> Void

    var body: some View {
        Button(action: onCancel) {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                VStack(alignment: .leading, spacing: 2) {
                    Text("疑似摔车 — 你还好吗？").font(.system(size: 15, weight: .bold))
                    Text("点此取消，或说“我没事”").font(.system(size: 12))
                }
                Spacer()
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.red.opacity(0.92)))
            .foregroundColor(.white)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("疑似摔车，点击取消警报")
    }
}

/// Alarm + escalated: full-screen, glanceable from the ground, tappable by
/// a gloved hand or a bystander.
struct CrashAlarmView: View {
    let phase: CrashUIPhase
    let locationText: String?
    let callNumber: String
    let onCancel: () -> Void

    private var statusLine: String {
        switch phase {
        case let .escalated(ackText): return ackText ?? "正在通知紧急联系人…"
        default: return "无人响应将通知紧急联系人"
        }
    }

    var body: some View {
        ZStack {
            Color.red.opacity(0.96).ignoresSafeArea()
            VStack(spacing: 24) {
                Text("检测到摔车").font(.system(size: 34, weight: .black))
                Text(statusLine).font(.system(size: 17, weight: .semibold))
                if let locationText {
                    // Large enough for a bystander to read to 120.
                    Text(locationText).font(.system(size: 24, weight: .bold, design: .monospaced))
                } else {
                    Text("正在定位…").font(.system(size: 17))
                }
                Button(action: onCancel) {
                    Text("我没事")
                        .font(.system(size: 28, weight: .black))
                        .frame(maxWidth: .infinity, minHeight: 88)
                        .background(RoundedRectangle(cornerRadius: 20).fill(Color.white))
                        .foregroundColor(.red)
                }
                Button {
                    if let url = URL(string: "tel://\(callNumber)") {
                        Task { _ = await SystemURLOpener().open(url) }
                    }
                } label: {
                    Text("拨打 \(callNumber)")
                        .font(.system(size: 22, weight: .bold))
                        .frame(maxWidth: .infinity, minHeight: 66)
                        .background(RoundedRectangle(cornerRadius: 20).fill(Color.black.opacity(0.35)))
                        .foregroundColor(.white)
                }
            }
            .padding(28)
            .foregroundColor(.white)
        }
    }
}
```

(If `SystemURLOpener.open` isn't reachable this way, mirror how `CallDialer` invokes it — `@MainActor func open(_ url: URL) async -> Bool` at `CallDialer.swift:8-13`.)

- [ ] **Step 5: Mount in `AgentScreen`**

In the `alerts` `@ViewBuilder` block (~line 221), alongside `HazardBanner`:

```swift
        if case .checkIn = state.crashPhase {
            CrashCheckInBanner(onCancel: { session.crashController.riderTapCancelled() })
        }
```

At the screen's top-level ZStack (covering everything, above both portrait and landscape stacks):

```swift
        if isAlarmPhase(state.crashPhase) {
            CrashAlarmView(
                phase: state.crashPhase,
                locationText: state.crashLocationText,
                callNumber: viewModel.crashCallTarget == "contact" ? (viewModel.crashContactNumber.isEmpty ? "120" : viewModel.crashContactNumber) : "120",
                onCancel: { session.crashController.riderTapCancelled() }
            )
            .zIndex(10)
        }
```

with a small pure helper in the same file (testable, like the presentation helpers):

```swift
func isAlarmPhase(_ phase: CrashUIPhase) -> Bool {
    switch phase {
    case .alarm, .escalated: return true
    default: return false
    }
}
```

Until Task 12 lands, reference the call target as the literal `"120"` (Task 12 replaces it with the viewModel binding shown above; if implementing tasks strictly in order, write `callNumber: "120"` now and let Task 12 finish it).

- [ ] **Step 6: Run tests to verify they pass**

Run xcodebuild test — `AgentScreenLayoutTests` (with the new case) and the full suite PASS.

- [ ] **Step 7: Commit**

```bash
git add ios/MaxHelmet/Crash/CrashAlarmView.swift ios/MaxHelmet/UI/AgentScreen.swift ios/MaxHelmet/UI/AgentScreenLayout.swift ios/MaxHelmetTests/AgentScreenLayoutTests.swift
git commit -m "feat(ios): crash check-in banner and full-screen alarm view"
```

---

### Task 12: Settings — contact, opt-in, call target, log-only

**Files:**

- Modify: `ios/MaxHelmet/UI/MainViewModel.swift` (`Keys` enum ~line 30, published vars, `init` seeding ~line 227)
- Modify: `ios/MaxHelmet/UI/AgentSettingsPanel.swift` (new `SectionCard` in `SettingsPanel`)
- Modify: `ios/MaxHelmet/UI/AgentScreen.swift` (finish the Task 11 `callNumber` wiring)
- Modify: wherever `MainViewModel` first touches the session (`toggleHandsFree` ~line 255 or init) — set `session.crashSettingsProvider`

**Interfaces:**

- Consumes: `CrashSettings` and `AgentSession.crashSettingsProvider` (Task 10); `SecureTokenStore.read(account:) -> String?` and `SecureTokenStore.write(_ value: String, account: String)` (`SecureTokenStore.swift:9,20` — `write("")` removes the entry); `SystemContactResolver` (`ContactResolver.swift:20` — `isAuthorized()`, `number(matching:)`, both async); the `Keys`/`didSet` persistence idiom (`MainViewModel.swift:30-72`); `SectionCard`/`Toggle`/`HudChip` idioms (`AgentSettingsPanel.swift:150-197, 319-360`).
- Produces: `MainViewModel` gains `crashContactNumber: String`, `crashRelayOptIn: Bool`, `crashCallTarget: String` (`"contact"`/`"120"`), `crashLogOnly: Bool`, all persisted; the session's `crashSettingsProvider` returns them live.

- [ ] **Step 1: Add the persisted settings**

In `MainViewModel.swift` `Keys`:

```swift
    static let crashContact = "crash_contact_number"   // SecureTokenStore account, not a defaults key
    static let crashRelayOptIn = "crash_relay_opt_in"
    static let crashCallTarget = "crash_call_target"
    static let crashLogOnly = "crash_log_only"
```

Published vars (contact number is quasi-secret — Keychain via `SecureTokenStore`, like the auth token at lines 66/229-230; use the store's actual read/write API):

```swift
    @Published var crashContactNumber: String { didSet { SecureTokenStore.write(crashContactNumber, account: Keys.crashContact) } }
    @Published var crashRelayOptIn: Bool { didSet { defaults.set(crashRelayOptIn, forKey: Keys.crashRelayOptIn) } }
    @Published var crashCallTarget: String { didSet { defaults.set(crashCallTarget, forKey: Keys.crashCallTarget) } }
    @Published var crashLogOnly: Bool { didSet { defaults.set(crashLogOnly, forKey: Keys.crashLogOnly) } }
```

Seed in `init()` (mirroring the neighbors):

```swift
        crashContactNumber = SecureTokenStore.read(account: Keys.crashContact) ?? ""
        crashRelayOptIn = defaults.bool(forKey: Keys.crashRelayOptIn)          // default OFF — the privacy carve-out is opt-in
        crashCallTarget = defaults.string(forKey: Keys.crashCallTarget) ?? "120"
        crashLogOnly = defaults.bool(forKey: Keys.crashLogOnly)
```

The spec's "emergency-contact picker via ContactResolver": the field accepts a contact **name or number**. Add to `MainViewModel`:

```swift
    /// A name in the contact field resolves to its number via Contacts, the
    /// same resolver the dial action uses. Numbers pass through untouched.
    func resolveCrashContactIfNeeded() {
        let raw = crashContactNumber.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty, raw.rangeOfCharacter(from: .decimalDigits) == nil else { return }
        Task { @MainActor in
            let resolver = SystemContactResolver()
            guard await resolver.isAuthorized(), let number = await resolver.number(matching: raw) else { return }
            self.crashContactNumber = number
        }
    }
```

and call it from the settings field's `.onSubmit { viewModel.resolveCrashContactIfNeeded() }` in Step 2.

Then, at the point where `MainViewModel` holds the session reference (init or first `toggleHandsFree`), wire:

```swift
        session.crashSettingsProvider = { [weak self] in
            guard let self else { return CrashSettings(contactNumber: nil, relayOptIn: false, callTarget: "120", logOnly: false) }
            let number = self.crashContactNumber.trimmingCharacters(in: .whitespaces)
            return CrashSettings(
                contactNumber: number.isEmpty ? nil : number,
                relayOptIn: self.crashRelayOptIn,
                callTarget: self.crashCallTarget,
                logOnly: self.crashLogOnly
            )
        }
```

- [ ] **Step 2: Build the settings section**

In `SettingsPanel` (`AgentSettingsPanel.swift`), add a `SectionCard(title: "紧急求助")` after the connection section, reusing the file's exact field/toggle idioms (text field: lines 150-166; toggle row: 168-175; chips: `ChipRow`/`HudChip` 333-360):

```swift
            SectionCard(title: "紧急求助") {
                Text("紧急联系人号码").font(.system(size: 12)).foregroundColor(HudColors.muted)
                TextField("+86 …", text: $viewModel.crashContactNumber)
                    .keyboardType(.phonePad)
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 10).fill(HudColors.panelElevated))
                    .disabled(state.handsFree)   // never mid-session

                HStack {
                    Text("事故升级时通知紧急联系人（号码仅在升级时发送到服务器）")
                        .font(.system(size: 12)).foregroundColor(HudColors.muted)
                    Spacer()
                    Toggle("", isOn: $viewModel.crashRelayOptIn).labelsHidden().tint(HudColors.accent)
                }

                ChipRow(label: "警报界面拨打") {
                    HudChip(label: "120", selected: viewModel.crashCallTarget == "120", selectedColor: HudColors.accent) {
                        viewModel.crashCallTarget = "120"
                    }
                    HudChip(label: "紧急联系人", selected: viewModel.crashCallTarget == "contact", selectedColor: HudColors.accent) {
                        viewModel.crashCallTarget = "contact"
                    }
                }

                HStack {
                    Text("仅记录模式（只记录检测，不报警 — 采集误报数据用）")
                        .font(.system(size: 12)).foregroundColor(HudColors.muted)
                    Spacer()
                    Toggle("", isOn: $viewModel.crashLogOnly).labelsHidden().tint(HudColors.accent)
                }
            }
```

(Adapt the exact `SectionCard`/`ChipRow` content-closure shapes to their real signatures at lines 319-360.)

- [ ] **Step 3: Finish the alarm-view call target**

In `AgentScreen.swift`, replace Task 11's literal `"120"` with the viewModel-driven expression from the Task 11 Step 5 snippet.

- [ ] **Step 4: Run the full iOS suite**

Run the xcodebuild test command — all PASS (this task is UI + persistence plumbing; the behavior it feeds is covered by `CrashControllerTests.testLogOnlyModeDetectsButStaysSilent` and `testFullTimeoutFlowEscalatesWithOptedInContact`).

- [ ] **Step 5: Commit**

```bash
git add ios/MaxHelmet/UI/MainViewModel.swift ios/MaxHelmet/UI/AgentSettingsPanel.swift ios/MaxHelmet/UI/AgentScreen.swift
git commit -m "feat(ios): crash settings — emergency contact, relay opt-in, call target, log-only"
```

---

### Task 13: Docs + full verification

**Files:**

- Modify: `README.md` ("Current Capabilities" list)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README capability bullet**

Add to "Current Capabilities" after the ADAS bullet:

```markdown
- Crash detection & emergency escalation (iOS) — during a hands-free session the phone's IMU watches for a crash signature (broad high-G pulse or tumble, then stillness); Max asks "你还好吗？", and no answer escalates: full-screen alarm with siren, GPS coordinates, and a pre-filled call button, plus an opt-in relay notification to the emergency contact. Max only claims "已通知紧急联系人" after the server's truthful ack; cancelling afterwards sends a 误报 follow-up. All countdowns run on the phone (the network is delivery-only, with resend on reconnect). Detection thresholds live in one tunable struct; a 仅记录 mode harvests real-ride traces before escalation is armed; the 事故 demo scenario rehearses the whole flow without hardware. The contact number leaves the device only inside an actual opted-in `crash.alert`.
```

- [ ] **Step 2: CHANGELOG entry**

Under a new "Added" heading at the top:

```markdown
### Added

- **Crash detection & emergency escalation (iOS)** — during a hands-free session
  the phone's IMU watches for a crash signature (≥4.5 g sustained pulse or ≥6 rad/s
  tumble, then stillness; speed-gated below 10 km/h). A pure, trace-tested
  `CrashEngine` (`ios/MaxHelmet/Crash/`) drives the flow: 15 s spoken check-in
  ("你还好吗？", cancel by tap or "我没事") → 30 s full-screen alarm with siren and
  GPS coordinates → one `crash.alert` to the relay. New protocol events
  `crash.alert` / `crash.cancel` / `crash.ack` / `crash.simulate`
  (`protocol/agent-events.schema.json`); relay module `server/crash-escalation.ts`
  with a pluggable notifier — log-only by default (`CRASH_NOTIFIER=log`), so the
  ack honestly reports `unconfigured` and Max tells the rider to dial by hand.
  Post-escalation cancel sends a 误报 follow-up. Alarm survives session death;
  un-acked alerts resend on reconnect; 10 s without an ack shows
  "服务器未确认 — 请手动拨打". Settings add an emergency contact (Keychain,
  name-or-number via the contacts resolver), a relay opt-in (default **off** — the
  one carve-out to "contact numbers never leave the device"), the alarm call
  target (120 / contact), and a 仅记录 mode to harvest real-ride traces before
  arming. New 事故 mock scenario rehearses the whole flow without hardware; web
  and Android ignore the new events. Honest limits: voice cancel needs the
  network (ASR is server-side), and iOS cannot place calls itself — the call
  button needs a human tap.
```

- [ ] **Step 3: Full verification**

Run: `npm run check` — protocol drift, format, lint, dead-code, vitest, fault matrix, build all green.
Run: the full xcodebuild test command — all green.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: crash detection & emergency escalation"
```

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch (merge `feat/crash-detection` + the spec branch to main per the project's local-merge convention).

---

## Verification at the end

1. `npm run check` green; full `MaxHelmetTests` green.
2. Manual rehearsal (mock, no hardware): web `选择场景 → 事故` — web ignores `crash.simulate` silently; iOS simulator: same scenario → check-in banner appears ~6 s in, tap-cancel works, letting it run reaches alarm → escalated → `crash.ack` (`unconfigured`, spoken honestly).
3. Human bench protocol (documented in the spec, needs a person): couch-drop and shake tests with 仅记录 on; then a real ride in log-only mode to harvest false-positive traces before arming escalation for real.
