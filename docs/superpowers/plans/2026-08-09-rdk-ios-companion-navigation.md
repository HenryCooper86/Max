# RDK Navigation with an iOS Location Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pair the logged-in Max iOS app to one stable RDK X5 helmet, forward a consented background Core Location stream through Lightsail, and let the RDK own Amap turn-by-turn guidance, a turn-first bench HUD, and helmet speech without persisting raw phone coordinates.

**Architecture:** The iPhone opens a small authenticated /companion WebSocket and sends throttled WGS-84 fixes only during an explicit Helmet Ride. A relay-side CompanionRegistry owns durable one-to-one account/device bindings and forwards accepted fixes in memory to the paired authenticated /agent session. The RDK converts each accepted fix once to GCJ-02, owns route and guidance state with shared/guidance.ts, renders the Option A HUD card, and sends bounded structured nav.prompt events; the relay validates those prompts against the route already owned by createNavHandler and uses the existing 24 kHz embedded speaker path.

**Tech Stack:** TypeScript/Node 22, Express 5, ws, Vitest, Swift 5, SwiftUI, CoreLocation, URLSessionWebSocketTask, XCTest, RDK X5 Linux/systemd/ALSA. No new runtime dependencies.

**Spec:** docs/superpowers/specs/2026-08-09-rdk-ios-companion-navigation-design.md is binding. Its non-goals remain binding: no browser companion, no map in the RDK HUD, no second voice/microphone session on iOS, no raw-location persistence, no route persistence across an RDK process restart, and no Always Location request solely for relaunch.

## Global Constraints

- Protocol coordinates and times are unambiguous: companion.location and phone.location carry WGS-84 and epoch milliseconds; nav.request and nav.route remain GCJ-02.
- The relay never logs, stores, transcribes, metrics-records, or places raw companion latitude, longitude, course, or speed in user memory. Pairing storage contains only accountId, deviceId, createdAt, and updatedAt.
- A six-digit pair code is random, single-use, valid for five minutes, never logged, and cannot replace a binding until an authenticated account successfully consumes it.
- /companion accepts only an account session token. The shared relay operator token can authenticate /agent but cannot own an account/device binding.
- A phone fix is usable only when latitude/longitude are finite and in range, horizontal accuracy is 0–50 m, the timestamp is no more than 10 seconds old and no more than 2 seconds in the future, and sequence increases within the current companion connection.
- iOS emits at most one newest fix per second and never uploads a disconnected backlog.
- The RDK first-fix wait is three seconds. Route-answer wait is seven seconds. navigation.start therefore needs a 12-second relay device-result deadline, while unrelated actions keep the existing eight-second deadline.
- Every navigation device.command receives exactly one device.result. A newer start or stop cancels the older start with failed/navigation.cancelled. A missing first fix returns failed/location.unavailable. A route error returns its existing route code.
- shared/guidance.ts is called directly on RDK; do not port or fork it.
- Navigation prompts contain identifiers and bounded numeric fields, never arbitrary speech text. The relay owns all spoken templates.
- RDK ordinary relay audio writes at rank 0. ADAS caution and critical clips write at ranks 1 and 2. While a hold is active, lower-ranked audio is discarded before playback queueing and before the AEC reference tap.
- A prompt suppressed by ADAS is recorded as fired in guidance progress and is never replayed.
- New server protocol and /companion support deploy before either new client. Existing web, Android, and iOS voice/navigation clients must remain compatible.
- Test commands:
  - Root TypeScript gate: npm run check
  - Scoped Vitest example: npx vitest run tests/companion-registry.test.ts
  - iOS: run from ios/ with DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17'
  - RDK compile: npx tsc -p rdk/agent/tsconfig.json

---

### Task 1: Define the /agent and /companion wire contracts

**Files:**

- Modify: protocol/agent-events.schema.json
- Modify: shared/agent.ts
- Create: shared/companion.ts
- Regenerate: shared/generated/agent-protocol.ts
- Regenerate: ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift
- Regenerate: android/app/src/main/java/io/github/henrycooper86/max/agent/GeneratedAgentProtocol.kt
- Modify: server/session-controller.ts
- Test: tests/agent.test.ts
- Test: tests/nav-protocol.test.ts
- Create test: tests/companion-protocol.test.ts
- Modify test: ios/MaxHelmetTests/AgentProtocolTests.swift
- Modify test: android/app/src/test/java/io/github/henrycooper86/max/agent/GeneratedAgentProtocolTest.kt

**Interfaces:**

- Consumes: the existing schema generator in scripts/generate-agent-protocol.ts and parseClientEvent in server/session-controller.ts.
- Produces:

```ts
export type SessionStartEvent = {
  type: "session.start";
  sampleRate: number;
  channels: number;
  deviceId?: string;
  testerId?: string;
  testerRegion?: string;
  testingCampaignId?: string;
  testingTestCaseId?: string;
  testingRunId?: string;
  testingAssignmentId?: string;
  appVersion?: string;
  gitCommit?: string;
  deviceLabel?: string;
  browserLanguage?: string;
  networkType?: string;
  platform?: TestingPlatform;
  voiceGender?: VoiceGender;
  voicePersonality?: VoicePersonality;
  rideMode?: RideMode;
  scenario?: DemoScenario;
  lat?: number;
  lon?: number;
  memory?: SessionMemorySnapshot;
};

export type NavPromptEvent =
  | {
      type: "nav.prompt";
      promptId: string;
      routeCommandId: string;
      kind: "maneuver";
      maneuverIndex: number;
      threshold: "far" | "near" | "now";
      distanceMeters: number;
    }
  | {
      type: "nav.prompt";
      promptId: string;
      routeCommandId: string;
      kind: "offRoute" | "rerouteFailed" | "arrived" | "locationLost";
    };

export type CompanionPairingEvent = {
  type: "companion.pairing";
  code: string;
  expiresAt: number;
  paired: boolean;
};

export type PhoneLocationEvent = {
  type: "phone.location";
  sequence: number;
  lat: number;
  lon: number;
  horizontalAccuracyMeters: number;
  timestamp: number;
  courseDegrees?: number;
  speedMps?: number;
};

export type PhoneLocationStatusEvent = {
  type: "phone.location.status";
  state: "connected" | "sharing" | "stopped" | "stale" | "unpaired";
};
```

```ts
// shared/companion.ts
export type CompanionClientEvent =
  | { type: "companion.pair"; code: string }
  | { type: "companion.start" }
  | { type: "companion.stop" }
  | { type: "companion.unpair" }
  | {
      type: "companion.location";
      sequence: number;
      lat: number;
      lon: number;
      horizontalAccuracyMeters: number;
      timestamp: number;
      courseDegrees?: number;
      speedMps?: number;
    };

export type CompanionServerEvent =
  | {
      type: "companion.status";
      state: "unpaired" | "paired" | "helmetOffline" | "ready" | "sharing";
      deviceId?: string;
      deviceLabel?: string;
      detail?: string;
    }
  | { type: "companion.error"; code: string; detail: string };

export function parseCompanionClientEvent(input: Buffer | string): CompanionClientEvent;
```

- [ ] **Step 1: Write failing protocol tests.** Pin deviceId as optional on session.start; every new /agent discriminant; every companion event; rejection of binary/unknown types, strings over 120 bytes, invalid coordinates, negative accuracy/speed, invalid course, and non-integer/non-positive sequence.

