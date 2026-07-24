# Voice-Triggered Device Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a rider speak a command to Max and have the iPhone actually do it — torch, Max's speaking volume, music, SMS, calling, and a destination card — with Max's spoken confirmation always matching the real result.

**Architecture:** The relay parses the final rider ASR transcript with a pure zh+en command grammar, issues a `device.command` event, and holds the command ID. iOS routes it to one handler per action and answers with `device.result`. On any non-`ok` result the relay truncates Doubao's in-flight speech and speaks the truth through the existing TTS-fallback path. The extractor sits behind an interface so Doubao function-calling can replace the grammar later without touching the protocol or any Swift file.

**Tech Stack:** TypeScript + Express + `ws` (relay), Vitest (server tests), Swift + SwiftUI + AVFoundation + MediaPlayer + MessageUI + Contacts + MapKit (iOS), XCTest (iOS tests). No new dependencies on either side.

**Spec:** `docs/superpowers/specs/2026-07-24-voice-device-actions-design.md`

## Global Constraints

- Branch is `feat/voice-device-actions`, already created off `main`.
- No new npm or SwiftPM dependencies. The iOS target has zero third-party deps and must keep zero.
- Every command resolves to exactly one `device.result`. Silence is a bug.
- Reconciliation timeout is **8000 ms**.
- SMS is refused unless `ride.context.speedKmh` is present **and** below **5 km/h**. Absent speed means refuse.
- Phone numbers never leave the device. The relay sends spoken names only.
- Contact names are redacted before QA persistence.
- Max claims an action complete only on `status: "ok"`.
- Chinese is the default spoken language; every rider-facing string added in this plan is Chinese.
- New Swift files go in `ios/MaxHelmet/Actions/`. `AgentSession.swift` (1054 lines) only forwards — no action logic lands there.
- `protocol/agent-events.schema.json` is the single source of truth. Never hand-edit `shared/generated/agent-protocol.ts`, `GeneratedAgentProtocol.kt`, or `GeneratedAgentProtocol.swift`.
- Run `npm run check` before the final commit of any server task.

**Server test command:** `npx vitest run tests/<file>` · **Full gate:** `npm run check`

**iOS test command:**

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild \
  -project ios/MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

---

### Task 1: Command grammar and action types

**Files:**
- Create: `server/device-actions.ts`
- Create: `tests/device-actions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DeviceCommand` (discriminated union on `action`), `DeviceActionName`, `DeviceActionTier`, `DeviceActionStatus`, `DEVICE_ACTION_TIERS: Record<DeviceActionName, DeviceActionTier>`, `IntentExtractor`, `extractDeviceCommand(text: string): DeviceCommand | null`.

> **Import direction, load-bearing:** all device-action types originate here and flow *outward*. `shared/agent.ts` imports them from this file (type-only, so Vite erases it); this file must never import from `shared/agent.ts`, or the two become circular.

> **Deviation from the spec, intentional:** the spec sketched `extractDeviceCommand(text, locale)`. The grammar matches Chinese and English patterns in a single pass, which also handles code-switching ("Max, navigate 到公司"). An unused `locale` parameter is YAGNI, so the signature drops it. The spec has been updated to match.

- [ ] **Step 1: Write the failing test**

Create `tests/device-actions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEVICE_ACTION_TIERS, extractDeviceCommand } from "../server/device-actions";

describe("extractDeviceCommand — torch", () => {
  it("turns the torch on in Chinese and English", () => {
    expect(extractDeviceCommand("Max 打开手电筒")).toEqual({ action: "torch.set", args: { on: true } });
    expect(extractDeviceCommand("Max，开灯")).toEqual({ action: "torch.set", args: { on: true } });
    expect(extractDeviceCommand("Max turn on the flashlight")).toEqual({ action: "torch.set", args: { on: true } });
  });

  it("turns the torch off", () => {
    expect(extractDeviceCommand("Max 关闭手电筒")).toEqual({ action: "torch.set", args: { on: false } });
    expect(extractDeviceCommand("Max turn off the torch")).toEqual({ action: "torch.set", args: { on: false } });
  });
});

describe("extractDeviceCommand — volume", () => {
  it("raises and lowers Max's own voice", () => {
    expect(extractDeviceCommand("Max 大声一点")).toEqual({ action: "volume.set", args: { direction: "up" } });
    expect(extractDeviceCommand("Max louder please")).toEqual({ action: "volume.set", args: { direction: "up" } });
    expect(extractDeviceCommand("Max 小声一点")).toEqual({ action: "volume.set", args: { direction: "down" } });
    expect(extractDeviceCommand("Max quieter")).toEqual({ action: "volume.set", args: { direction: "down" } });
  });
});

describe("extractDeviceCommand — music", () => {
  it("controls the system player", () => {
    expect(extractDeviceCommand("Max 放歌")).toEqual({ action: "music.control", args: { control: "play" } });
    expect(extractDeviceCommand("Max 下一首")).toEqual({ action: "music.control", args: { control: "next" } });
    expect(extractDeviceCommand("Max 上一首")).toEqual({ action: "music.control", args: { control: "previous" } });
    expect(extractDeviceCommand("Max pause the music")).toEqual({ action: "music.control", args: { control: "pause" } });
  });

  it("tags a named third-party player so the handler can refuse it", () => {
    expect(extractDeviceCommand("Max 用网易云放歌")).toEqual({
      action: "music.control",
      args: { control: "play", app: "网易云音乐" }
    });
    expect(extractDeviceCommand("Max play music on Spotify")).toEqual({
      action: "music.control",
      args: { control: "play", app: "Spotify" }
    });
  });
});

describe("extractDeviceCommand — sms", () => {
  it("extracts recipient and body", () => {
    expect(extractDeviceCommand("Max 给老王发条短信说我晚点到")).toEqual({
      action: "sms.compose",
      args: { name: "老王", body: "我晚点到" }
    });
    expect(extractDeviceCommand("Max text Wang saying running late")).toEqual({
      action: "sms.compose",
      args: { name: "Wang", body: "running late" }
    });
  });
});

describe("extractDeviceCommand — calling", () => {
  it("extracts a spoken contact name", () => {
    expect(extractDeviceCommand("Max 打给老王")).toEqual({ action: "call.dial", args: { name: "老王" } });
    expect(extractDeviceCommand("Max call Wang")).toEqual({ action: "call.dial", args: { name: "Wang" } });
  });

  it("maps emergency phrases to fixed numbers", () => {
    expect(extractDeviceCommand("Max 报警")).toEqual({ action: "call.dial", args: { number: "110" } });
    expect(extractDeviceCommand("Max 叫救护车")).toEqual({ action: "call.dial", args: { number: "120" } });
    expect(extractDeviceCommand("Max 叫交警")).toEqual({ action: "call.dial", args: { number: "122" } });
  });
});

describe("extractDeviceCommand — destination", () => {
  it("extracts the destination query", () => {
    expect(extractDeviceCommand("Max 导航去天安门")).toEqual({
      action: "destination.show",
      args: { query: "天安门" }
    });
    expect(extractDeviceCommand("Max navigate to the airport")).toEqual({
      action: "destination.show",
      args: { query: "the airport" }
    });
  });
});

describe("extractDeviceCommand — negatives", () => {
  it("ignores utterances that are not commands", () => {
    expect(extractDeviceCommand("Max 今天天气怎么样")).toBeNull();
    expect(extractDeviceCommand("Max 刚才那个电话是谁打的")).toBeNull();
    expect(extractDeviceCommand("Max what is the next exit")).toBeNull();
    expect(extractDeviceCommand("")).toBeNull();
  });

  it("respects negation", () => {
    expect(extractDeviceCommand("Max 别开手电筒")).toBeNull();
    expect(extractDeviceCommand("Max 不用放歌了")).toBeNull();
    expect(extractDeviceCommand("Max don't call Wang")).toBeNull();
  });
});

describe("DEVICE_ACTION_TIERS", () => {
  it("marks only messaging and calling as high risk", () => {
    expect(DEVICE_ACTION_TIERS).toEqual({
      "torch.set": "low",
      "volume.set": "low",
      "music.control": "low",
      "sms.compose": "high",
      "call.dial": "high",
      "destination.show": "low"
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/device-actions.test.ts`
Expected: FAIL — `Failed to resolve import "../server/device-actions"`.

- [ ] **Step 3: Write the implementation**

Create `server/device-actions.ts`:

```ts
/**
 * Turns a final rider utterance into a device command. Pure and dependency-free
 * so the whole grammar is table-testable, and so a Doubao function-calling
 * extractor can replace it later behind `IntentExtractor` without touching the
 * relay, the protocol, or any client.
 */

export type DeviceActionName =
  | "torch.set"
  | "volume.set"
  | "music.control"
  | "sms.compose"
  | "call.dial"
  | "destination.show";

export type DeviceActionTier = "low" | "high";

export type DeviceActionStatus = "ok" | "failed" | "denied" | "unsupported";

export type DeviceCommand =
  | { action: "torch.set"; args: { on: boolean } }
  | { action: "volume.set"; args: { direction: "up" | "down" } }
  | { action: "music.control"; args: { control: "play" | "pause" | "next" | "previous"; app?: string } }
  | { action: "sms.compose"; args: { name: string; body: string } }
  | { action: "call.dial"; args: { name?: string; number?: string } }
  | { action: "destination.show"; args: { query: string } };

/** Declared risk. iOS satisfies the high tier with the native system
 *  confirmation that `tel:` and MFMessageComposeViewController already force;
 *  the field exists for the camera (Spec 2) and for Android. */
export const DEVICE_ACTION_TIERS: Record<DeviceActionName, DeviceActionTier> = {
  "torch.set": "low",
  "volume.set": "low",
  "music.control": "low",
  "sms.compose": "high",
  "call.dial": "high",
  "destination.show": "low"
};

export type IntentExtractor = (text: string) => DeviceCommand | null;

/** Players we cannot drive. MPMusicPlayerController reaches only Apple Music and
 *  the local library; naming any of these must produce an honest refusal rather
 *  than silently controlling the wrong player. */
const THIRD_PARTY_PLAYERS: Array<[RegExp, string]> = [
  [/网易云(音乐)?/, "网易云音乐"],
  [/qq\s*音乐/i, "QQ音乐"],
  [/酷狗/, "酷狗音乐"],
  [/酷我/, "酷我音乐"],
  [/spotify/i, "Spotify"]
];

/** Rider said "don't" / "别" / "不用". Any command match is discarded. */
const NEGATION = /(别|不要|不用|不想|没必要|don'?t|do not|no need)/i;

const EMERGENCY_NUMBERS: Array<[RegExp, string]> = [
  [/(报警|叫警察|call the police)/i, "110"],
  [/(救护车|急救|ambulance)/i, "120"],
  [/(交警|事故报警|traffic police)/i, "122"]
];

function clean(value: string): string {
  return value.trim().replace(/^[，,。.、!！?？\s]+|[，,。.、!！?？\s]+$/g, "");
}

export const extractDeviceCommand: IntentExtractor = (text) => {
  const raw = text.trim();
  if (!raw) return null;
  if (NEGATION.test(raw)) return null;

  // Emergency first: "报警" must never be read as a contact named 警.
  for (const [pattern, number] of EMERGENCY_NUMBERS) {
    if (pattern.test(raw)) return { action: "call.dial", args: { number } };
  }

  if (/(打开|开启|开|亮起|turn on|switch on).{0,4}(手电筒|手电|照明|灯光|灯|flash\s?light|torch)/i.test(raw)) {
    return { action: "torch.set", args: { on: true } };
  }
  if (/(关闭|关掉|关|熄灭|turn off|switch off).{0,4}(手电筒|手电|照明|灯光|灯|flash\s?light|torch)/i.test(raw)) {
    return { action: "torch.set", args: { on: false } };
  }

  if (/(大声|响一点|声音.{0,2}大|调大|louder|speak up|volume up)/i.test(raw)) {
    return { action: "volume.set", args: { direction: "up" } };
  }
  if (/(小声|轻一点|声音.{0,2}小|调小|quieter|softer|volume down)/i.test(raw)) {
    return { action: "volume.set", args: { direction: "down" } };
  }

  const music = matchMusic(raw);
  if (music) return music;

  const sms = matchSms(raw);
  if (sms) return sms;

  const destination = matchDestination(raw);
  if (destination) return destination;

  const call = matchCall(raw);
  if (call) return call;

  return null;
};

function matchMusic(raw: string): DeviceCommand | null {
  let control: "play" | "pause" | "next" | "previous" | undefined;
  if (/(下一首|下一曲|next (track|song))/i.test(raw)) control = "next";
  else if (/(上一首|上一曲|previous (track|song))/i.test(raw)) control = "previous";
  else if (/(暂停|停一下|pause)/i.test(raw) && /(音乐|歌|music|song)/i.test(raw)) control = "pause";
  else if (/(放歌|播放音乐|放音乐|来点音乐|play (some )?music)/i.test(raw)) control = "play";
  if (!control) return null;

  for (const [pattern, label] of THIRD_PARTY_PLAYERS) {
    if (pattern.test(raw)) return { action: "music.control", args: { control, app: label } };
  }
  return { action: "music.control", args: { control } };
}

function matchSms(raw: string): DeviceCommand | null {
  const zh = /给\s*(?<name>[^\s，,。]{1,12})\s*发(?:条|个)?\s*(?:短信|信息|消息)\s*(?:说|内容是|:|：)?\s*(?<body>.+)/.exec(raw);
  if (zh?.groups?.name && zh.groups.body) {
    return { action: "sms.compose", args: { name: clean(zh.groups.name), body: clean(zh.groups.body) } };
  }
  const en = /(?:text|message|send a (?:text|message) to)\s+(?<name>[^\s]+)\s+(?:saying|that)\s+(?<body>.+)/i.exec(raw);
  if (en?.groups?.name && en.groups.body) {
    return { action: "sms.compose", args: { name: clean(en.groups.name), body: clean(en.groups.body) } };
  }
  return null;
}

function matchDestination(raw: string): DeviceCommand | null {
  const zh = /(?:导航|带我|我要)\s*(?:去|到|回)\s*(?<query>.+)/.exec(raw);
  if (zh?.groups?.query) {
    const query = clean(zh.groups.query);
    if (query) return { action: "destination.show", args: { query } };
  }
  const en = /(?:navigate|directions|take me|route)\s+to\s+(?<query>.+)/i.exec(raw);
  if (en?.groups?.query) {
    const query = clean(en.groups.query);
    if (query) return { action: "destination.show", args: { query } };
  }
  return null;
}

function matchCall(raw: string): DeviceCommand | null {
  const zh = /(?:打电话给|打给|呼叫|拨给)\s*(?<name>[^\s，,。]{1,12})/.exec(raw);
  if (zh?.groups?.name) {
    const name = clean(zh.groups.name);
    if (name) return { action: "call.dial", args: { name } };
  }
  const en = /\bcall\s+(?<name>[A-Za-z一-鿿][^\s,.]*)/i.exec(raw);
  if (en?.groups?.name) {
    const name = clean(en.groups.name);
    if (name) return { action: "call.dial", args: { name } };
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/device-actions.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add server/device-actions.ts tests/device-actions.test.ts
git commit -m "feat(actions): add rider command grammar"
```

---

### Task 2: Protocol events and client-event validation

**Files:**
- Modify: `protocol/agent-events.schema.json`
- Modify: `server/session-controller.ts:105-175` (`parseClientEvent`)
- Modify: `shared/agent.ts:215-238` (`ClientEvent`), `shared/agent.ts:240-308` (`AgentEvent`)
- Create: `tests/device-protocol.test.ts`
- Regenerated (do not hand-edit): `shared/generated/agent-protocol.ts`, `android/app/src/main/java/com/horizon/maxhelmet/agent/GeneratedAgentProtocol.kt`, `ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift`

**Interfaces:**
- Consumes: `DeviceActionName`, `DeviceActionTier`, `DeviceCommand` from Task 1.
- Produces: wire events `device.command` (server→client) and `device.result` (client→server); `parseClientEvent` accepting `device.result`; TypeScript types `DeviceCommandEvent` and `DeviceResultEvent`.

- [ ] **Step 1: Write the failing test**

Create `tests/device-protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseClientEvent } from "../server/session-controller";
import { CLIENT_EVENT_TYPES, SERVER_EVENT_TYPES } from "../shared/generated/agent-protocol";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("generated protocol", () => {
  it("includes the device events", () => {
    expect(SERVER_EVENT_TYPES).toContain("device.command");
    expect(CLIENT_EVENT_TYPES).toContain("device.result");
  });
});

describe("parseClientEvent — device.result", () => {
  it("accepts a minimal ok result", () => {
    expect(parseClientEvent(encode({ type: "device.result", commandId: "c1", status: "ok" }))).toEqual({
      type: "device.result",
      commandId: "c1",
      status: "ok",
      reason: undefined,
      detail: undefined
    });
  });

  it("accepts a failure with reason and detail", () => {
    expect(
      parseClientEvent(
        encode({ type: "device.result", commandId: "c2", status: "denied", reason: "unsafe.speed", detail: "骑行中" })
      )
    ).toEqual({
      type: "device.result",
      commandId: "c2",
      status: "denied",
      reason: "unsafe.speed",
      detail: "骑行中"
    });
  });

  it("rejects an unknown status", () => {
    expect(() => parseClientEvent(encode({ type: "device.result", commandId: "c3", status: "maybe" }))).toThrow(
      "Invalid device.result status"
    );
  });

  it("rejects a missing or oversized commandId", () => {
    expect(() => parseClientEvent(encode({ type: "device.result", status: "ok" }))).toThrow(
      "Invalid device.result commandId"
    );
    expect(() =>
      parseClientEvent(encode({ type: "device.result", commandId: "x".repeat(121), status: "ok" }))
    ).toThrow("Invalid device.result commandId");
  });

  it("rejects an oversized detail", () => {
    expect(() =>
      parseClientEvent(encode({ type: "device.result", commandId: "c4", status: "failed", detail: "x".repeat(501) }))
    ).toThrow("Invalid device.result detail");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/device-protocol.test.ts`
Expected: FAIL — `SERVER_EVENT_TYPES` does not contain `device.command`.

- [ ] **Step 3: Add the events to the schema**

In `protocol/agent-events.schema.json`, append to `$defs.ClientEvent.oneOf` (after the `TurnFeedback` entry):

```json
{
  "title": "DeviceResult",
  "type": "object",
  "properties": {
    "type": { "const": "device.result" },
    "commandId": { "type": "string", "minLength": 1 },
    "status": { "enum": ["ok", "failed", "denied", "unsupported"] },
    "reason": { "type": "string" },
    "detail": { "type": "string" }
  },
  "required": ["type", "commandId", "status"]
}
```

And append to `$defs.AgentEvent.oneOf` (after the `HazardAlert` entry):

```json
{
  "title": "DeviceCommand",
  "type": "object",
  "properties": {
    "type": { "const": "device.command" },
    "commandId": { "type": "string", "minLength": 1 },
    "action": {
      "enum": ["torch.set", "volume.set", "music.control", "sms.compose", "call.dial", "destination.show"]
    },
    "args": { "type": "object" },
    "tier": { "enum": ["low", "high"] }
  },
  "required": ["type", "commandId", "action", "args", "tier"]
}
```

- [ ] **Step 4: Regenerate the contracts**

Run: `npm run generate:protocol`
Expected output: three `Generated …` lines for the TypeScript, Kotlin, and Swift files.

- [ ] **Step 5: Add the shared TypeScript types**

In `shared/agent.ts`, add above `export type ClientEvent`:

```ts
export type DeviceCommandEvent = {
  type: "device.command";
  commandId: string;
  action: DeviceActionName;
  args: Record<string, unknown>;
  tier: DeviceActionTier;
};

export type DeviceResultEvent = {
  type: "device.result";
  commandId: string;
  status: DeviceActionStatus;
  reason?: string;
  detail?: string;
};
```

Add the import at the top of `shared/agent.ts` — type-only, so the client bundle is unaffected and no runtime dependency on `server/` is created:

```ts
import type { DeviceActionName, DeviceActionStatus, DeviceActionTier } from "../server/device-actions";
```

Add `| DeviceResultEvent` to the `ClientEvent` union and `| DeviceCommandEvent` to the `AgentEvent` union.

- [ ] **Step 6: Validate the new client event**

In `server/session-controller.ts`, insert immediately before the `if (value.type === "testing.metric")` block at line 152:

```ts
  if (value.type === "device.result") {
    if (typeof value.commandId !== "string" || !value.commandId.trim() || value.commandId.length > 120) {
      throw new Error("Invalid device.result commandId");
    }
    if (value.status !== "ok" && value.status !== "failed" && value.status !== "denied" && value.status !== "unsupported") {
      throw new Error("Invalid device.result status");
    }
    if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 120)) {
      throw new Error("Invalid device.result reason");
    }
    if (value.detail !== undefined && (typeof value.detail !== "string" || value.detail.length > 500)) {
      throw new Error("Invalid device.result detail");
    }
    return {
      type: "device.result",
      commandId: value.commandId,
      status: value.status,
      reason: value.reason as string | undefined,
      detail: value.detail as string | undefined
    };
  }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/device-protocol.test.ts`
Expected: PASS.

- [ ] **Step 8: Verify the generated files are in sync**

Run: `npm run check:protocol`
Expected: exit 0, no "stale" output.

- [ ] **Step 9: Commit**

```bash
git add protocol/agent-events.schema.json shared/agent.ts shared/generated/agent-protocol.ts \
  android/app/src/main/java/com/horizon/maxhelmet/agent/GeneratedAgentProtocol.kt \
  ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift \
  server/session-controller.ts tests/device-protocol.test.ts
git commit -m "feat(protocol): add device.command and device.result events"
```

---

### Task 3: Failure speech and the pending-command ledger

**Files:**
- Modify: `server/device-actions.ts`
- Modify: `tests/device-actions.test.ts`

**Interfaces:**
- Consumes: `DeviceActionName`, `DeviceCommand` from Task 1; `DeviceActionStatus` from Task 2.
- Produces: `deviceFailureSpeech(action, status, reason)`, `DEVICE_RESULT_TIMEOUT_MS`, and class `PendingDeviceCommands` with `issue(action)`, `resolve(commandId)`, `expire(now)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/device-actions.test.ts`:

```ts
import { DEVICE_RESULT_TIMEOUT_MS, PendingDeviceCommands, deviceFailureSpeech } from "../server/device-actions";

describe("deviceFailureSpeech", () => {
  it("explains a denied permission", () => {
    expect(deviceFailureSpeech("call.dial", "denied", "permission.contacts")).toContain("通讯录");
  });

  it("explains a locked phone", () => {
    expect(deviceFailureSpeech("torch.set", "failed", "device.locked")).toContain("锁屏");
  });

  it("explains the speed refusal", () => {
    expect(deviceFailureSpeech("sms.compose", "denied", "unsafe.speed")).toContain("停车");
  });

  it("explains an unreachable third-party player", () => {
    expect(deviceFailureSpeech("music.control", "unsupported", "player.unsupported")).toContain("本机音乐");
  });

  it("explains an unresolvable destination", () => {
    expect(deviceFailureSpeech("destination.show", "unsupported", "route.unavailable")).toContain("路线");
  });

  it("falls back to a generic honest line", () => {
    expect(deviceFailureSpeech("torch.set", "failed", undefined)).toContain("没成功");
  });
});

describe("PendingDeviceCommands", () => {
  it("issues unique ids and resolves them once", () => {
    const pending = new PendingDeviceCommands();
    const a = pending.issue("torch.set");
    const b = pending.issue("torch.set");
    expect(a.commandId).not.toEqual(b.commandId);
    expect(pending.resolve(a.commandId)?.action).toBe("torch.set");
    expect(pending.resolve(a.commandId)).toBeUndefined();
  });

  it("expires commands past the timeout and only those", () => {
    const pending = new PendingDeviceCommands();
    const issued = pending.issue("call.dial");
    expect(pending.expire(issued.issuedAt + DEVICE_RESULT_TIMEOUT_MS - 1)).toEqual([]);
    expect(pending.expire(issued.issuedAt + DEVICE_RESULT_TIMEOUT_MS)).toEqual([
      { commandId: issued.commandId, action: "call.dial", issuedAt: issued.issuedAt }
    ]);
    expect(pending.expire(issued.issuedAt + DEVICE_RESULT_TIMEOUT_MS)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/device-actions.test.ts`
Expected: FAIL — `PendingDeviceCommands is not a constructor`.

- [ ] **Step 3: Write the implementation**

Append to `server/device-actions.ts`:

```ts
import { randomUUID } from "node:crypto";

/** How long the relay waits for a device.result before treating the command as
 *  failed. Long enough for the rider to read a permission prompt, short enough
 *  that Max does not go quiet mid-ride. */
export const DEVICE_RESULT_TIMEOUT_MS = 8_000;

const FAILURE_SPEECH: Record<string, string> = {
  "permission.contacts": "我没有通讯录权限，去设置里开启后我再帮你拨号。",
  "permission.music": "我没有音乐库权限，去设置里开启后我再帮你播放。",
  "device.locked": "手机锁屏了，解锁后我再执行。",
  "unsafe.speed": "骑行中我不发短信，停车以后我再帮你发。",
  "player.unsupported": "我只能控制 Apple Music 和本机音乐。",
  "route.unavailable": "这个目的地我查不到路线。",
  "contact.notFound": "通讯录里没找到这个人。",
  "torch.unavailable": "这台设备没有可用的手电筒。"
};

/** The line Max speaks when a command did not succeed. Never claims success and
 *  never invents a cause it was not given. */
export function deviceFailureSpeech(
  action: DeviceActionName,
  status: DeviceActionStatus,
  reason: string | undefined
): string {
  if (status === "ok") throw new Error("deviceFailureSpeech called for a successful command");
  if (reason && FAILURE_SPEECH[reason]) return FAILURE_SPEECH[reason];
  return "刚才那个操作没成功。";
}

export type IssuedDeviceCommand = { commandId: string; action: DeviceActionName; issuedAt: number };

/** Tracks dispatched commands so no command can be left pending forever. */
export class PendingDeviceCommands {
  private readonly pending = new Map<string, IssuedDeviceCommand>();

  issue(action: DeviceActionName, now: number = Date.now()): IssuedDeviceCommand {
    const issued: IssuedDeviceCommand = { commandId: randomUUID(), action, issuedAt: now };
    this.pending.set(issued.commandId, issued);
    return issued;
  }

  resolve(commandId: string): IssuedDeviceCommand | undefined {
    const issued = this.pending.get(commandId);
    if (issued) this.pending.delete(commandId);
    return issued;
  }

  /** Removes and returns every command that has outlived the timeout. */
  expire(now: number = Date.now()): IssuedDeviceCommand[] {
    const expired: IssuedDeviceCommand[] = [];
    for (const issued of this.pending.values()) {
      if (now - issued.issuedAt >= DEVICE_RESULT_TIMEOUT_MS) expired.push(issued);
    }
    for (const issued of expired) this.pending.delete(issued.commandId);
    return expired;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/device-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/device-actions.ts tests/device-actions.test.ts
git commit -m "feat(actions): add failure speech and pending-command ledger"
```

---

### Task 4: Relay dispatch and reconciliation

**Files:**
- Modify: `server/providers/doubao.ts:1266-1272` (dispatch), `server/providers/doubao.ts:547-548` (session state)
- Modify: `server/providers/types.ts:21-31` (`AgentProvider`)
- Modify: `server/session-controller.ts:341-352` (event routing)
- Modify: `server/providers/mock.ts`
- Create: `tests/device-reconciliation.test.ts`

**Interfaces:**
- Consumes: `extractDeviceCommand`, `DEVICE_ACTION_TIERS`, `PendingDeviceCommands`, `deviceFailureSpeech` from Tasks 1 and 3; `DeviceResultEvent` from Task 2.
- Produces: `AgentProvider.deviceResult?(event: DeviceResultEvent): Promise<void>`; `device.command` emitted on the wire.

- [ ] **Step 1: Write the failing test**

Create `tests/device-reconciliation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { reconcileDeviceResult } from "../server/device-actions";

describe("reconcileDeviceResult", () => {
  it("stays silent on success so Doubao's own confirmation stands", () => {
    expect(reconcileDeviceResult("torch.set", { status: "ok" })).toEqual({ truncate: false, speech: undefined });
  });

  it("truncates and corrects on failure", () => {
    expect(reconcileDeviceResult("sms.compose", { status: "denied", reason: "unsafe.speed" })).toEqual({
      truncate: true,
      speech: "骑行中我不发短信，停车以后我再帮你发。"
    });
  });

  it("prefers the device's own detail when it supplies one", () => {
    expect(reconcileDeviceResult("call.dial", { status: "failed", reason: "x", detail: "自定义说明" })).toEqual({
      truncate: true,
      speech: "自定义说明"
    });
  });

  it("corrects an expired command with the generic line", () => {
    expect(reconcileDeviceResult("torch.set", { status: "failed", reason: "timeout" })).toEqual({
      truncate: true,
      speech: "刚才那个操作没成功。"
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/device-reconciliation.test.ts`
Expected: FAIL — `reconcileDeviceResult is not exported`.

- [ ] **Step 3: Add the pure reconciliation decision**

Append to `server/device-actions.ts`:

```ts
export type DeviceReconciliation = { truncate: boolean; speech: string | undefined };

/** Decides what the relay does about a result. Pure so every branch is testable
 *  without a provider or a socket. */
export function reconcileDeviceResult(
  action: DeviceActionName,
  result: { status: DeviceActionStatus; reason?: string; detail?: string }
): DeviceReconciliation {
  if (result.status === "ok") return { truncate: false, speech: undefined };
  const speech = result.detail?.trim() || deviceFailureSpeech(action, result.status, result.reason);
  return { truncate: true, speech };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/device-reconciliation.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the provider interface**

In `server/providers/types.ts`, add to `AgentProvider` after `updateLocation`:

```ts
  /** Result of a dispatched device command. Providers without a device-action
   *  path omit this. */
  deviceResult?(event: DeviceResultEvent): Promise<void>;
```

Add the import at the top of the file:

```ts
import type { DeviceResultEvent } from "../../shared/agent";
```

- [ ] **Step 6: Route the client event**

In `server/session-controller.ts`, add after the `testing.metric` line at 352:

```ts
      if (event.type === "device.result") await this.provider.deviceResult?.(event);
```

- [ ] **Step 7: Dispatch commands from the Doubao provider**

In `server/providers/doubao.ts`, add to the imports:

```ts
import {
  DEVICE_ACTION_TIERS,
  DEVICE_RESULT_TIMEOUT_MS,
  PendingDeviceCommands,
  extractDeviceCommand,
  reconcileDeviceResult
} from "../device-actions";
import type { DeviceActionName, DeviceActionStatus } from "../device-actions";
```

Add beside the delivery state at line 547:

```ts
  const pendingDeviceCommands = new PendingDeviceCommands();
  let deviceExpiryTimer: NodeJS.Timeout | undefined;
```

Add these two functions next to `truncateInterruptedReply` (line 692):

```ts
  function dispatchDeviceCommand(text: string): void {
    const command = extractDeviceCommand(text);
    if (!command) return;
    const issued = pendingDeviceCommands.issue(command.action);
    sendClient({
      type: "device.command",
      commandId: issued.commandId,
      action: command.action,
      args: command.args,
      tier: DEVICE_ACTION_TIERS[command.action]
    });
    scheduleDeviceExpiry();
  }

  function scheduleDeviceExpiry(): void {
    if (deviceExpiryTimer) return;
    deviceExpiryTimer = setTimeout(() => {
      deviceExpiryTimer = undefined;
      for (const expired of pendingDeviceCommands.expire()) {
        applyDeviceReconciliation(expired.action, { status: "failed", reason: "timeout" });
      }
    }, DEVICE_RESULT_TIMEOUT_MS);
    deviceExpiryTimer.unref?.();
  }

  function applyDeviceReconciliation(
    action: DeviceActionName,
    result: { status: DeviceActionStatus; reason?: string; detail?: string }
  ): void {
    const decision = reconcileDeviceResult(action, result);
    if (!decision.truncate) return;
    truncateInterruptedReply();
    if (decision.speech) {
      sendClient(transcriptEvent(agentDelivery, "agent", decision.speech, { final: true, useBrowserSpeech: true }));
    }
  }
```

Call the dispatcher at line 1270, immediately after the rider transcript is sent:

```ts
              sendClient(transcriptEvent(riderDelivery, "rider", text, { final: true }));
              dispatchDeviceCommand(text);
              emitMemory();
```

Expose the result handler on the returned provider object:

```ts
    async deviceResult(event) {
      const issued = pendingDeviceCommands.resolve(event.commandId);
      if (!issued) return;
      applyDeviceReconciliation(issued.action, event);
    },
```

In the provider's `close()`, clear the timer alongside the existing teardown so a
closed session cannot fire a reconciliation into a dead socket:

```ts
      if (deviceExpiryTimer) {
        clearTimeout(deviceExpiryTimer);
        deviceExpiryTimer = undefined;
      }
```

- [ ] **Step 8: Mirror the dispatch in the mock provider**

The mock replays scripted rider lines rather than doing ASR, so the same
extractor runs over `turn.rider`. This is what lets the whole feature be
demonstrated and QA'd with no Doubao credentials.

In `server/providers/mock.ts`, add the imports:

```ts
import { DEVICE_ACTION_TIERS, PendingDeviceCommands, extractDeviceCommand, reconcileDeviceResult } from "../device-actions";
import type { DeviceActionName, DeviceActionStatus } from "../device-actions";
```

Add beside the other session state:

```ts
  const pendingDeviceCommands = new PendingDeviceCommands();
```

Add these functions next to `emitConversation`:

```ts
  function dispatchDeviceCommand(text: string): void {
    const command = extractDeviceCommand(text);
    if (!command) return;
    const issued = pendingDeviceCommands.issue(command.action);
    send({
      type: "device.command",
      commandId: issued.commandId,
      action: command.action,
      args: command.args,
      tier: DEVICE_ACTION_TIERS[command.action]
    });
  }

  // The mock has no upstream conversation, so there is nothing to truncate —
  // only the corrective line is sent.
  function applyDeviceReconciliation(
    action: DeviceActionName,
    result: { status: DeviceActionStatus; reason?: string; detail?: string }
  ): void {
    const decision = reconcileDeviceResult(action, result);
    if (!decision.truncate || !decision.speech) return;
    send(transcriptEvent(createTranscriptDelivery(), "agent", decision.speech, { final: true, useBrowserSpeech: true }));
  }
```

Call the dispatcher at `server/providers/mock.ts:257`, right after the scripted
rider line is emitted:

```ts
    send(transcriptEvent(riderDelivery, "rider", turn.rider, { final: true }));
    dispatchDeviceCommand(turn.rider);
```

Expose the result handler on the returned provider object:

```ts
    async deviceResult(event) {
      const issued = pendingDeviceCommands.resolve(event.commandId);
      if (!issued) return;
      applyDeviceReconciliation(issued.action, event);
    },
```

Finally, add a command line to the `commute` scenario script so the mock demo
actually exercises the path:

```ts
      { rider: "Max，打开手电筒", agent: "好的，手电筒已经打开。", latencyBase: 94 },
```

- [ ] **Step 9: Run the full server suite**

Run: `npx vitest run`
Expected: PASS — including the pre-existing `doubao-session`, `websocket`, and `server-integration` suites.

- [ ] **Step 10: Commit**

```bash
git add server/device-actions.ts server/providers/doubao.ts server/providers/mock.ts \
  server/providers/types.ts server/session-controller.ts tests/device-reconciliation.test.ts
git commit -m "feat(relay): dispatch device commands and reconcile results"
```

---

### Task 5: Grounding prompt rewrite and QA redaction

**Files:**
- Modify: `server/providers/doubao.ts:131-141` (`buildToolGroundingPrompt`)
- Modify: `server/metrics.ts:439-462` (`recordTranscriptTurn`)
- Create: `tests/device-grounding.test.ts`

**Interfaces:**
- Consumes: `DeviceActionName` from Task 1.
- Produces: `redactContactNames(text: string): string` exported from `server/device-actions.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/device-grounding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildToolGroundingPrompt } from "../server/providers/doubao";
import { redactContactNames } from "../server/device-actions";

describe("buildToolGroundingPrompt", () => {
  const prompt = buildToolGroundingPrompt();

  it("declares the six real actions", () => {
    for (const capability of ["手电筒", "音量", "音乐", "短信", "电话", "目的地"]) {
      expect(prompt).toContain(capability);
    }
  });

  it("still forbids the capabilities we do not have", () => {
    for (const missing of ["实时交通", "车辆", "小队"]) {
      expect(prompt).toContain(missing);
    }
  });

  it("keeps the success-only rule", () => {
    expect(prompt).toContain("系统");
    expect(prompt).toContain("成功");
  });
});