```ts
it("cannot carry arbitrary navigation speech", () => {
  expect(() =>
    parseClientEvent(
      Buffer.from(
        JSON.stringify({
          type: "nav.prompt",
          promptId: "p-1",
          routeCommandId: "nav-1",
          kind: "arrived",
          text: "say anything"
        })
      )
    )
  ).toThrow("Invalid nav.prompt fields");
});

it("parses a bounded companion fix", () => {
  expect(
    parseCompanionClientEvent(
      JSON.stringify({
        type: "companion.location",
        sequence: 7,
        lat: 31.2304,
        lon: 121.4737,
        horizontalAccuracyMeters: 8,
        timestamp: 1_786_200_000_000,
        courseDegrees: 90,
        speedMps: 12
      })
    )
  ).toMatchObject({ type: "companion.location", sequence: 7 });
});
```

- [ ] **Step 2: Run RED.** npx vitest run tests/agent.test.ts tests/nav-protocol.test.ts tests/companion-protocol.test.ts. The new types/parser are absent.
- [ ] **Step 3: Implement the exact unions and parser.** Add schema entries, add NavPromptEvent to ClientEvent, add companion pairing/location/status to AgentEvent, validate deviceId as rdk- plus a canonical lowercase UUID, and keep /companion types outside the generated /agent table.

```ts
const RDK_DEVICE_ID = /^rdk-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
if (value.deviceId !== undefined && (typeof value.deviceId !== "string" || !RDK_DEVICE_ID.test(value.deviceId))) {
  throw new Error("Invalid deviceId");
}
```

- [ ] **Step 4: Regenerate and run GREEN.** Run npm run generate:protocol; npx vitest run tests/agent.test.ts tests/nav-protocol.test.ts tests/companion-protocol.test.ts; from ios/ run DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:MaxHelmetTests/AgentProtocolTests; from android/ run JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew testDebugUnitTest --tests 'io.github.henrycooper86.max.agent.GeneratedAgentProtocolTest'; then run npm run check:protocol from the root.
- [ ] **Step 5: Commit.** git commit -m "feat(protocol): define RDK companion and navigation prompt events"

---

### Task 2: Persist one-to-one account/device bindings fail-closed

**Files:**

- Create: server/companion-store.ts
- Create test: tests/companion-store.test.ts

**Interfaces:**

- Consumes: ensureTestingStorageDirectory from server/testing-storage.ts and an optional explicit file path for deterministic tests.
- Produces:

```ts
export type CompanionBinding = {
  accountId: string;
  deviceId: string;
  createdAt: number;
  updatedAt: number;
};

export type CompanionBindingStore = {
  ready(): boolean;
  bindingForAccount(accountId: string): CompanionBinding | undefined;
  bindingForDevice(deviceId: string): CompanionBinding | undefined;
  bind(
    accountId: string,
    deviceId: string,
    now?: number
  ): Promise<{
    binding: CompanionBinding;
    displaced: CompanionBinding[];
  }>;
  unbindAccount(accountId: string): Promise<CompanionBinding | undefined>;
  readinessIssue(): string | undefined;
  flush(): Promise<void>;
};

export function createCompanionBindingStore(options?: {
  filePath?: string | null;
  now?: () => number;
}): CompanionBindingStore;
```

- [ ] **Step 1: Write failing storage tests.** Cover empty-file bootstrap, 0600 file/0700 directory, atomic .write then rename, reload, one-to-one replacement on both axes, malformed JSON, malformed records, duplicate account/device records, read error, and write error. Test mode uses an explicit temporary file; filePath null is in-memory but still validates.

```ts
const first = await store.bind("acct-a", "rdk-a", 100);
const second = await store.bind("acct-b", "rdk-a", 200);
expect(second.displaced).toEqual([first.binding]);
expect(store.bindingForAccount("acct-a")).toBeUndefined();
expect(store.bindingForDevice("rdk-a")?.accountId).toBe("acct-b");
```

- [ ] **Step 2: Run RED.** npx vitest run tests/companion-store.test.ts.
- [ ] **Step 3: Implement the store.** Default COMPANION_BINDINGS_FILE to ~/.max-relay/companion-bindings.json, mirror accounts.ts serialized snapshot/write/rename behavior, and never silently replace corrupt content with an empty trusted store. bind/unbind stage a candidate snapshot and update the live maps only after the atomic rename succeeds; a failed write leaves the prior binding authoritative and sets readinessIssue.

```ts
const snapshot = JSON.stringify({ version: 1, bindings: [...byAccount.values()] }, null, 2);
persistQueue = persistQueue.then(async () => {
  await ensureTestingStorageDirectory(filePath);
  await fs.promises.writeFile(tempPath, snapshot + "\n", { mode: 0o600 });
  await fs.promises.rename(tempPath, filePath);
});
```

- [ ] **Step 4: Run GREEN.** npx vitest run tests/companion-store.test.ts tests/accounts.test.ts tests/build-info.test.ts, then npm run build.
- [ ] **Step 5: Commit.** git commit -m "feat(companion): persist account helmet bindings fail closed"

---

### Task 3: Build the transport-independent CompanionRegistry

**Files:**

- Create: server/companion-registry.ts
- Create test: tests/companion-registry.test.ts

**Interfaces:**

- Consumes: CompanionBindingStore plus the /agent and /companion event types from Task 1.
- Produces:

```ts
export type CompanionPeer = {
  accountId: string;
  address: string;
  send(event: CompanionServerEvent): void;
};

export type HelmetPeer = {
  deviceId: string;
  deviceLabel: string;
  send(event: CompanionPairingEvent | PhoneLocationEvent | PhoneLocationStatusEvent): void;
};

export type CompanionConnection = {
  handle(event: CompanionClientEvent): Promise<void>;
  detach(): void;
};

export type CompanionRegistry = {
  attachHelmet(peer: HelmetPeer): () => void;
  attachCompanion(peer: CompanionPeer): CompanionConnection;
  close(): Promise<void>;
};

export function createCompanionRegistry(options: {
  store: CompanionBindingStore;
  now?: () => number;
  randomCode?: () => string;
  pairLifetimeMs?: number;
  minFixIntervalMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  log?: Pick<Logger, "info" | "warn">;
}): CompanionRegistry;
```

- [ ] **Step 1: Write failing lifecycle tests.** Pin six-digit format, five-minute expiry, single use, wrong/reused codes, per-account and per-address attempt limits, reconnect in either order, one-to-one displacement, unpair, companion stop, helmet/phone disconnect, offline helmet status, live reattachment, monotonic sequence, receive rate, timestamp/accuracy/range gates, a stale status ten seconds after the last accepted fix, and forwarding only to the bound helmet.

```ts
const companion = registry.attachCompanion({
  accountId: "acct-a",
  address: "203.0.113.10",
  send: (event) => phoneEvents.push(event)
});
await companion.handle({ type: "companion.start" });
await companion.handle({
  type: "companion.location",
  sequence: 1,
  lat: 31.2304,
  lon: 121.4737,
  horizontalAccuracyMeters: 7,
  timestamp: now
});
expect(helmetEvents.at(-1)).toMatchObject({ type: "phone.location", sequence: 1 });
expect(JSON.stringify(storeSnapshot)).not.toContain("31.2304");
expect(logLines.join(" ")).not.toContain("121.4737");
```

- [ ] **Step 2: Run RED.** npx vitest run tests/companion-registry.test.ts.
- [ ] **Step 3: Implement the registry.** Keep pairing codes, peer sockets, sequence/rate state, stale timer, and sharing state only in memory. Generate a new code on each helmet attach. On companion reconnect, send current binding status and no fix history. Drop fixes while the helmet is offline; after the helmet reconnects and the registry sends ready/sharing, the iOS client sends only its current newest fix. Schedule stale at fix.timestamp + 10 seconds, not ten seconds after receipt. Cancel the stale timer on stop, unpair, detach, and registry close. Consume a pair code only after store.bind succeeds; on persistence failure leave both the code and prior binding intact. Notify the displaced companion and displaced helmet with unpaired state.

```ts
if (event.sequence <= session.lastSequence) return reject("location.sequence");
if (now - session.lastAcceptedAt < minFixIntervalMs) return reject("location.rate");
if (event.timestamp < now - 10_000 || event.timestamp > now + 2_000) return reject("location.timestamp");
session.lastSequence = event.sequence;
session.lastAcceptedAt = now;
helmet.send({
  type: "phone.location",
  sequence: event.sequence,
  lat: event.lat,
  lon: event.lon,
  horizontalAccuracyMeters: event.horizontalAccuracyMeters,
  timestamp: event.timestamp,
  courseDegrees: event.courseDegrees,
  speedMps: event.speedMps
});
```

- [ ] **Step 4: Run GREEN.** npx vitest run tests/companion-registry.test.ts tests/companion-store.test.ts.
- [ ] **Step 5: Commit.** git commit -m "feat(companion): pair accounts to live RDK sessions"

---

### Task 4: Add the authenticated /companion WebSocket

**Files:**

- Modify: server/auth.ts
- Create: server/companion-socket.ts
- Modify: server/index.ts
- Modify: server/metrics.ts (aggregate companion accepted/rejected counters only)
- Create test: tests/companion-websocket.test.ts
- Modify test: tests/websocket.test.ts
- Modify test: tests/server-integration.test.ts

**Interfaces:**

- Consumes: CompanionRegistry, existing account sessions, origin policy, and upgrade rate limiting.
- Produces:

```ts
// server/auth.ts
export function authorizeAccountUpgrade(
  request: IncomingMessage,
  now?: number
): { ok: true; token: string; user: PublicUser } | { ok: false; code: number; reason: string };

// server/companion-socket.ts
export function createCompanionSocketServer(options: {
  registry: CompanionRegistry;
  maxPayloadBytes?: number;
  log: Logger;
}): {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): Promise<void>;
  clients(): Iterable<WebSocket>;
};
```

- [ ] **Step 1: Write failing WebSocket tests.** A valid account token upgrades /companion; missing/expired token and relay-token-only requests return 401; origin allowlist and rate limit still apply; binary, malformed JSON, and payloads over 8 KiB produce bounded companion.error/1008 without affecting an /agent socket; logout/password revocation closes the matching companion socket.
- [ ] **Step 2: Run RED.** npx vitest run tests/companion-websocket.test.ts tests/websocket.test.ts.
- [ ] **Step 3: Implement the endpoint.** Route upgrades by pathname, keep separate noServer WebSocketServer instances, resolve the account before handleUpgrade, pass only parsed companion events into the registry, and register companion sockets in authenticatedConnections so existing revocation sweeps close them. Instantiate the store/registry before /ready and append store.readinessIssue to the endpoint's issues. Graceful shutdown closes companion sockets, registry timers, and the store queue before process exit.

```ts
if (url.pathname === "/companion") {
  companionSockets.handleUpgrade(request, socket, head);
  return;
}
if (url.pathname !== "/agent") {
  socket.destroy();
  return;
}
```

- [ ] **Step 4: Run GREEN.** npx vitest run tests/companion-websocket.test.ts tests/websocket.test.ts tests/server-integration.test.ts, then npm run build.
- [ ] **Step 5: Commit.** git commit -m "feat(companion): serve an account authenticated location socket"

---

### Task 5: Register stable RDK identities with the companion registry

**Files:**

- Modify: server/session-controller.ts
- Modify: server/index.ts
- Modify test: tests/session.test.ts
- Modify test: tests/server-integration.test.ts
- Modify test: tests/companion-registry.test.ts

**Interfaces:**

- Consumes: a per-upgrade authorization decision and CompanionRegistry.attachHelmet.
- Produces:

```ts
export type AgentSessionHooks = {
  onDeviceRegistered?(peer: HelmetPeer): () => void;
  deviceRegistrationAuthorized: boolean;
};

// AgentSessionController constructor gains its final optional argument:
hooks?: AgentSessionHooks
```

- [ ] **Step 1: Write failing tests.** session.start with deviceId calls onDeviceRegistered once after validation, forwards registry events through the session send function, uses deviceLabel or RDK X5, detaches on socket close, and never registers browser/mobile sessions without deviceId. A duplicate session.start remains rejected. A logged-in account /agent socket cannot claim an RDK device ID; device registration requires the configured relay operator token, with the existing completely-open no-token/no-account development mode as the only fallback.
- [ ] **Step 2: Run RED.** npx vitest run tests/session.test.ts tests/server-integration.test.ts.
- [ ] **Step 3: Implement the hook.** Attach after provider.start succeeds; store the returned detach closure; call it exactly once on controller close. Reject a deviceId with close code 1008 when deviceRegistrationAuthorized is false. In index.ts, authorize registration with relayTokenPresented(request), or only when both RELAY_AUTH_TOKEN and user accounts are absent for the documented open-development mode. Inject registry.attachHelmet from index.ts rather than importing a registry singleton into SessionController. Add a private sendEphemeral method for companion pairing/location events: it writes JSON to the socket and may increment aggregate byte counters, but it must not call recordTesterServerEvent or recordUserMemoryEvent. The ordinary send method remains unchanged for voice/session evidence.

```ts
if (event.deviceId) {
  this.detachHelmet?.();
  this.detachHelmet = this.hooks.onDeviceRegistered?.({
    deviceId: event.deviceId,
    deviceLabel: event.deviceLabel?.trim() || "RDK X5",
    send: (payload) => this.sendEphemeral(payload)
  });
}
```

- [ ] **Step 4: Add privacy regression assertions.** Forward a phone.location through the hook and prove the WebSocket receives it while tester events and user-memory recorders receive nothing; do the same for companion.pairing so the short code never enters QA evidence.
- [ ] **Step 5: Run GREEN.** npx vitest run tests/session.test.ts tests/server-integration.test.ts tests/companion-registry.test.ts, then npm run build.
- [ ] **Step 6: Commit.** git commit -m "feat(companion): attach stable RDK agent sessions"

---

### Task 6: Validate structured prompts and speak them on the embedded channel

**Files:**

- Create: server/navigation-prompts.ts
- Modify: server/routing.ts
- Modify: server/providers/types.ts
- Modify: server/providers/doubao.ts
- Modify: server/providers/mock.ts
- Modify: server/session-controller.ts
- Modify: server/device-actions.ts
- Modify: server/speech.ts
- Modify test: tests/nav-handler.test.ts
- Create test: tests/navigation-prompts.test.ts
- Modify test: tests/doubao-nav-speech.test.ts
- Modify test: tests/speech.test.ts
- Modify test: tests/device-actions.test.ts