describe("redactContactNames", () => {
  it("redacts the callee in a Chinese dial request", () => {
    expect(redactContactNames("Max 打给老王")).toBe("Max 打给[联系人]");
  });

  it("redacts the recipient but keeps the message body", () => {
    expect(redactContactNames("Max 给老王发条短信说我晚点到")).toBe("Max 给[联系人]发条短信说我晚点到");
  });

  it("redacts an English callee", () => {
    expect(redactContactNames("Max call Wang")).toBe("Max call [联系人]");
  });

  it("leaves emergency numbers and non-command text alone", () => {
    expect(redactContactNames("Max 报警")).toBe("Max 报警");
    expect(redactContactNames("Max 今天天气怎么样")).toBe("Max 今天天气怎么样");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/device-grounding.test.ts`
Expected: FAIL — `redactContactNames is not exported`, and the prompt assertions fail.

- [ ] **Step 3: Rewrite the grounding prompt**

Replace `buildToolGroundingPrompt` in `server/providers/doubao.ts`:

```ts
/** Declares the device actions the system can actually execute, and keeps every
 *  other external action explicitly out of reach. The success-only rule is now
 *  load-bearing: the relay dispatches real commands and corrects Max out loud
 *  when one fails. */
export function buildToolGroundingPrompt(): string {
  return (
    "[真实能力边界] 你可以请求系统执行这些设备动作：开关手电筒、调整你自己的说话音量、" +
    "控制 Apple Music 和本机音乐的播放、准备短信、拨打电话、查询目的地并显示路线卡片。" +
    "天气和骑行情报由系统注入，可以当作实时事实。" +
    "除此之外没有工具：没有实时交通、附近地点搜索、车辆控制或诊断、小队消息、第三方音乐应用、逐向导航语音。" +
    "拨号和短信必须由骑手在手机上确认，你只说正在准备，不要说已经拨通或已经发送。" +
    "任何动作只有在系统明确返回成功之后才可以说已完成；系统没有回应之前，不要描述结果。"
  );
}
```

- [ ] **Step 4: Add the redaction helper**

Append to `server/device-actions.ts`:

```ts
const CONTACT_PLACEHOLDER = "[联系人]";

/** Strips spoken contact names before a rider turn is persisted for QA. Phone
 *  numbers never reach the relay at all; names would otherwise land in stored
 *  transcripts via metrics.recordTranscriptTurn. */
export function redactContactNames(text: string): string {
  const command = extractDeviceCommand(text);
  if (!command) return text;
  if (command.action === "call.dial" && command.args.name) {
    return text.replace(command.args.name, CONTACT_PLACEHOLDER);
  }
  if (command.action === "sms.compose") {
    return text.replace(command.args.name, CONTACT_PLACEHOLDER);
  }
  return text;
}
```

- [ ] **Step 5: Apply redaction at the persistence boundary**

`server/metrics.ts:439` `recordTranscriptTurn` is the single point where a turn
becomes stored QA evidence. Redacting here — rather than at the transcript event
— keeps the rider's live captions and Max's own context intact while the stored
copy is clean.

Add the import to `server/metrics.ts`:

```ts
import { redactContactNames } from "./device-actions";
```

Replace line 448:

```ts
  const text = cleanText(payload.text).slice(0, 2_000);
```

with:

```ts
  // Rider commands can name a person ("打给老王"). The number never reaches the
  // relay; the name must not reach stored evidence either.
  const rawText = speaker === "rider" ? redactContactNames(payload.text) : payload.text;
  const text = cleanText(rawText).slice(0, 2_000);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/device-grounding.test.ts tests/metrics.test.ts`
Expected: PASS — both the new suite and the existing metrics suite.

- [ ] **Step 7: Run the full gate**

Run: `npm run check`
Expected: PASS — protocol check, format, lint, dead-code, tests, fault matrix, build.

- [ ] **Step 8: Commit**

```bash
git add server/providers/doubao.ts server/device-actions.ts server/metrics.ts tests/device-grounding.test.ts
git commit -m "feat(relay): declare real device tools and redact contact names"
```

---

### Task 6: iOS protocol decoding

**Files:**
- Modify: `ios/MaxHelmet/Agent/AgentProtocol.swift:276-292` (`AgentEvent`), `:311-415` (`parseAgentEvent`), `:478-498` (builders)
- Modify: `ios/MaxHelmetTests/AgentProtocolTests.swift`

**Interfaces:**
- Consumes: `ServerEventTypes.deviceCommand` and `ClientEventTypes.deviceResult` from the Task 2 regeneration.
- Produces: `DeviceAction` (Equatable enum), `DeviceCommand` struct, `DeviceActionTier`, `DeviceActionStatus`, `DeviceActionResult`, `AgentEvent.deviceCommand(DeviceCommand)`, `buildDeviceResult(commandId:result:) -> String`.

- [ ] **Step 1: Write the failing test**

Append to `ios/MaxHelmetTests/AgentProtocolTests.swift`:

```swift
    func testParsesTorchCommand() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"c1","action":"torch.set","args":{"on":true},"tier":"low"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.commandId, "c1")
        XCTAssertEqual(command.tier, .low)
        XCTAssertEqual(command.action, .torchSet(on: true))
    }

    func testParsesCallCommandWithName() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"c2","action":"call.dial","args":{"name":"老王"},"tier":"high"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.tier, .high)
        XCTAssertEqual(command.action, .callDial(name: "老王", number: nil))
    }

    func testParsesMusicCommandWithNamedApp() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"c3","action":"music.control","args":{"control":"play","app":"网易云音乐"},"tier":"low"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.action, .musicControl(control: .play, app: "网易云音乐"))
    }

    func testIgnoresUnknownActionRatherThanCrashing() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"c4","action":"camera.record","args":{},"tier":"high"}
        """)
        guard case .unhandled = event else { return XCTFail("Expected unhandled for an unknown action") }
    }

    func testBuildsDeviceResult() throws {
        let json = buildDeviceResult(commandId: "c5", result: .denied("unsafe.speed", "骑行中"))
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        )
        XCTAssertEqual(parsed["type"] as? String, "device.result")
        XCTAssertEqual(parsed["commandId"] as? String, "c5")
        XCTAssertEqual(parsed["status"] as? String, "denied")
        XCTAssertEqual(parsed["reason"] as? String, "unsafe.speed")
        XCTAssertEqual(parsed["detail"] as? String, "骑行中")
    }

    func testBuildsMinimalOkResultWithoutOptionalKeys() throws {
        let json = buildDeviceResult(commandId: "c6", result: .ok)
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        )
        XCTAssertEqual(parsed["status"] as? String, "ok")
        XCTAssertNil(parsed["reason"])
        XCTAssertNil(parsed["detail"])
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command from Global Constraints.
Expected: FAIL — `cannot find 'buildDeviceResult' in scope`.

- [ ] **Step 3: Add the types and decoding**

In `ios/MaxHelmet/Agent/AgentProtocol.swift`, add above `enum AgentEvent`:

```swift
enum DeviceActionTier: String, Equatable {
    case low, high
}

enum MusicControl: String, Equatable {
    case play, pause, next, previous
}

enum VolumeDirection: String, Equatable {
    case up, down
}

/// One executable device action. Typed rather than a raw dictionary so the
/// router's dispatch is exhaustive and every case is Equatable in tests.
enum DeviceAction: Equatable {
    case torchSet(on: Bool)
    case volumeSet(direction: VolumeDirection)
    case musicControl(control: MusicControl, app: String?)
    case smsCompose(name: String, body: String)
    case callDial(name: String?, number: String?)
    case destinationShow(query: String)
}

struct DeviceCommand: Equatable {
    let commandId: String
    let action: DeviceAction
    let tier: DeviceActionTier
}

enum DeviceActionStatus: String, Equatable {
    case ok, failed, denied, unsupported
}

/// Every handler returns exactly one of these. There is no "no result" case —
/// the relay treats silence as a failure after 8 s.
struct DeviceActionResult: Equatable {
    let status: DeviceActionStatus
    let reason: String?
    let detail: String?

    static let ok = DeviceActionResult(status: .ok, reason: nil, detail: nil)
    static func failed(_ reason: String, _ detail: String? = nil) -> DeviceActionResult {
        DeviceActionResult(status: .failed, reason: reason, detail: detail)
    }
    static func denied(_ reason: String, _ detail: String? = nil) -> DeviceActionResult {
        DeviceActionResult(status: .denied, reason: reason, detail: detail)
    }
    static func unsupported(_ reason: String, _ detail: String? = nil) -> DeviceActionResult {
        DeviceActionResult(status: .unsupported, reason: reason, detail: detail)
    }
}
```

Add the case to `AgentEvent`:

```swift
    case deviceCommand(DeviceCommand)
```

Add to the `switch type` in `parseAgentEvent`, before `case ServerEventTypes.error`:

```swift
    case ServerEventTypes.deviceCommand:
        let args = json["args"] as? [String: Any] ?? [:]
        guard let action = parseDeviceAction(str("action"), args) else { return .unhandled }
        return .deviceCommand(DeviceCommand(
            commandId: str("commandId"),
            action: action,
            tier: DeviceActionTier(rawValue: str("tier", "low")) ?? .low
        ))
```

Add the arg decoder next to `parseAgentEvent`:

```swift
/// Maps the wire action name plus its args onto a typed DeviceAction. An
/// unknown action or malformed args yields nil, which the caller turns into
/// `.unhandled` — a newer relay must never crash an older client.
func parseDeviceAction(_ name: String, _ args: [String: Any]) -> DeviceAction? {
    switch name {
    case "torch.set":
        return .torchSet(on: args["on"] as? Bool ?? false)
    case "volume.set":
        guard let raw = args["direction"] as? String,
              let direction = VolumeDirection(rawValue: raw) else { return nil }
        return .volumeSet(direction: direction)
    case "music.control":
        guard let raw = args["control"] as? String,
              let control = MusicControl(rawValue: raw) else { return nil }
        return .musicControl(control: control, app: args["app"] as? String)
    case "sms.compose":
        guard let recipient = args["name"] as? String, let body = args["body"] as? String else { return nil }
        return .smsCompose(name: recipient, body: body)
    case "call.dial":
        let name = args["name"] as? String
        let number = args["number"] as? String
        if name == nil && number == nil { return nil }
        return .callDial(name: name, number: number)
    case "destination.show":
        guard let query = args["query"] as? String, !query.isEmpty else { return nil }
        return .destinationShow(query: query)
    default:
        return nil
    }
}
```

Add the builder next to `buildTurnFeedback`:

```swift
/// Client → server device.result (validated by server/session-controller.ts).
/// Optional keys are omitted entirely rather than sent as null.
func buildDeviceResult(commandId: String, result: DeviceActionResult) -> String {
    var payload: [String: Any] = [
        "type": ClientEventTypes.deviceResult,
        "commandId": commandId,
        "status": result.status.rawValue
    ]
    if let reason = result.reason { payload["reason"] = reason }
    if let detail = result.detail { payload["detail"] = detail }
    let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
    return String(data: data, encoding: .utf8) ?? "{}"
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/MaxHelmet/Agent/AgentProtocol.swift ios/MaxHelmetTests/AgentProtocolTests.swift
git commit -m "feat(ios): decode device.command and encode device.result"
```

---

### Task 7: Device action router

**Files:**
- Create: `ios/MaxHelmet/Actions/DeviceActionHandler.swift`
- Create: `ios/MaxHelmet/Actions/DeviceActionRouter.swift`
- Create: `ios/MaxHelmetTests/DeviceActionRouterTests.swift`

**Interfaces:**
- Consumes: `DeviceAction`, `DeviceCommand`, `DeviceActionResult` from Task 6.
- Produces: `protocol DeviceActionHandler { func perform(_ action: DeviceAction) async -> DeviceActionResult }`, `DeviceActionRouter(handlers:isDeviceUnlocked:)` with `func handle(_ command: DeviceCommand) async -> DeviceActionResult`, and `DeviceActionRoute` (the routing key).

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/DeviceActionRouterTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

private final class FakeHandler: DeviceActionHandler, @unchecked Sendable {
    var received: [DeviceAction] = []
    var stubbed: DeviceActionResult = .ok

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        received.append(action)
        return stubbed
    }
}

final class DeviceActionRouterTests: XCTestCase {

    func testRoutesEachActionToItsHandler() async {
        let torch = FakeHandler()
        let music = FakeHandler()
        let router = DeviceActionRouter(
            handlers: [.torch: torch, .music: music],
            isDeviceUnlocked: { true }
        )

        _ = await router.handle(DeviceCommand(commandId: "a", action: .torchSet(on: true), tier: .low))
        _ = await router.handle(DeviceCommand(commandId: "b", action: .musicControl(control: .next, app: nil), tier: .low))

        XCTAssertEqual(torch.received, [.torchSet(on: true)])
        XCTAssertEqual(music.received, [.musicControl(control: .next, app: nil)])
    }

    func testReturnsHandlerResultVerbatim() async {
        let torch = FakeHandler()
        torch.stubbed = .failed("torch.unavailable")
        let router = DeviceActionRouter(handlers: [.torch: torch], isDeviceUnlocked: { true })

        let result = await router.handle(DeviceCommand(commandId: "a", action: .torchSet(on: true), tier: .low))

        XCTAssertEqual(result, .failed("torch.unavailable"))
    }

    func testRefusesEverythingWhileTheDeviceIsLocked() async {
        let torch = FakeHandler()
        let router = DeviceActionRouter(handlers: [.torch: torch], isDeviceUnlocked: { false })

        let result = await router.handle(DeviceCommand(commandId: "a", action: .torchSet(on: true), tier: .low))

        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "device.locked")
        XCTAssertTrue(torch.received.isEmpty, "A locked device must not reach the handler")
    }

    func testReportsUnsupportedWhenNoHandlerIsRegistered() async {
        let router = DeviceActionRouter(handlers: [:], isDeviceUnlocked: { true })

        let result = await router.handle(DeviceCommand(commandId: "a", action: .torchSet(on: true), tier: .low))

        XCTAssertEqual(result.status, .unsupported)
        XCTAssertEqual(result.reason, "handler.missing")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `cannot find 'DeviceActionRouter' in scope`.

- [ ] **Step 3: Write the handler protocol**

Create `ios/MaxHelmet/Actions/DeviceActionHandler.swift`:

```swift
import Foundation

/// One capability. Kept behind a protocol so every handler is replaceable by a
/// fake in tests — none of the real ones work in the simulator.
protocol DeviceActionHandler {
    func perform(_ action: DeviceAction) async -> DeviceActionResult
}

/// Routing key. One handler owns one route; the router never inspects args.
enum DeviceActionRoute: Hashable {
    case torch
    case volume
    case music
    case sms
    case call
    case destination

    init(_ action: DeviceAction) {
        switch action {
        case .torchSet: self = .torch
        case .volumeSet: self = .volume
        case .musicControl: self = .music
        case .smsCompose: self = .sms
        case .callDial: self = .call
        case .destinationShow: self = .destination
        }
    }
}
```

- [ ] **Step 4: Write the router**

Create `ios/MaxHelmet/Actions/DeviceActionRouter.swift`:

```swift
import Foundation

/// Dispatches a relay-issued command to exactly one handler and always produces
/// exactly one result. A locked or pocketed phone is refused before any handler
/// runs: iOS blocks URL opening, camera, and torch from the background, so
/// attempting the action would fail opaquely instead of telling the rider why.
struct DeviceActionRouter {
    private let handlers: [DeviceActionRoute: DeviceActionHandler]
    private let isDeviceUnlocked: () -> Bool

    init(handlers: [DeviceActionRoute: DeviceActionHandler], isDeviceUnlocked: @escaping () -> Bool) {
        self.handlers = handlers
        self.isDeviceUnlocked = isDeviceUnlocked
    }

    func handle(_ command: DeviceCommand) async -> DeviceActionResult {
        guard isDeviceUnlocked() else {
            return .failed("device.locked")
        }
        guard let handler = handlers[DeviceActionRoute(command.action)] else {
            return .unsupported("handler.missing")
        }
        return await handler.perform(command.action)
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ios/MaxHelmet/Actions/DeviceActionHandler.swift ios/MaxHelmet/Actions/DeviceActionRouter.swift \
  ios/MaxHelmetTests/DeviceActionRouterTests.swift
git commit -m "feat(ios): add device action router"
```

---

### Task 8: Torch and volume handlers

**Files:**
- Create: `ios/MaxHelmet/Actions/TorchController.swift`
- Create: `ios/MaxHelmet/Actions/PlaybackVolumeController.swift`
- Create: `ios/MaxHelmetTests/TorchVolumeHandlerTests.swift`
- Modify: `ios/MaxHelmet/Agent/PcmPlayer.swift`

**Interfaces:**
- Consumes: `DeviceActionHandler`, `DeviceAction`, `DeviceActionResult` from Tasks 6 and 7.
- Produces: `TorchController(device:)` where `device: TorchCapableDevice`; `protocol TorchCapableDevice { var hasTorch: Bool { get }; func setTorch(on: Bool) throws }`; `PlaybackVolumeController(gain:)` where `gain: PlaybackGain`; `protocol PlaybackGain { var level: Float { get }; func setLevel(_ level: Float) }`; `PcmPlayer` conforms to `PlaybackGain`.

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/TorchVolumeHandlerTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

private final class FakeTorch: TorchCapableDevice, @unchecked Sendable {
    var hasTorch = true
    var isOn = false
    var throwOnSet = false

    func setTorch(on: Bool) throws {
        if throwOnSet { throw NSError(domain: "test", code: 1) }
        isOn = on
    }
}

private final class FakeGain: PlaybackGain, @unchecked Sendable {
    var level: Float = 1.0
    func setLevel(_ newLevel: Float) { level = newLevel }
}

final class TorchVolumeHandlerTests: XCTestCase {

    func testTurnsTorchOnAndOff() async {
        let torch = FakeTorch()
        let handler = TorchController(device: torch)

        XCTAssertEqual(await handler.perform(.torchSet(on: true)), .ok)
        XCTAssertTrue(torch.isOn)
        XCTAssertEqual(await handler.perform(.torchSet(on: false)), .ok)
        XCTAssertFalse(torch.isOn)
    }

    func testReportsMissingTorchHardware() async {
        let torch = FakeTorch()
        torch.hasTorch = false
        let handler = TorchController(device: torch)

        let result = await handler.perform(.torchSet(on: true))

        XCTAssertEqual(result.status, .unsupported)
        XCTAssertEqual(result.reason, "torch.unavailable")
    }

    func testReportsTorchLockFailure() async {
        let torch = FakeTorch()
        torch.throwOnSet = true
        let handler = TorchController(device: torch)

        let result = await handler.perform(.torchSet(on: true))

        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "torch.unavailable")
    }

    func testRaisesAndLowersGainWithinBounds() async {
        let gain = FakeGain()
        let handler = PlaybackVolumeController(gain: gain)

        _ = await handler.perform(.volumeSet(direction: .up))
        XCTAssertEqual(gain.level, 1.5, accuracy: 0.001)

        gain.level = PlaybackVolumeController.maximumLevel
        _ = await handler.perform(.volumeSet(direction: .up))
        XCTAssertEqual(gain.level, PlaybackVolumeController.maximumLevel, accuracy: 0.001)

        gain.level = PlaybackVolumeController.minimumLevel
        _ = await handler.perform(.volumeSet(direction: .down))
        XCTAssertEqual(gain.level, PlaybackVolumeController.minimumLevel, accuracy: 0.001)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `cannot find 'TorchController' in scope`.

- [ ] **Step 3: Write the torch handler**

Create `ios/MaxHelmet/Actions/TorchController.swift`:

```swift
import AVFoundation

/// The torch surface the handler needs. AVCaptureDevice is not constructible in
/// tests and absent in the simulator, so the handler talks to this instead.
protocol TorchCapableDevice {
    var hasTorch: Bool { get }
    func setTorch(on: Bool) throws
}

/// Torch via AVCaptureDevice. Setting torchMode needs no camera permission —
/// only capture does — so this handler never prompts.
struct SystemTorchDevice: TorchCapableDevice {
    private let device = AVCaptureDevice.default(for: .video)

    var hasTorch: Bool { device?.hasTorch ?? false }

    func setTorch(on: Bool) throws {
        guard let device else { return }
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        device.torchMode = on ? .on : .off
    }
}

struct TorchController: DeviceActionHandler {
    private let device: TorchCapableDevice

    init(device: TorchCapableDevice = SystemTorchDevice()) {
        self.device = device
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard case let .torchSet(on) = action else { return .unsupported("action.mismatch") }
        guard device.hasTorch else { return .unsupported("torch.unavailable") }
        do {
            try device.setTorch(on: on)
            return .ok
        } catch {
            return .failed("torch.unavailable")
        }
    }
}
```

- [ ] **Step 4: Write the volume handler**

Create `ios/MaxHelmet/Actions/PlaybackVolumeController.swift`:

```swift
import Foundation

/// Max's own playback gain. Deliberately not system volume: iOS has no public
/// API to set that, and "Max，大声一点" means Max's voice, not the phone's.
protocol PlaybackGain {
    var level: Float { get }
    func setLevel(_ level: Float)
}

struct PlaybackVolumeController: DeviceActionHandler {
    /// PcmPlayer's shipped gain is 2.0, so the range must straddle it — a
    /// maximum of 2.0 would leave "大声一点" with nowhere to go. The soft
    /// limiter downstream keeps 4.0 from clipping at the helmet speaker.
    static let minimumLevel: Float = 0.5
    static let maximumLevel: Float = 4.0
    static let step: Float = 0.5

    private let gain: PlaybackGain

    init(gain: PlaybackGain) {
        self.gain = gain
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard case let .volumeSet(direction) = action else { return .unsupported("action.mismatch") }
        let delta = direction == .up ? Self.step : -Self.step
        let next = min(Self.maximumLevel, max(Self.minimumLevel, gain.level + delta))
        gain.setLevel(next)
        return .ok
    }
}
```

- [ ] **Step 5: Conform PcmPlayer to PlaybackGain**

`PcmPlayer.playbackGain` is currently a `static let` read inside the render block
at `ios/MaxHelmet/Agent/PcmPlayer.swift:176`. Make it an instance property so the
handler drives the real soft-limited output path instead of a parallel volume
concept.

Add the instance property beside the existing constants:

```swift
    /// Current output gain, adjustable by voice. Read on the audio render
    /// thread and written on the main thread; a naturally-aligned 32-bit scalar
    /// is read and written atomically on every architecture this app supports,
    /// so the render thread takes no lock.
    private var currentGain: Float = PcmPlayer.playbackGain
```

Replace line 176:

```swift
            let gain = PcmPlayer.playbackGain
```

with:

```swift
            let gain = currentGain
```

Add the conformance at the end of the file:

```swift
extension PcmPlayer: PlaybackGain {
    var level: Float { currentGain }

    func setLevel(_ newLevel: Float) {
        currentGain = newLevel
    }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ios/MaxHelmet/Actions/TorchController.swift ios/MaxHelmet/Actions/PlaybackVolumeController.swift \
  ios/MaxHelmet/Agent/PcmPlayer.swift ios/MaxHelmetTests/TorchVolumeHandlerTests.swift
git commit -m "feat(ios): add torch and playback volume handlers"
```

---

### Task 9: Music and SMS handlers

**Files:**
- Create: `ios/MaxHelmet/Actions/MusicController.swift`
- Create: `ios/MaxHelmet/Actions/MessageComposer.swift`
- Create: `ios/MaxHelmetTests/MusicMessageHandlerTests.swift`

**Interfaces:**
- Consumes: `DeviceActionHandler`, `DeviceAction`, `DeviceActionResult`, `ContactResolving` (declared here, implemented in Task 10).
- Produces: `MusicController(player:)` where `player: SystemMusicPlaying`; `protocol SystemMusicPlaying { func play(); func pause(); func next(); func previous() }`; `MessageComposer(presenter:speedProvider:resolver:)`; `protocol MessagePresenting { func present(number: String, body: String) async -> Bool }`; `SystemMessagePresenter` (the real `MFMessageComposeViewController`-backed implementation, used by Task 12); `MessageComposer.maximumSpeedKmh: Double = 5`.

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/MusicMessageHandlerTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

private final class FakePlayer: SystemMusicPlaying, @unchecked Sendable {
    var calls: [String] = []
    func play() { calls.append("play") }
    func pause() { calls.append("pause") }
    func next() { calls.append("next") }
    func previous() { calls.append("previous") }
}

private final class FakePresenter: MessagePresenting, @unchecked Sendable {
    var presented: [(String, String)] = []
    var result = true
    func present(number: String, body: String) async -> Bool {
        presented.append((number, body))
        return result
    }
}

private final class FakeResolver: ContactResolving, @unchecked Sendable {
    var number: String? = "13800000000"
    var authorized = true
    func isAuthorized() async -> Bool { authorized }
    func number(matching name: String) async -> String? { number }
}

final class MusicMessageHandlerTests: XCTestCase {

    func testDrivesTheSystemPlayer() async {
        let player = FakePlayer()
        let handler = MusicController(player: player)

        _ = await handler.perform(.musicControl(control: .play, app: nil))
        _ = await handler.perform(.musicControl(control: .next, app: nil))

        XCTAssertEqual(player.calls, ["play", "next"])
    }

    func testRefusesANamedThirdPartyPlayer() async {
        let player = FakePlayer()
        let handler = MusicController(player: player)

        let result = await handler.perform(.musicControl(control: .play, app: "网易云音乐"))

        XCTAssertEqual(result.status, .unsupported)
        XCTAssertEqual(result.reason, "player.unsupported")
        XCTAssertTrue(player.calls.isEmpty, "A refused player must not fall through to Apple Music")
    }

    func testComposesAMessageWhenStopped() async {
        let presenter = FakePresenter()
        let handler = MessageComposer(presenter: presenter, speedProvider: { 0 }, resolver: FakeResolver())

        let result = await handler.perform(.smsCompose(name: "老王", body: "我晚点到"))

        XCTAssertEqual(result, .ok)
        XCTAssertEqual(presenter.presented.first?.1, "我晚点到")
    }

    func testRefusesAboveTheSpeedLimit() async {
        let presenter = FakePresenter()
        let handler = MessageComposer(presenter: presenter, speedProvider: { 42 }, resolver: FakeResolver())

        let result = await handler.perform(.smsCompose(name: "老王", body: "我晚点到"))

        XCTAssertEqual(result.status, .denied)
        XCTAssertEqual(result.reason, "unsafe.speed")
        XCTAssertTrue(presenter.presented.isEmpty)
    }

    func testRefusesWhenSpeedIsUnknown() async {
        let presenter = FakePresenter()
        let handler = MessageComposer(presenter: presenter, speedProvider: { nil }, resolver: FakeResolver())

        let result = await handler.perform(.smsCompose(name: "老王", body: "我晚点到"))

        XCTAssertEqual(result.status, .denied)
        XCTAssertEqual(result.reason, "unsafe.speed")
    }

    func testReportsAnUnknownRecipient() async {
        let resolver = FakeResolver()
        resolver.number = nil
        let handler = MessageComposer(presenter: FakePresenter(), speedProvider: { 0 }, resolver: resolver)

        let result = await handler.perform(.smsCompose(name: "查无此人", body: "在吗"))

        XCTAssertEqual(result.reason, "contact.notFound")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `cannot find 'MusicController' in scope`.

- [ ] **Step 3: Write the music handler**

Create `ios/MaxHelmet/Actions/MusicController.swift`:

```swift
import MediaPlayer

/// The playback surface we can actually reach. MPMusicPlayerController drives
/// Apple Music and the local library only; no iOS API lets one app control
/// another app's playback.
protocol SystemMusicPlaying {
    func play()
    func pause()
    func next()
    func previous()
}

struct SystemMusicPlayer: SystemMusicPlaying {
    private let player = MPMusicPlayerController.systemMusicPlayer

    func play() { player.play() }
    func pause() { player.pause() }
    func next() { player.skipToNextItem() }
    func previous() { player.skipToPreviousItem() }
}

struct MusicController: DeviceActionHandler {
    private let player: SystemMusicPlaying

    init(player: SystemMusicPlaying = SystemMusicPlayer()) {
        self.player = player
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard case let .musicControl(control, app) = action else { return .unsupported("action.mismatch") }
        // The relay tags a named player only when it is one we cannot drive.
        // Refuse honestly rather than silently controlling Apple Music instead.
        if app != nil { return .unsupported("player.unsupported") }
        switch control {
        case .play: player.play()
        case .pause: player.pause()
        case .next: player.next()
        case .previous: player.previous()
        }
        return .ok
    }
}
```

- [ ] **Step 4: Write the message handler**

Create `ios/MaxHelmet/Actions/MessageComposer.swift`:

```swift
import Foundation
import MessageUI
import UIKit

/// Presents the system message sheet. Returns true once the sheet has been
/// shown — iOS requires the rider to tap Send, so "presented" is the most we
/// can ever truthfully report.
protocol MessagePresenting {
    func present(number: String, body: String) async -> Bool
}

/// Real presenter, backed by MFMessageComposeViewController. It pre-fills the
/// recipient and body; only the rider can send it.
@MainActor
final class SystemMessagePresenter: NSObject, MessagePresenting, MFMessageComposeViewControllerDelegate {
    private var continuation: CheckedContinuation<Bool, Never>?

    func present(number: String, body: String) async -> Bool {
        guard MFMessageComposeViewController.canSendText() else { return false }
        guard let root = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
            .first?.rootViewController else { return false }

        let composer = MFMessageComposeViewController()
        composer.recipients = [number]
        composer.body = body
        composer.messageComposeDelegate = self

        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            root.present(composer, animated: true) {
                continuation.resume(returning: true)
                self.continuation = nil
            }
        }
    }

    func messageComposeViewController(
        _ controller: MFMessageComposeViewController,
        didFinishWith result: MessageComposeResult
    ) {
        controller.dismiss(animated: true)
    }
}

struct MessageComposer: DeviceActionHandler {
    /// A message the rider must read and tap has no safe use in motion.
    static let maximumSpeedKmh: Double = 5

    private let presenter: MessagePresenting
    private let speedProvider: () -> Double?
    private let resolver: ContactResolving

    init(presenter: MessagePresenting, speedProvider: @escaping () -> Double?, resolver: ContactResolving) {
        self.presenter = presenter
        self.speedProvider = speedProvider
        self.resolver = resolver
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard case let .smsCompose(name, body) = action else { return .unsupported("action.mismatch") }
        // Unknown speed is refused, not allowed: a missing reading is not
        // evidence the bike is stopped.
        guard let speed = speedProvider(), speed < Self.maximumSpeedKmh else {
            return .denied("unsafe.speed")
        }
        guard await resolver.isAuthorized() else { return .denied("permission.contacts") }
        guard let number = await resolver.number(matching: name) else { return .failed("contact.notFound") }
        let presented = await presenter.present(number: number, body: body)
        return presented ? .ok : .failed("compose.dismissed")
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run the iOS test command.
Expected: FAIL initially — `ContactResolving` is declared in Task 10. Add the protocol declaration now in `ios/MaxHelmet/Actions/ContactResolver.swift`:

```swift
import Foundation

/// Resolves a spoken name to a phone number entirely on-device. The number
/// never leaves the phone; the relay only ever sends the spoken name.
protocol ContactResolving {
    func isAuthorized() async -> Bool
    func number(matching name: String) async -> String?
}
```

Re-run the iOS test command.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ios/MaxHelmet/Actions/MusicController.swift ios/MaxHelmet/Actions/MessageComposer.swift \
  ios/MaxHelmet/Actions/ContactResolver.swift ios/MaxHelmetTests/MusicMessageHandlerTests.swift
git commit -m "feat(ios): add music and message handlers"
```

---

### Task 10: Contact resolution and dialing

**Files:**
- Modify: `ios/MaxHelmet/Actions/ContactResolver.swift`
- Create: `ios/MaxHelmet/Actions/CallDialer.swift`
- Create: `ios/MaxHelmetTests/CallDialerTests.swift`

**Interfaces:**
- Consumes: `ContactResolving` from Task 9.
- Produces: `SystemContactResolver` implementing `ContactResolving`; `normalizeContactName(_:) -> String`; `CallDialer(opener:resolver:)`; `protocol URLOpening { func open(_ url: URL) async -> Bool }`.

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/CallDialerTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

private final class FakeOpener: URLOpening, @unchecked Sendable {
    var opened: [URL] = []
    var result = true
    func open(_ url: URL) async -> Bool {
        opened.append(url)
        return result
    }
}

private final class FakeResolver: ContactResolving, @unchecked Sendable {
    var number: String? = "13800000000"
    var authorized = true
    func isAuthorized() async -> Bool { authorized }
    func number(matching name: String) async -> String? { number }
}

final class CallDialerTests: XCTestCase {

    func testDialsAnEmergencyNumberWithoutTouchingContacts() async {
        let opener = FakeOpener()
        let resolver = FakeResolver()
        resolver.authorized = false
        let handler = CallDialer(opener: opener, resolver: resolver)

        let result = await handler.perform(.callDial(name: nil, number: "120"))

        XCTAssertEqual(result, .ok)
        XCTAssertEqual(opener.opened.first?.absoluteString, "tel://120")
    }

    func testResolvesANameThenDials() async {
        let opener = FakeOpener()
        let handler = CallDialer(opener: opener, resolver: FakeResolver())

        let result = await handler.perform(.callDial(name: "老王", number: nil))

        XCTAssertEqual(result, .ok)
        XCTAssertEqual(opener.opened.first?.absoluteString, "tel://13800000000")
    }

    func testReportsMissingContactsPermission() async {
        let resolver = FakeResolver()
        resolver.authorized = false
        let handler = CallDialer(opener: FakeOpener(), resolver: resolver)

        let result = await handler.perform(.callDial(name: "老王", number: nil))

        XCTAssertEqual(result.status, .denied)
        XCTAssertEqual(result.reason, "permission.contacts")
    }

    func testReportsAnUnknownContact() async {
        let resolver = FakeResolver()
        resolver.number = nil
        let handler = CallDialer(opener: FakeOpener(), resolver: resolver)

        let result = await handler.perform(.callDial(name: "查无此人", number: nil))

        XCTAssertEqual(result.reason, "contact.notFound")
    }

    func testReportsAFailedOpen() async {
        let opener = FakeOpener()
        opener.result = false
        let handler = CallDialer(opener: opener, resolver: FakeResolver())

        let result = await handler.perform(.callDial(name: "老王", number: nil))

        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "dial.failed")
    }

    func testNormalizesSpokenNamesForMatching() {
        XCTAssertEqual(normalizeContactName("老王，"), "老王")
        XCTAssertEqual(normalizeContactName("  Wang  "), "wang")
        XCTAssertEqual(normalizeContactName("Ｗａｎｇ"), "wang")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `cannot find 'CallDialer' in scope`.

- [ ] **Step 3: Implement contact resolution**

Replace the contents of `ios/MaxHelmet/Actions/ContactResolver.swift`:

```swift
import Contacts
import Foundation

/// Resolves a spoken name to a phone number entirely on-device. The number
/// never leaves the phone; the relay only ever sends the spoken name.
protocol ContactResolving {
    func isAuthorized() async -> Bool
    func number(matching name: String) async -> String?
}

/// Folds a spoken name to a comparable form: trims CJK and Latin punctuation,
/// lowercases, and converts fullwidth Latin (ASR emits Ｗａｎｇ) to halfwidth.
func normalizeContactName(_ name: String) -> String {
    let folded = name.applyingTransform(.fullwidthToHalfwidth, reverse: false) ?? name
    return folded
        .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters))
        .lowercased()
}

struct SystemContactResolver: ContactResolving {
    private let store = CNContactStore()

    func isAuthorized() async -> Bool {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized, .limited:
            return true
        case .notDetermined:
            return (try? await store.requestAccess(for: .contacts)) ?? false
        default:
            return false
        }
    }

    func number(matching name: String) async -> String? {
        let target = normalizeContactName(name)
        guard !target.isEmpty else { return nil }
        let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactPhoneNumbersKey]
        let request = CNContactFetchRequest(keysToFetch: keys as [CNKeyDescriptor])

        var exact: String?
        var partial: String?
        try? store.enumerateContacts(with: request) { contact, stop in
            guard let number = contact.phoneNumbers.first?.value.stringValue else { return }
            for candidate in [contact.nickname, contact.familyName + contact.givenName, contact.givenName] {
                let normalized = normalizeContactName(candidate)
                guard !normalized.isEmpty else { continue }
                if normalized == target {
                    exact = number
                    stop.pointee = true
                    return
                }
                if partial == nil, normalized.contains(target) || target.contains(normalized) {
                    partial = number
                }
            }
        }
        return exact ?? partial
    }
}
```

- [ ] **Step 4: Write the dialer**

Create `ios/MaxHelmet/Actions/CallDialer.swift`:

```swift
import Foundation
import UIKit

protocol URLOpening {
    func open(_ url: URL) async -> Bool
}

struct SystemURLOpener: URLOpening {
    @MainActor
    func open(_ url: URL) async -> Bool {
        await UIApplication.shared.open(url)
    }
}

/// Dials via `tel:`. Since iOS 10.3 the system always shows its own
/// confirmation alert before connecting, so a successful open means the rider
/// has been *asked*, not that a call is connected. Max must say it is placing
/// the call, never that it has connected one.
struct CallDialer: DeviceActionHandler {
    private let opener: URLOpening
    private let resolver: ContactResolving

    init(opener: URLOpening = SystemURLOpener(), resolver: ContactResolving = SystemContactResolver()) {
        self.opener = opener
        self.resolver = resolver
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard case let .callDial(name, number) = action else { return .unsupported("action.mismatch") }

        var target = number
        if target == nil, let name {
            guard await resolver.isAuthorized() else { return .denied("permission.contacts") }
            guard let resolved = await resolver.number(matching: name) else { return .failed("contact.notFound") }
            target = resolved
        }
        guard let target, let url = URL(string: "tel://\(target.filter { $0.isNumber || $0 == "+" })") else {
            return .failed("dial.failed")
        }
        return await opener.open(url) ? .ok : .failed("dial.failed")
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ios/MaxHelmet/Actions/ContactResolver.swift ios/MaxHelmet/Actions/CallDialer.swift \
  ios/MaxHelmetTests/CallDialerTests.swift
git commit -m "feat(ios): add contact resolution and dialing"
```

---

### Task 11: Destination card

**Files:**
- Create: `ios/MaxHelmet/Actions/DestinationResolver.swift`
- Create: `ios/MaxHelmet/Actions/DestinationCard.swift`
- Create: `ios/MaxHelmetTests/DestinationResolverTests.swift`

**Interfaces:**
- Consumes: `DeviceActionHandler`, `DeviceAction`, `DeviceActionResult`.
- Produces: `Destination` (Equatable: `name`, `coordinate`, `distanceMeters`, `etaSeconds`); `protocol RouteSearching { func search(_ query: String) async -> Destination? }`; `DestinationResolver(search:onResolved:)`; `destinationSummary(_ destination: Destination) -> String`; `DestinationCard` SwiftUI view.

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/DestinationResolverTests.swift`:

```swift
import CoreLocation
import XCTest
@testable import MaxHelmet

private final class FakeSearch: RouteSearching, @unchecked Sendable {
    var destination: Destination?
    func search(_ query: String) async -> Destination? { destination }
}

final class DestinationResolverTests: XCTestCase {

    private let tiananmen = Destination(
        name: "天安门",
        coordinate: CLLocationCoordinate2D(latitude: 39.9087, longitude: 116.3975),
        distanceMeters: 12_400,
        etaSeconds: 1_500
    )

    func testPublishesAResolvedDestination() async {
        let search = FakeSearch()
        search.destination = tiananmen
        var published: Destination?
        let handler = DestinationResolver(search: search, onResolved: { published = $0 })

        let result = await handler.perform(.destinationShow(query: "天安门"))

        XCTAssertEqual(result, .ok)
        XCTAssertEqual(published, tiananmen)
    }

    func testReportsAnUnresolvableDestination() async {
        let search = FakeSearch()
        search.destination = nil
        let handler = DestinationResolver(search: search, onResolved: { _ in })

        let result = await handler.perform(.destinationShow(query: "火星"))

        XCTAssertEqual(result.status, .unsupported)
        XCTAssertEqual(result.reason, "route.unavailable")
    }

    func testSummaryStatesDistanceAndTimeWithoutPromisingGuidance() {
        let summary = destinationSummary(tiananmen)

        XCTAssertTrue(summary.contains("天安门"))
        XCTAssertTrue(summary.contains("12.4"))
        XCTAssertTrue(summary.contains("25"))
        XCTAssertFalse(summary.contains("导航中"), "The card must not imply turn-by-turn guidance")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `cannot find 'DestinationResolver' in scope`.

- [ ] **Step 3: Write the resolver**

Create `ios/MaxHelmet/Actions/DestinationResolver.swift`:

```swift
import CoreLocation
import Foundation
import MapKit

struct Destination: Equatable {
    let name: String
    let coordinate: CLLocationCoordinate2D
    let distanceMeters: Double
    let etaSeconds: Double

    static func == (lhs: Destination, rhs: Destination) -> Bool {
        lhs.name == rhs.name
            && lhs.coordinate.latitude == rhs.coordinate.latitude
            && lhs.coordinate.longitude == rhs.coordinate.longitude
            && lhs.distanceMeters == rhs.distanceMeters
            && lhs.etaSeconds == rhs.etaSeconds
    }
}

protocol RouteSearching {
    func search(_ query: String) async -> Destination?
}

/// MKLocalSearch for the place, MKDirections for distance and ETA. MapKit has
/// no motorcycle profile — only automobile, walking, and transit — so these
/// figures follow car routing and will not respect 摩托车禁行 roads.
/// Cross-border requests from a China-region device return no route.
struct MapKitRouteSearch: RouteSearching {
    func search(_ query: String) async -> Destination? {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        guard let item = try? await MKLocalSearch(request: request).start().mapItems.first else { return nil }

        let directions = MKDirections.Request()
        directions.destination = item
        directions.transportType = .automobile
        guard let route = try? await MKDirections(request: directions).calculate().routes.first else { return nil }

        return Destination(
            name: item.name ?? query,
            coordinate: item.placemark.coordinate,
            distanceMeters: route.distance,
            etaSeconds: route.expectedTravelTime
        )
    }
}

/// The spoken line. States distance and time only — it must never imply that
/// guidance has started, because this card issues none.
func destinationSummary(_ destination: Destination) -> String {
    let km = String(format: "%.1f", destination.distanceMeters / 1000)
    let minutes = Int((destination.etaSeconds / 60).rounded())
    return "\(destination.name)，距离 \(km) 公里，开车大约 \(minutes) 分钟。路线卡片已经显示。"
}

struct DestinationResolver: DeviceActionHandler {
    private let search: RouteSearching
    private let onResolved: (Destination) -> Void

    init(search: RouteSearching = MapKitRouteSearch(), onResolved: @escaping (Destination) -> Void) {
        self.search = search
        self.onResolved = onResolved
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard case let .destinationShow(query) = action else { return .unsupported("action.mismatch") }
        guard let destination = await search.search(query) else { return .unsupported("route.unavailable") }
        onResolved(destination)
        return .ok
    }
}
```

- [ ] **Step 4: Write the card view**

Create `ios/MaxHelmet/Actions/DestinationCard.swift`. Uses the "Night Instrument"
tokens from `ios/MaxHelmet/UI/HudTheme.swift` so it reads as part of the HUD, not
a bolted-on map:

```swift
import MapKit
import SwiftUI

/// A glanceable destination readout. Deliberately not a navigation view: no
/// heading, no maneuver list, no rerouting. It answers "where is it and how far"
/// and nothing more.
struct DestinationCard: View {
    let destination: Destination

    private var distanceText: String {
        String(format: "%.1f 公里", destination.distanceMeters / 1000)
    }

    private var etaText: String {
        "\(Int((destination.etaSeconds / 60).rounded())) 分钟"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Map(initialPosition: .region(MKCoordinateRegion(
                center: destination.coordinate,
                latitudinalMeters: 1_200,
                longitudinalMeters: 1_200
            ))) {
                Marker(destination.name, coordinate: destination.coordinate)
                    .tint(HudColors.ember)
            }
            .frame(height: 150)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .allowsHitTesting(false)

            Text(destination.name)
                .font(.headline)
                .foregroundStyle(HudColors.hudInk)

            HStack(spacing: 14) {
                Label(distanceText, systemImage: "arrow.triangle.turn.up.right.diamond")
                Label(etaText, systemImage: "clock")
            }
            .font(.subheadline)
            .foregroundStyle(HudColors.hudDim)
        }
        .padding(14)
        .background(HudColors.panelElevated, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(HudColors.border, lineWidth: 1)
        )
        .frame(maxWidth: 420)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("目的地 \(destination.name)，距离 \(distanceText)，约 \(etaText)")
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ios/MaxHelmet/Actions/DestinationResolver.swift ios/MaxHelmet/Actions/DestinationCard.swift \
  ios/MaxHelmetTests/DestinationResolverTests.swift
git commit -m "feat(ios): add destination resolution and route card"
```

---

### Task 12: Wire the router into the session

**Files:**
- Modify: `ios/MaxHelmet/Agent/AgentSession.swift:692-772` (`handleEvent`)
- Modify: `ios/MaxHelmet/UI/MainViewModel.swift`
- Modify: `ios/MaxHelmet/UI/AgentScreen.swift`
- Modify: `ios/MaxHelmet/Info.plist`, `ios/MaxHelmet/Info-Debug.plist`
- Modify: `ios/README.md`, `README.md`
- Create: `ios/MaxHelmetTests/DeviceCommandSessionTests.swift`

**Interfaces:**
- Consumes: everything from Tasks 6–11.
- Produces: `AgentSession` forwarding `device.command` to the router and sending `buildDeviceResult`; `MainViewModel.destination: Destination?` driving the card.

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/DeviceCommandSessionTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

final class DeviceCommandSessionTests: XCTestCase {

    func testEveryCommandProducesExactlyOneResult() async {
        var sent: [String] = []
        let router = DeviceActionRouter(handlers: [:], isDeviceUnlocked: { true })
        let command = DeviceCommand(commandId: "c1", action: .torchSet(on: true), tier: .low)

        let result = await router.handle(command)
        sent.append(buildDeviceResult(commandId: command.commandId, result: result))

        XCTAssertEqual(sent.count, 1)
        XCTAssertTrue(sent[0].contains("\"commandId\":\"c1\""))
        XCTAssertTrue(sent[0].contains("\"status\":\"unsupported\""))
    }

    func testResultRoundTripsThroughTheRelayContract() throws {
        let json = buildDeviceResult(commandId: "c2", result: .ok)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(parsed["type"] as? String, ClientEventTypes.deviceResult)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — the test target does not yet compile against the wired session.

- [ ] **Step 3: Build the router in the session**

`RideContext.speedKmh` is a non-optional `Int` that defaults to `0`. Reading it
directly would report "stopped" for a session that has never received a
`ride.context` event, and the SMS speed gate would wave the message through at
speed. Track whether real context has arrived:

```swift
    /// False until the first ride.context event. Without this, the default
    /// speedKmh of 0 reads as "stopped" and defeats the SMS speed gate.
    private var hasRideContext = false
```

Set it in the existing `case let .rideContextUpdate(rideContext):` arm of
`handleEvent`, alongside the assignment already there:

```swift
            hasRideContext = true
```

Construct the router once during session setup, passing the real handlers:

```swift
    private lazy var deviceRouter = DeviceActionRouter(
        handlers: [
            .torch: TorchController(),
            .volume: PlaybackVolumeController(gain: player),
            .music: MusicController(),
            .sms: MessageComposer(
                presenter: SystemMessagePresenter(),
                speedProvider: { [weak self] in
                    guard let self, self.hasRideContext else { return nil }
                    return Double(self.rideContext.speedKmh)
                },
                resolver: SystemContactResolver()
            ),
            .call: CallDialer(),
            .destination: DestinationResolver(onResolved: { [weak self] destination in
                Task { @MainActor in self?.destination = destination }
            })
        ],
        isDeviceUnlocked: { UIApplication.shared.isProtectedDataAvailable }
    )
```

- [ ] **Step 4: Forward the event**

Add to the `handleEvent` switch, before `case .error`:

```swift
        case let .deviceCommand(command):
            Task { [weak self] in
                guard let self else { return }
                let result = await self.deviceRouter.handle(command)
                self.send(buildDeviceResult(commandId: command.commandId, result: result))
            }
```

This is the only device-action code permitted in `AgentSession.swift`.

- [ ] **Step 5: Surface the destination card**

Add to `ios/MaxHelmet/UI/MainViewModel.swift`:

```swift
    /// Latest resolved destination, or nil when there is nothing to show.
    /// Cleared on session start so a stale route never outlives its ride.
    @Published var destination: Destination?
```

Clear it wherever the view model resets for a new session, beside the existing
transcript reset:

```swift
        destination = nil
```

In `ios/MaxHelmet/UI/AgentScreen.swift`, render the card where the ADAS hazard
banner is pinned, so both overlays share one stacking context:

```swift
            if let destination = model.destination {
                DestinationCard(destination: destination)
                    .padding(.horizontal, 16)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
```

- [ ] **Step 6: Add the permission strings**

Add to both `ios/MaxHelmet/Info.plist` and `ios/MaxHelmet/Info-Debug.plist`:

```xml
	<key>NSContactsUsageDescription</key>
	<string>Max 需要读取通讯录，才能在你说出名字时拨打电话或发送短信。</string>
	<key>NSAppleMusicUsageDescription</key>
	<string>Max 需要访问音乐库，才能在骑行时控制播放。</string>
```

- [ ] **Step 7: Run the whole iOS suite**

Run the iOS test command.
Expected: PASS — all suites from Tasks 6–12.

- [ ] **Step 8: Update the documentation**

In `ios/README.md` under "What's implemented", add a bullet describing voice-triggered device actions and their limits: dialing and SMS require a native confirmation tap, music reaches only Apple Music and the local library, and the destination card issues no turn-by-turn guidance. In the root `README.md`, add a matching entry to "Current Capabilities".

- [ ] **Step 9: Run the full server gate**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add ios/MaxHelmet/Agent/AgentSession.swift ios/MaxHelmet/UI/MainViewModel.swift \
  ios/MaxHelmet/UI/AgentScreen.swift ios/MaxHelmet/Info.plist ios/MaxHelmet/Info-Debug.plist \
  ios/MaxHelmetTests/DeviceCommandSessionTests.swift ios/README.md README.md
git commit -m "feat(ios): wire device actions into the agent session"
```

---

## Manual verification

Run after Task 12, on a physical iPhone. The simulator has no torch, no cellular, and no Contacts data.

- [ ] Against the mock provider, speak each of the six commands and confirm the action happens and Max's spoken line matches.
- [ ] Repeat against live Doubao.
- [ ] Deny Contacts permission, say "Max 打给老王", confirm Max says the permission is missing and does not claim to be calling.
- [ ] Say "Max 给老王发条短信说我晚点到" while moving above 5 km/h; confirm refusal, then repeat stopped and confirm the sheet appears.
- [ ] Say "Max 用网易云放歌"; confirm Max refuses honestly and Apple Music does not start.
- [ ] Lock the screen, speak a command, confirm Max says the phone must be unlocked.
- [ ] Ask for a destination outside mainland China; confirm Max says it cannot find a route rather than guessing.
- [ ] Confirm an Android client receiving a `device.command` logs and ignores it without erroring.
- [ ] Check the admin QA transcript for a dial turn and confirm the contact name reads `[联系人]`.