**Interfaces:**

- Consumes: createNavHandler's per-session route, the existing provider transcript/speaker paths, and NavPromptEvent.
- Produces:

```ts
// server/routing.ts keeps its callable API and exposes the same owned route.
export type NavHandler = ((event: NavRequestEvent) => Promise<void>) & {
  activeRoute(): NavRouteEvent | undefined;
};

export type NavPromptSpeech = {
  text: string;
  interrupt: boolean;
  expiresAt?: number;
};

// server/providers/types.ts
speakNavPrompt?(speech: NavPromptSpeech): void;

// server/navigation-prompts.ts
export function createNavPromptHandler(options: {
  activeRoute: () => NavRouteEvent | undefined;
  speak: (speech: NavPromptSpeech) => void;
  now?: () => number;
  maxPerMinute?: number;
}): (event: NavPromptEvent) => void;
```

- [ ] **Step 1: Write failing prompt tests.** Cover route-command identity, maneuver bounds, distance 0–20,000, threshold enum, 120-byte IDs, promptId dedupe, per-minute limit, fixed lifecycle templates, exact maneuver templates, and the impossibility of arbitrary text. Verify now is interrupting; far/near expire three seconds after receipt; lifecycle prompts serialize; stale or invalid prompts synthesize nothing. A cache-window reroute must replace activeRoute.commandId with the command ID actually sent in its nav.route copy, so the RDK's next prompt validates against the route it received.

```ts
handle({
  type: "nav.prompt",
  promptId: "p-1",
  routeCommandId: "nav-7",
  kind: "maneuver",
  maneuverIndex: 0,
  threshold: "near",
  distanceMeters: 132
});
expect(spoken).toEqual([
  {
    text: "前方150米，右转进入南京东路",
    interrupt: false,
    expiresAt: now + 3_000
  }
]);
```

- [ ] **Step 2: Add timing tests for navigation device results.** Extend IssuedDeviceCommand with expiresAt. Assert ordinary commands expire at eight seconds, navigation.start at twelve seconds, and nextExpiryAt returns the next live deadline so the Doubao timer reschedules rather than losing a longer navigation command.

```ts
expect(pending.issue("camera.photo", undefined, 100).expiresAt).toBe(8_100);
expect(pending.issue("navigation.start", undefined, 100).expiresAt).toBe(12_100);
```

- [ ] **Step 3: Run RED.** npx vitest run tests/navigation-prompts.test.ts tests/nav-handler.test.ts tests/doubao-nav-speech.test.ts tests/device-actions.test.ts.
- [ ] **Step 4: Implement prompt composition and speech.** Return activeRoute from createNavHandler without maintaining a second route copy. In the cached-reroute branch, assign the copied nav.route with its new commandId back to lastRoute before sending it. SessionController passes nav.prompt to one per-session handler. Doubao speakNavPrompt allocates a fresh transcript delivery, truncates the current reply for interrupting prompts, serializes non-interrupting generated speech behind the current ordinary speech span, checks expiresAt before synthesis starts, and sends embedded PCM through speakEmbedded. Mock sends the one transcript line. Reroute-success now calls speakEmbedded for platform embedded as well as emitting its transcript.

```ts
const NAV_FIXED_TEXT = {
  offRoute: "已偏离路线，正在重新规划。",
  rerouteFailed: "无法重新规划路线，已停止导航。",
  arrived: "已到达目的地。",
  locationLost: "手机定位已断开，导航已暂停。"
} as const;
```

- [ ] **Step 5: Add location.unavailable.** Map it to 手机定位未连接，请打开 Max 并开始头盔骑行。 in FAILURE_SPEECH.
- [ ] **Step 6: Run GREEN.** npx vitest run tests/navigation-prompts.test.ts tests/nav-handler.test.ts tests/doubao-nav-speech.test.ts tests/speech.test.ts tests/device-actions.test.ts, then npm run check.
- [ ] **Step 7: Commit.** git commit -m "feat(nav-relay): validate and synthesize RDK guidance prompts"

---

### Task 7: Give the RDK a durable stable device ID

**Files:**

- Create: rdk/agent/src/device/identity.ts
- Modify: rdk/agent/src/config.ts
- Modify: rdk/agent/src/relay.ts
- Modify: rdk/systemd/max-agent.service
- Create test: tests/rdk-device-identity.test.ts
- Modify test: tests/rdk-relay-client.test.ts
- Modify: rdk/README.md

**Interfaces:**

- Consumes: RdkConfig and the session.start builder in rdk/agent/src/relay.ts.
- Produces:

```ts
export type DeviceIdentityOptions = {
  path: string;
  readFile?: typeof readFileSync;
  writeFile?: typeof writeFileSync;
  rename?: typeof renameSync;
  chmod?: typeof chmodSync;
  mkdir?: typeof mkdirSync;
  unlink?: typeof unlinkSync;
  randomId?: () => string;
};

export function loadOrCreateDeviceId(options: DeviceIdentityOptions): string;

// RdkConfig gains:
deviceIdFile: string; // MAX_DEVICE_ID_FILE, default /var/lib/max/device-id

// buildSessionStart gains the already-loaded ID:
export function buildSessionStart(
  config: RdkConfig,
  deviceId: string,
  memory?: SessionMemorySnapshot
): SessionStartEvent;
```

- [ ] **Step 1: Write failing tests.** Pin first-run creation of /var/lib/max with 0700 permissions, rdk-UUID creation through a sibling temporary file plus rename, device file chmod 0600, reload stability, malformed/empty file failure, injected directory/write/rename failure, cleanup of the owned temporary file, and session.start containing the ID.
- [ ] **Step 2: Run RED.** npx vitest run tests/rdk-device-identity.test.ts tests/rdk-relay-client.test.ts.
- [ ] **Step 3: Implement and wire.** Load once before createRelayClient and fail the process loudly if the identity cannot be trusted. Keep /var/lib/max as the documented writable state directory.

```ts
const candidate = options.randomId?.() ?? "rdk-" + randomUUID();
writeFileSync(tempPath, candidate + "\n", { mode: 0o600, flag: "wx" });
renameSync(tempPath, options.path);
chmodSync(options.path, 0o600);
```

- [ ] **Step 4: Run GREEN.** npx vitest run tests/rdk-device-identity.test.ts tests/rdk-relay-client.test.ts; npx tsc -p rdk/agent/tsconfig.json; then npm run check.
- [ ] **Step 5: Commit.** git commit -m "feat(rdk): register a durable helmet identity"

---

### Task 8: Implement the RDK PhoneLocationSource

**Files:**

- Create: rdk/agent/src/navigation/phone-location.ts
- Create test: tests/rdk-phone-location.test.ts
- Reuse without modification: shared/geo.ts

**Interfaces:**

- Consumes: PhoneLocationEvent, PhoneLocationStatusEvent, and shared/geo.ts wgs84ToGcj02.
- Produces:

```ts
export type PhoneLocationState = {
  connection: "unpaired" | "connected" | "sharing" | "stopped" | "stale";
  usable: boolean;
  horizontalAccuracyMeters?: number;
  ageMs?: number;
  reason?: "inaccurate" | "stale" | "disconnected" | "stopped" | "unpaired";
};

export type PhoneFix = {
  sequence: number;
  position: { lat: number; lon: number }; // GCJ-02 output boundary
  horizontalAccuracyMeters: number;
  timestamp: number;
  courseDegrees?: number;
  speedMps?: number;
};

export type PhoneLocationSource = {
  acceptStatus(event: PhoneLocationStatusEvent): void;
  acceptLocation(event: PhoneLocationEvent): boolean;
  latest(): PhoneFix | undefined;
  waitForUsableFix(timeoutMs?: number): Promise<PhoneFix | undefined>;
  close(): void;
};

export function createPhoneLocationSource(options: {
  now?: () => number;
  onFix?: (fix: PhoneFix) => void;
  onState?: (state: PhoneLocationState) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): PhoneLocationSource;
```

- [ ] **Step 1: Write failing tests.** Test boundary coordinates, non-finite values, 50 m accepted/over 50 rejected, age exactly 10 seconds accepted/older rejected, future exactly 2 seconds accepted/later rejected, sequence reset only on a new sharing/connected lifecycle, rejected fixes preserving the prior accepted fix, three-second waiter success/timeout/cancel, stale transition, and exactly one WGS-to-GCJ conversion. A well-formed new fix over 50 m accuracy must immediately publish usable false/reason inaccurate without replacing the last accepted coordinate; latest returns undefined until a new accurate fix arrives.

```ts
source.acceptLocation({
  type: "phone.location",
  sequence: 1,
  lat: 31.1774276,
  lon: 121.5272106,
  horizontalAccuracyMeters: 5,
  timestamp: clock.now
});
expect(source.latest()?.position.lat).toBeCloseTo(31.17530398, 4);
expect(source.latest()?.position.lon).toBeCloseTo(121.53146073, 4);
```

- [ ] **Step 2: Run RED.** npx vitest run tests/rdk-phone-location.test.ts.
- [ ] **Step 3: Implement.** Convert only after all WGS validation succeeds, resolve all current waiters from an accepted fix, schedule the stale deadline from source timestamp, and never let a rejected fix replace the latest accepted fix. Treat a syntactically valid but over-50 m update as an immediate inaccurate pause; malformed/range/sequence attacks are dropped without changing the last truthful state.
- [ ] **Step 4: Run GREEN.** Run the scoped test and npx tsc -p rdk/agent/tsconfig.json.
- [ ] **Step 5: Commit.** git commit -m "feat(rdk-nav): consume fresh phone location fixes"

---

### Task 9: Implement the RDK navigation controller

**Files:**

- Create: rdk/agent/src/navigation/controller.ts
- Create test: tests/rdk-navigation-controller.test.ts
- Modify: shared/guidance.ts
- Modify test: tests/guidance.test.ts
- Reuse without modification: shared/geo.ts

**Interfaces:**

- Consumes: PhoneLocationSource, shared/guidance.ts step, nav.route/nav.error, and navigation device commands.
- Produces:

```ts
export type RdkNavigationSnapshot = {
  phase: "idle" | "starting" | "guiding" | "rerouting" | "paused";
  destinationName?: string;
  instruction?: string;
  distanceToManeuverMeters?: number;
  remainingMeters?: number;
  remainingSeconds?: number;
  offRoute?: boolean;
  location?: PhoneLocationState;
};

export type RdkNavigationController = {
  handleCommand(command: DeviceCommand): Promise<DeviceResultEvent>;
  handleRoute(event: NavRouteEvent): void;
  handleError(event: NavErrorEvent): void;
  handleFix(fix: PhoneFix): void;
  handleLocationState(state: PhoneLocationState): void;
  close(): void;
};

export function createRdkNavigationController(options: {
  location: Pick<PhoneLocationSource, "waitForUsableFix" | "latest">;
  sendEvent: (event: NavRequestEvent | NavPromptEvent) => void;
  onState: (state: RdkNavigationSnapshot) => void;
  canPrompt: () => boolean;
  interruptOrdinaryPlayback: () => void;
  now?: () => number;
  randomId?: () => string;
  routeTimeoutMs?: number;
}): RdkNavigationController;

export type PromptThreshold = "far" | "near" | "now";
export type GuidanceUpdate = {
  progress: GuidanceProgress;
  distanceToManeuverMeters: number;
  remainingMeters: number;
  remainingSeconds: number;
  offRoute: boolean;
  arrived: boolean;
  spokenPrompt: string | null;
  currentInstruction: string | null;
  firedThreshold: PromptThreshold | null;
};
```

- [ ] **Step 1: Write the failing shared-engine identity test.** At far, near, and now fixes, GuidanceUpdate.firedThreshold is the exact threshold that produced spokenPrompt; at a now fix that also advances the maneuver, firedThreshold remains now even though returned progress.firedThresholds resets for the next maneuver. No prompt returns null.
- [ ] **Step 2: Write failing command-lifecycle tests.** Cover start with no fix, held start until matching route, route error, seven-second timeout, second start canceling first, stop during first-fix wait, stop during route wait, truly idle stop, stale route/error answers, close teardown, and one result per device command. Exact results: no fix is failed/location.unavailable; destination lookup is failed/destination.notFound; route provider error/timeout is failed/route.unavailable; supersede/stop is failed/navigation.cancelled; successful stop is ok; truly idle stop is failed/navigation.notActive.

```ts
const start = controller.handleCommand({
  commandId: "device-1",
  action: "navigation.start",
  args: { query: "人民广场" }
});
expect(results).toEqual([]);
controller.handleRoute(route("nav-1"));
await expect(start).resolves.toMatchObject({
  type: "device.result",
  commandId: "device-1",
  status: "ok"
});
```

- [ ] **Step 3: Write failing guidance tests.** Drive the same deterministic fixture as tests/guidance.test.ts through controller.handleFix. Assert far/near/now structured prompts, prompt IDs unique, now flushes before send, off-route one-shot plus a single reroute in flight, 20-second cooldown, reroute success reset, reroute failure clear, arrival before clear, and no prompt while canPrompt is false.
- [ ] **Step 4: Write failing pause/resume tests.** Stale/poor/disconnected state freezes route values and prompts, emits one locationLost while prompt transport is available, retains the route, clears the latch on a fresh fix, and permits the ordinary off-route/reroute decision after resume. If ADAS makes canPrompt false, set the location-loss/off-route one-shot latch anyway so neither line replays after the hold releases.
- [ ] **Step 5: Run RED.** npx vitest run tests/guidance.test.ts tests/rdk-navigation-controller.test.ts.
- [ ] **Step 6: Add firedThreshold to the shared engine, then implement the controller with generation and identity guards.** Set the additive field when the engine chooses the urgent due threshold, including prompt-then-advance ticks. Generate nav request IDs independently from device command IDs, hold one continuation keyed by nav command ID, use INITIAL_PROGRESS/step directly, keep the returned progress even when canPrompt is false, send arrival/rerouteFailed prompts before clearing the active route, and never persist route state.

```ts
const update = step(fix.position, activeRoute, progress);
progress = update.progress;
if (update.spokenPrompt && update.firedThreshold && canPrompt()) {
  if (update.firedThreshold === "now") interruptOrdinaryPlayback();
  sendEvent(buildManeuverPrompt(activeRoute.commandId, maneuverIndexBeforeStep, update.firedThreshold, update));
}
```

- [ ] **Step 7: Run GREEN.** npx vitest run tests/guidance.test.ts tests/rdk-navigation-controller.test.ts, then npx tsc -p rdk/agent/tsconfig.json.
- [ ] **Step 8: Commit.** git commit -m "feat(rdk-nav): own route guidance and truthful command results"

---

### Task 10: Route navigation through RDK main and enable capabilities

**Files:**

- Modify: rdk/agent/src/main.ts
- Modify: rdk/agent/src/device/capabilities.ts
- Modify test: tests/rdk-device-dispatch.test.ts
- Modify test: tests/rdk-relay-client.test.ts
- Create test: tests/rdk-navigation-wiring.test.ts

**Interfaces:**

- Consumes: createDeviceDispatcher, PhoneLocationSource, RdkNavigationController, and relay AgentEvent callbacks.
- Produces:

```ts
export function routeDeviceCommand(options: {
  command: DeviceCommand;
  navigation: RdkNavigationController;
  dispatch: ReturnType<typeof createDeviceDispatcher>;
}): Promise<DeviceResultEvent>;

export function routeAgentNavigationEvent(
  event: AgentEvent,
  location: PhoneLocationSource,
  navigation: RdkNavigationController
): boolean;
```

- [ ] **Step 1: Write failing wiring tests.** navigation.start/stop bypass generic dispatch; other commands remain unchanged; nav.route/nav.error go to the controller; phone.location/status go to the source; close cancels controller/location; relay reconnect does not restore a route; session.start includes device ID.
- [ ] **Step 2: Update capability expectations.** navigation.start and navigation.stop become supported true; destination.show remains unsupported/no screen.
- [ ] **Step 3: Run RED.** npx vitest run tests/rdk-navigation-wiring.test.ts tests/rdk-device-dispatch.test.ts tests/rdk-relay-client.test.ts.
- [ ] **Step 4: Implement the narrow routing helpers and wire start().** Create source/controller before the relay handlers, feed source callbacks into navigation/HUD, and on relay close pause location without producing a duplicate device result.

```ts
if (event.type === "device.command") {
  const command = { commandId: event.commandId, action: event.action, args: event.args };
  const result =
    event.action === "navigation.start" || event.action === "navigation.stop"
      ? await navigation.handleCommand(command)
      : await dispatch(command);
  relay.sendEvent(result);
}
```

- [ ] **Step 5: Run GREEN.** npx vitest run tests/rdk-navigation-wiring.test.ts tests/rdk-device-dispatch.test.ts tests/rdk-relay-client.test.ts; npx tsc -p rdk/agent/tsconfig.json; then npm run check.
- [ ] **Step 6: Commit.** git commit -m "feat(rdk-nav): wire phone fixes and navigation commands"

---

### Task 11: Add the Option A turn-first RDK HUD card

**Files:**

- Modify: rdk/agent/src/hud/state.ts
- Modify: rdk/agent/src/hud/index.html
- Modify: rdk/agent/src/main.ts
- Modify test: tests/rdk-hud-state.test.ts
- Create test: tests/rdk-hud-render.test.ts

**Interfaces:**

- Consumes: companion pairing/status events, PhoneLocationState, and RdkNavigationSnapshot.
- Produces:

```ts
export type HudCompanion = {
  pairingCode?: string;
  pairingExpiresAt?: number;
  paired: boolean;
  locationState: PhoneLocationState["connection"];
  horizontalAccuracyMeters?: number;
  lastFixAgeMs?: number;
};

export type HudState = {
  connection: string;
  turnState: string;
  transcript: HudTurn[];
  latencyMs: number | null;
  lastError: string | null;
  companion: HudCompanion;
  navigation: RdkNavigationSnapshot | null;
};

export type HudEvent =
  | AgentEvent
  | { type: "rdk.companion"; companion: HudCompanion }
  | { type: "rdk.navigation"; navigation: RdkNavigationSnapshot | null };
```

- [ ] **Step 1: Write failing reducer/render tests.** Pin pairing code/expiry, GPS status/accuracy, instruction, maneuver distance, destination, remaining distance, ETA, off-route/rerouting, paused banner, frozen values while paused, and card clearing after stop/arrival/start failure/reroute failure. Existing transcript/camera/gallery assertions must remain green.
- [ ] **Step 2: Run RED.** npx vitest run tests/rdk-hud-state.test.ts tests/rdk-hud-render.test.ts.
- [ ] **Step 3: Implement the reducer and DOM.** Insert the card before the camera row. Render with textContent/createElement or an HTML escape helper; never interpolate destination/instruction directly into innerHTML. Show the pairing code only while unpaired and unexpired. Do not load Amap JS or any map.

```html
<section id="navigation-card" class="card nav" hidden>
  <div id="phone-status" class="muted"></div>
  <div id="nav-instruction"></div>
  <div id="nav-distance"></div>
  <div id="nav-summary" class="muted"></div>
  <div id="nav-paused" class="warning" hidden>手机定位已断开 · 导航暂停</div>
</section>
```

- [ ] **Step 4: Run GREEN.** npx vitest run tests/rdk-hud-state.test.ts tests/rdk-hud-render.test.ts, then npm run build.
- [ ] **Step 5: Commit.** git commit -m "feat(rdk-hud): render turn first phone navigation"

---

### Task 12: Make ADAS rank dominate relay and navigation audio

**Files:**

- Modify: rdk/agent/src/audio/playback.ts
- Modify: rdk/agent/src/audio/alert-player.ts
- Modify: rdk/agent/src/main.ts
- Modify test: tests/rdk-audio-io.test.ts
- Modify test: tests/rdk-alert-player.test.ts
- Create test: tests/rdk-playback-priority.test.ts

**Interfaces:**

- Consumes: existing rank-aware flush/hold calls from AlertPlayer and rank-0 relay PCM in main.ts.
- Produces:

```ts
export type Playback = {
  write(pcm: Int16Array, rank?: number): boolean;
  flush(rank?: number): void;
  holdPriority(rank?: number): void;
  releasePriority(): void;
  priorityRank(): number;
  stop(): void;
};
```

- [ ] **Step 1: Write failing priority tests.** Ordinary rank 0 writes are rejected while caution/critical holds exist; equal-rank alert chunks are accepted; critical preempts caution; caution cannot preempt critical; dropped chunks never hit queue, aplay stdin, or reference.write; release restores ordinary audio; stale release timer cannot unlock a newer alert.
- [ ] **Step 2: Run RED.** npx vitest run tests/rdk-playback-priority.test.ts tests/rdk-alert-player.test.ts tests/rdk-audio-io.test.ts.
- [ ] **Step 3: Implement rank-aware writes.** Reject before ensure, upsample, queue, or reference effects. AlertPlayer passes its severity rank to every write. main.ts leaves relay binary at the default rank 0 and injects canPrompt as playback.priorityRank() === 0.

```ts
write(pcm: Int16Array, rank = 0): boolean {
  if (priorityHeld && rank < heldRank) return false;
  ensure();
  const processed = applySoftLimit(upsample(pcm), options.gain, options.threshold);
  queue.push(processed);
  queuedSamples += processed.length;
  pump();
  return true;
}
```

- [ ] **Step 4: Run GREEN.** npx vitest run tests/rdk-playback-priority.test.ts tests/rdk-alert-player.test.ts tests/rdk-audio-io.test.ts; npx tsc -p rdk/agent/tsconfig.json; then npm run check.
- [ ] **Step 5: Commit.** git commit -m "feat(rdk-audio): drop lower ranked speech during ADAS"

---

### Task 13: Build the standalone iOS companion protocol and socket client

**Files:**

- Create: ios/MaxHelmet/Companion/RDKCompanionProtocol.swift
- Create: ios/MaxHelmet/Companion/RDKCompanionClient.swift
- Create test: ios/MaxHelmetTests/RDKCompanionProtocolTests.swift
- Create test: ios/MaxHelmetTests/RDKCompanionClientTests.swift

**Interfaces:**

- Consumes: the logged-in account session token, relay URL, Debug TLS preference, and CompanionServerEvent JSON.
- Produces:

```swift
struct CompanionFix: Equatable {
    let sequence: Int
    let latitude: Double
    let longitude: Double
    let horizontalAccuracyMeters: Double
    let timestampMilliseconds: Double
    let courseDegrees: Double?
    let speedMps: Double?
}

enum CompanionConnectionState: Equatable {
    case signedOut
    case connecting
    case unpaired
    case paired(deviceId: String?, label: String?)
    case helmetOffline(deviceId: String?, label: String?)
    case ready(deviceId: String?, label: String?)
    case sharing(deviceId: String?, label: String?)
    case failed(code: String, detail: String)
}

protocol CompanionSocketTask: AnyObject {
    func resume()
    func send(_ message: URLSessionWebSocketTask.Message, completionHandler: @escaping (Error?) -> Void)
    func receive(completionHandler: @escaping (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
}

final class RDKCompanionClient {
    init(socketFactory: @escaping (URLRequest, Bool) -> CompanionSocketTask,
         schedule: @escaping (@escaping () -> Void, TimeInterval) -> Void)
    convenience init()
    static func companionURL(fromRelay relayURL: String, sessionToken: String) -> URL?
    func connect(relayURL: String, sessionToken: String, allowSelfSignedTLS: Bool)
    func pair(code: String)
    func startRide()
    func stopRide()
    func unpair()
    func sendLatest(_ fix: CompanionFix)
    func disconnect()
    var onState: ((CompanionConnectionState) -> Void)? { get set }
}
```

- [ ] **Step 1: Write failing protocol tests.** Parse all companion.status/error states, omit nil course/speed, verify /agent becomes /companion, preserve scheme/host/port, remove unrelated query, add the supplied non-empty account session token, and reject an empty token.
- [ ] **Step 2: Write failing client tests.** Pin connect, pair/start/stop/unpair messages, desired ride across bounded exponential reconnect, no reconnect after explicit stop/unpair/sign-out, only newest unsent fix retained, no missed-fix backlog, resend of only that newest fix when ready/sharing follows a reconnect, and 401 to failed/auth. A pair-only connection may close after the paired status when no ride is desired; Start Helmet Ride reconnects it. Source inspection and injected-factory counters prove no AgentSession or MicStreamer is constructed.
- [ ] **Step 3: Run RED.** From ios/, run DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:MaxHelmetTests/RDKCompanionProtocolTests -only-testing:MaxHelmetTests/RDKCompanionClientTests.
- [ ] **Step 4: Implement.** Use a dedicated URLSession and WebSocket task, main-thread state delivery, backoff 1/2/4/8/16/30 seconds with a bounded attempt counter, and the same Debug-only self-signed URLSessionDelegate behavior as AgentSession without sharing its voice lifecycle.

```swift
components.path = "/companion"
components.queryItems = [URLQueryItem(name: "token", value: sessionToken)]
components.fragment = nil
```

- [ ] **Step 5: Run GREEN.** Repeat the scoped xcodebuild command from Step 3, then remove both -only-testing arguments and run the full MaxHelmet suite.
- [ ] **Step 6: Commit.** git commit -m "feat(ios-companion): connect pairing and ride state to the relay"

---

### Task 14: Add the explicit iOS background location stream and newest-fix throttle

**Files:**

- Create: ios/MaxHelmet/Companion/CompanionLocationStream.swift
- Create: ios/MaxHelmet/Companion/CompanionFixThrottle.swift
- Create test: ios/MaxHelmetTests/CompanionLocationStreamTests.swift
- Create test: ios/MaxHelmetTests/CompanionFixThrottleTests.swift

**Interfaces:**

- Consumes: CLLocationManager, UIApplication foreground state, and Core Location fixes.
- Produces:

```swift
enum CompanionLocationPermission: Equatable {
    case notDetermined
    case denied
    case reduced
    case precise
}

protocol CompanionLocationManaging: AnyObject {
    var desiredAccuracy: CLLocationAccuracy { get set }
    var activityType: CLActivityType { get set }
    var allowsBackgroundLocationUpdates: Bool { get set }
    var showsBackgroundLocationIndicator: Bool { get set }
    var pausesLocationUpdatesAutomatically: Bool { get set }
    func requestWhenInUseAuthorization()
    func startUpdatingLocation()
    func stopUpdatingLocation()
}

final class CompanionLocationStream {
    var onFix: ((CLLocation) -> Void)?
    var onPermission: ((CompanionLocationPermission) -> Void)?
    func startFromForeground() -> Bool
    func stop()
}

struct CompanionFixThrottle {
    mutating func accept(_ location: CLLocation, now: TimeInterval) -> CompanionFix?
    mutating func flushNewest(now: TimeInterval) -> CompanionFix?
    mutating func reset()
}
```

- [ ] **Step 1: Write failing stream tests.** Starting from foreground sets bestForNavigation, automotiveNavigation, allows background true, indicator true, pausing false, requests When In Use when needed, and starts updates. Background-origin start refuses. Stop reverses background/indicator flags and stops updates even after permission failure.
- [ ] **Step 2: Write failing throttle tests.** First valid fix sends immediately; multiple fixes inside one second collapse to the newest; next second sends the newest only; sequence starts at one for a new Helmet Ride and remains monotonic across socket reconnects; negative Core Location speed/course are omitted; invalid/non-finite coordinate, timestamp, or negative accuracy is dropped.

```swift
let speed = location.speed >= 0 && location.speed.isFinite ? location.speed : nil
let course = location.course >= 0 && location.course < 360 && location.course.isFinite
    ? location.course
    : nil
```

- [ ] **Step 3: Run RED.** From ios/, run DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:MaxHelmetTests/CompanionLocationStreamTests -only-testing:MaxHelmetTests/CompanionFixThrottleTests.
- [ ] **Step 4: Implement with CLLocationManagerDelegate.** Assert UIApplication.shared.applicationState == .active at start, keep the manager dedicated to Helmet Ride, and make stop idempotent and complete.
- [ ] **Step 5: Run GREEN.** Repeat the scoped xcodebuild command from Step 3, then remove both -only-testing arguments and run the full MaxHelmet suite.
- [ ] **Step 6: Commit.** git commit -m "feat(ios-companion): forward explicit background ride location"

---

### Task 15: Wire iOS account lifecycle and the RDK Helmet settings section

**Files:**

- Modify: ios/MaxHelmet/UI/MainViewModel.swift
- Modify: ios/MaxHelmet/UI/AgentSettingsPanel.swift
- Modify: ios/MaxHelmet/Info.plist
- Modify: ios/MaxHelmet/Info-Debug.plist
- Modify: ios/README.md
- Create test: ios/MaxHelmetTests/CompanionViewModelTests.swift
- Create test: ios/MaxHelmetTests/CompanionSettingsTests.swift

**Interfaces:**

- Consumes: RDKCompanionClient, CompanionLocationStream, CompanionFixThrottle, and MainViewModel's existing account state.
- Produces:

```swift
@Published private(set) var companionState: CompanionConnectionState = .signedOut
@Published private(set) var helmetRideActive = false
@Published private(set) var companionPermission: CompanionLocationPermission = .notDetermined
@Published private(set) var lastForwardedAt: Date?
@Published var pairCode = ""

func pairHelmet()
func startHelmetRide()
func stopHelmetRide()
func unpairHelmet()
```

- [ ] **Step 1: Write failing view-model tests.** Pair requires isLoggedIn and a six-digit code; the companion always receives sessionToken, never effectiveToken/manual operator token; Start Helmet Ride connects, sends start, then starts location only from foreground; fixes flow through the throttle; Stop ends location before socket state; unpair and logout stop location before clearing pairing/auth; 401/auth-required also stops the ride; hands-free voice state is independent. Permission denial/reduced-unusable start sends companion.stop, leaves Helmet Ride inactive, and shows the specific permission state rather than pretending to share.
- [ ] **Step 2: Write failing settings rendering tests.** Pin unpaired, paired offline, ready, sharing, denied, reduced/unusable accuracy, last-forward age, Pair disabled/busy state, Start/Stop labels, and unpair confirmation. No raw token or coordinate appears in rendered strings.
- [ ] **Step 3: Run RED.** From ios/, run DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:MaxHelmetTests/CompanionViewModelTests -only-testing:MaxHelmetTests/CompanionSettingsTests.
- [ ] **Step 4: Implement the coordinator wiring.** MainViewModel owns one companion client, stream, and throttle through an internal dependency-injecting initializer used by tests. Login alone does not open a companion socket. pairHelmet opens/authenticates the companion socket and sends the code without starting Core Location; startHelmetRide reuses or reconnects that socket and starts location. App relaunch does not silently resume a ride. Logout calls stopHelmetRide before AuthClient.logout and token deletion.

```swift
func logout() {
    stopHelmetRide()
    authClient.logout(relayURL: relayURL, token: sessionToken, allowSelfSignedTls: allowSelfSigned)
    sessionToken = ""
    authUserId = ""
    authUsername = ""
    authDisplayName = ""
    authRole = ""
    if session.state.handsFree { session.stop() }
}
```

- [ ] **Step 5: Update both plists.** Add location to UIBackgroundModes beside audio and replace NSLocationWhenInUseUsageDescription with text that explicitly names helmet navigation and locked-screen forwarding. Preserve Debug-only transport exceptions and Release TLS hardening.
- [ ] **Step 6: Run GREEN.** Repeat the scoped xcodebuild command from Step 3; remove both -only-testing arguments and run the full suite; then run DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17' CODE_SIGNING_ALLOWED=NO build.
- [ ] **Step 7: Commit.** git commit -m "feat(ios-companion): expose pairing and Helmet Ride controls"

---

### Task 16: Prove the complete flow, document operations, and deploy in safe order

**Files:**

- Create test: tests/rdk-companion-navigation-e2e.test.ts
- Modify: README.md
- Modify: rdk/README.md
- Modify: ios/README.md
- Modify: CHANGELOG.md
- Create: docs/rdk-ios-companion-acceptance.md

**Interfaces:**

- Consumes: CompanionBindingStore, CompanionRegistry, PhoneLocationSource, RdkNavigationController, MOCK_ROUTE, and the deployment scripts already in the repository.
- Produces: no new product API; it produces the deterministic integration test and docs/rdk-ios-companion-acceptance.md evidence record.

- [ ] **Step 1: Write the automated end-to-end test.** Use an in-memory CompanionBindingStore, deterministic code/clock, mock /agent and /companion peers, PhoneLocationSource, RdkNavigationController, and MOCK_ROUTE. Exercise authenticated pairing, ride start, held navigation.start, route delivery, far/near/now, off-route reroute, stale pause, fresh resume, arrival, idempotent navigation.stop, and companion.stop.

```ts
expect(timeline).toEqual([
  "paired",
  "sharing",
  "navigation.start.pending",
  "nav.route",
  "prompt.far",
  "prompt.near",
  "prompt.now",
  "reroute.request",
  "location.paused",
  "location.resumed",
  "arrived",
  "ride.stopped"
]);
```

- [ ] **Step 2: Add privacy assertions.** Capture logger calls, testing metrics, user memory events, binding snapshots, and temp-store contents; assert no source coordinate, course, speed, or pairing code appears.
- [ ] **Step 3: Run RED/GREEN.** npx vitest run tests/rdk-companion-navigation-e2e.test.ts, then npm run check, npx tsc -p rdk/agent/tsconfig.json, and the full iOS suite.
- [ ] **Step 4: Document operations.** Record COMPANION_BINDINGS_FILE ownership/backup behavior, /companion health expectations, RDK device-id provisioning, iOS permission behavior, force-quit limitation, Debug self-signed testing, and the production trusted-certificate requirement.
- [ ] **Step 5: Commit.** git commit -m "test(companion-nav): prove the phone relay RDK route flow"
- [ ] **Step 6: Deploy relay first.** Push the reviewed main commit, run ./deploy-lightsail.command, and verify /health and /ready report that exact commit. Confirm the owner-only companion binding path is writable before pairing.
- [ ] **Step 7: Install iOS second.** Build/install the Debug app on the physical iPhone, sign in, pair once, and confirm the RDK HUD reports ready before starting a ride.
- [ ] **Step 8: Deploy RDK third.** Sync the reviewed source to /opt/max, install dependencies if the lockfile changed, restart max-agent, and verify systemctl status plus journal logs show the stable device ID registration without printing its pair code or coordinates.
- [ ] **Step 9: Run physical acceptance.** Lock the phone for at least ten minutes, request a real Amap destination, verify HUD/speech, remove/restore phone network/location, trigger an armed test ADAS alert during a prompt, stop navigation, start a second route without unlocking, stop Helmet Ride, and inspect logs/stores for coordinate leakage.
- [ ] **Step 10: Record exact deployed identities.** Save the Git commit, Lightsail health build stamp, iOS build stamp, RDK journal start time, and physical acceptance result in docs/rdk-ios-companion-acceptance.md.

---

## Final Verification Checklist

- [ ] npm run check exits 0.
- [ ] npx tsc -p rdk/agent/tsconfig.json exits 0.
- [ ] Full MaxHelmet XCTest suite exits 0 on the named simulator.
- [ ] git diff --check reports no whitespace errors.
- [ ] npm run check:protocol confirms generated TS/Swift/Kotlin tables are current.
- [ ] rg -n "lat|lon|course|speed" server/companion-store.ts shows no raw-location fields in persisted snapshots.
- [ ] rg -n "companion.location|phone.location" server confirms logger calls contain only event/state identifiers, never payload spreads.
- [ ] Existing web, Android, and iOS voice/navigation test suites remain green.
- [ ] Relay is deployed before iOS/RDK clients and /health plus /ready match the reviewed commit.
- [ ] Physical locked-screen ride and ADAS-preemption acceptance pass.
