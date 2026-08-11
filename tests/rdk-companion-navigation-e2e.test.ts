import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CompanionPairingEvent,
  DeviceResultEvent,
  NavPromptEvent,
  NavRequestEvent,
  NavRouteEvent,
  PhoneLocationEvent,
  PhoneLocationStatusEvent
} from "../shared/agent";
import { MOCK_ROUTE } from "../shared/nav-fixtures";
import { parseCompanionClientEvent, type CompanionServerEvent } from "../shared/companion";
import { createCompanionBindingStore } from "../server/companion-store";
import {
  createCompanionRegistry,
  PAIR_CONFIRM_PROMPT,
  PAIR_CONFIRM_OK_SPEECH,
  type CompanionConnection
} from "../server/companion-registry";
import { metrics } from "../server/metrics";
import { parseClientEvent } from "../server/session-controller";
import { resetUserMemoryForTests, userConversationMemory } from "../server/user-memory";
import { initialHudState, reduceHud, type HudState } from "../rdk/agent/src/hud/state";
import {
  createRdkNavigationController,
  type RdkNavigationController,
  type RdkNavigationSnapshot
} from "../rdk/agent/src/navigation/controller";
import { createPhoneLocationSource, type PhoneLocationSource } from "../rdk/agent/src/navigation/phone-location";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "rdk-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PAIR_CODE = "741963";
const COURSE_SENTINEL = 87.654_321;
const SPEED_SENTINEL = 6.543_219;
const ACCURACY_SENTINEL = 7.812_345;

// Hand-checked WGS-84 fixtures whose production conversion lands on the
// corresponding GCJ-02 points along MOCK_ROUTE. Changing or removing the
// WGS→GCJ boundary, prompt thresholds, or route geometry breaks the timeline.
const WGS_FIXES = {
  start: { lat: 31.232_329_239_037_504, lon: 121.469_162_263_329_5 },
  far: { lat: 31.235_027_999_343_924, lon: 121.469_162_030_309_79 },
  near: { lat: 31.237_127_039_774_187, lon: 121.469_161_849_055_67 },
  now: { lat: 31.238_006_638_881_355, lon: 121.469_161_773_097_27 },
  offRoute: { lat: 31.238_004_023_221_013, lon: 121.468_158_644_122_61 },
  arrival: { lat: 31.238_338_557_745_145, lon: 121.473_676_180_966_05 }
} as const;

const EXPECTED_TIMELINE = [
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
] as const;

type HelmetEvent = CompanionPairingEvent | PhoneLocationEvent | PhoneLocationStatusEvent;
type LoggerCall = { method: "info" | "warn"; message: string; fields?: Record<string, unknown> };

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  metrics.reset();
  resetUserMemoryForTests();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function flush(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

function routeFor(commandId: string): NavRouteEvent {
  return {
    type: "nav.route",
    commandId,
    destinationName: "人民广场",
    destination: { ...MOCK_ROUTE.polyline.at(-1)! },
    distanceMeters: MOCK_ROUTE.distanceMeters,
    etaSeconds: MOCK_ROUTE.etaSeconds,
    polyline: MOCK_ROUTE.polyline.map((point) => ({ ...point })),
    steps: MOCK_ROUTE.steps.map((step) => ({ ...step }))
  };
}

function visibleHudEvidence(state: HudState): Record<string, unknown> {
  return {
    companion: {
      paired: state.companion.paired,
      locationState: state.companion.locationState,
      ...(state.companion.horizontalAccuracyMeters === undefined
        ? {}
        : { accuracyText: `精度 ±${Math.round(state.companion.horizontalAccuracyMeters)} m` })
    },
    navigation:
      state.navigation === null
        ? null
        : {
            phase: state.navigation.phase,
            destinationName: state.navigation.destinationName,
            instruction: state.navigation.instruction,
            distanceToManeuverMeters: state.navigation.distanceToManeuverMeters,
            remainingMeters: state.navigation.remainingMeters,
            remainingSeconds: state.navigation.remainingSeconds,
            offRoute: state.navigation.offRoute
          }
  };
}

function allFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? allFiles(fullPath) : [fullPath];
  });
}

function buildHarness(options: { randomToken?: () => string } = {}) {
  vi.useFakeTimers();
  metrics.reset();
  resetUserMemoryForTests();

  let now = 1_800_000_000_000;
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "max-companion-nav-e2e-"));
  temporaryDirectories.push(tempDirectory);
  const bindingFile = path.join(tempDirectory, "private", "companion-bindings.json");
  const store = createCompanionBindingStore({ filePath: bindingFile, now: () => now });
  const loggerCalls: LoggerCall[] = [];
  const timeline: string[] = [];
  const helmetFrames: HelmetEvent[] = [];
  const helmetSpoken: string[] = [];
  const companionFrames: CompanionServerEvent[] = [];
  const agentTransportFrames: string[] = [];
  const providerVisibleInputs: NavPromptEvent[] = [];
  const navigationStates: RdkNavigationSnapshot[] = [];
  const renderedHudEvidence: Array<Record<string, unknown>> = [];
  const outgoingRequests: NavRequestEvent[] = [];
  const interruptOrder: string[] = [];
  let hud = initialHudState();
  let lastNavigationPhase: RdkNavigationSnapshot["phase"] | undefined;
  let nextId = 0;
  const owner: { controller?: RdkNavigationController } = {};

  const registry = createCompanionRegistry({
    store,
    now: () => now,
    randomCode: () => PAIR_CODE,
    ...(options.randomToken ? { randomToken: options.randomToken } : {}),
    minFixIntervalMs: 1_000,
    log: {
      info(message, fields) {
        loggerCalls.push({ method: "info", message, fields });
      },
      warn(message, fields) {
        loggerCalls.push({ method: "warn", message, fields });
      }
    }
  });

  const source: PhoneLocationSource = createPhoneLocationSource({
    now: () => now,
    onState(state) {
      owner.controller?.handleLocationState(state);
      hud = reduceHud(hud, {
        type: "rdk.companion",
        companion: {
          paired: hud.companion.paired,
          locationState: state.connection,
          ...(state.horizontalAccuracyMeters === undefined
            ? {}
            : { horizontalAccuracyMeters: state.horizontalAccuracyMeters }),
          ...(state.ageMs === undefined ? {} : { lastFixAgeMs: state.ageMs })
        }
      });
      if (hud.companion.paired) renderedHudEvidence.push(visibleHudEvidence(hud));
    },
    onFix(fix) {
      owner.controller?.handleFix(fix);
    }
  });

  const controller: RdkNavigationController = createRdkNavigationController({
    location: source,
    sendEvent(event) {
      const frame = JSON.stringify(event);
      agentTransportFrames.push(frame);
      const parsed = parseClientEvent(Buffer.from(frame));
      if (parsed.type === "nav.request") {
        outgoingRequests.push(parsed);
        if (parsed.reason === "reroute") timeline.push("reroute.request");
        return;
      }
      if (parsed.type !== "nav.prompt") throw new Error(`Unexpected RDK event ${parsed.type}`);
      providerVisibleInputs.push(parsed);
      if (parsed.kind === "maneuver") timeline.push(`prompt.${parsed.threshold}`);
      if (parsed.kind === "arrived") timeline.push("arrived");
    },
    onState(state) {
      navigationStates.push(structuredClone(state));
      hud = reduceHud(hud, { type: "rdk.navigation", navigation: state.phase === "idle" ? null : state });
      if (state.phase === "starting" && !timeline.includes("navigation.start.pending")) {
        timeline.push("navigation.start.pending");
      }
      if (state.phase === "paused" && lastNavigationPhase !== "paused") timeline.push("location.paused");
      if (state.phase === "guiding" && lastNavigationPhase === "paused") timeline.push("location.resumed");
      lastNavigationPhase = state.phase;
      if (hud.companion.paired) renderedHudEvidence.push(visibleHudEvidence(hud));
    },
    canPrompt: () => true,
    interruptOrdinaryPlayback() {
      interruptOrder.push("interrupt");
    },
    now: () => now,
    randomId: () => `e2e-id-${++nextId}`
  });
  owner.controller = controller;

  const sessionStart = parseClientEvent(
    Buffer.from(
      JSON.stringify({
        type: "session.start",
        sampleRate: 16_000,
        channels: 1,
        deviceId: DEVICE_ID,
        deviceLabel: "Acceptance RDK X5",
        platform: "embedded"
      })
    )
  );
  if (sessionStart.type !== "session.start" || !sessionStart.deviceId) throw new Error("RDK registration rejected");

  const attachHelmet = () =>
    registry.attachHelmet({
      deviceId: sessionStart.deviceId!,
      deviceLabel: sessionStart.deviceLabel ?? "RDK X5",
      send(event) {
        helmetFrames.push(structuredClone(event));
        if (event.type === "companion.pairing") {
          hud = reduceHud(hud, event);
          if (event.paired) timeline.push("paired");
          return;
        }
        if (event.type === "phone.location.status") {
          source.acceptStatus(event);
          hud = reduceHud(hud, event);
          if (event.state === "stopped" && !timeline.includes("ride.stopped")) timeline.push("ride.stopped");
          return;
        }
        source.acceptLocation(event);
      },
      speak: (text) => helmetSpoken.push(text)
    });

  const attachPhone = (): CompanionConnection =>
    registry.attachCompanion({
      accountId: ACCOUNT_ID,
      address: "198.51.100.27",
      send(event) {
        companionFrames.push(structuredClone(event));
        if (event.type === "companion.status" && event.state === "sharing" && !timeline.includes("sharing")) {
          timeline.push("sharing");
        }
      }
    });

  async function companionSend(connection: CompanionConnection, event: object): Promise<void> {
    const parsed = parseCompanionClientEvent(JSON.stringify(event));
    metrics.companionAccepted();
    await connection.handle(parsed);
  }

  async function advance(milliseconds: number): Promise<void> {
    now += milliseconds;
    await vi.advanceTimersByTimeAsync(milliseconds);
  }

  async function location(
    connection: CompanionConnection,
    sequence: number,
    point: { lat: number; lon: number },
    overrides: Partial<PhoneLocationEvent> = {}
  ): Promise<void> {
    await companionSend(connection, {
      type: "companion.location",
      sequence,
      lat: point.lat,
      lon: point.lon,
      horizontalAccuracyMeters: ACCURACY_SENTINEL,
      timestamp: now,
      courseDegrees: COURSE_SENTINEL,
      speedMps: SPEED_SENTINEL,
      ...overrides
    });
  }

  function relayRoute(request: NavRequestEvent): NavRouteEvent {
    const route = routeFor(request.commandId);
    if (request.reason === "start") timeline.push("nav.route");
    controller.handleRoute(route);
    return route;
  }

  return {
    store,
    registry,
    source,
    controller,
    bindingFile,
    tempDirectory,
    loggerCalls,
    timeline,
    helmetFrames,
    helmetSpoken,
    companionFrames,
    agentTransportFrames,
    providerVisibleInputs,
    navigationStates,
    renderedHudEvidence,
    outgoingRequests,
    interruptOrder,
    attachHelmet,
    attachPhone,
    companionSend,
    advance,
    location,
    relayRoute,
    hud: () => structuredClone(hud),
    metricsSnapshot: () => structuredClone(metrics.snapshot()),
    now: () => now
  };
}

describe("phone relay to RDK navigation end-to-end", () => {
  it("pairs, shares, guides, reroutes, pauses, resumes, arrives, and tears down in semantic order", async () => {
    const h = buildHarness();
    const detachHelmet = h.attachHelmet();
    const phone = h.attachPhone();

    await h.companionSend(phone, { type: "companion.pair", code: PAIR_CODE });
    await h.companionSend(phone, { type: "companion.start" });

    let startSettled = false;
    const start = h.controller
      .handleCommand({
        commandId: "device-navigation-start",
        action: "navigation.start",
        args: { query: "人民广场" }
      })
      .then((value) => {
        startSettled = true;
        return value;
      });
    await flush();
    expect(startSettled).toBe(false);
    expect(h.outgoingRequests).toEqual([]);

    await h.location(phone, 1, WGS_FIXES.start);
    await flush();
    expect(h.outgoingRequests).toHaveLength(1);
    const initialRequest = h.outgoingRequests[0]!;
    expect(initialRequest).toMatchObject({
      type: "nav.request",
      commandId: "e2e-id-1",
      reason: "start",
      query: "人民广场"
    });
    const initialRoute = h.relayRoute(initialRequest);
    await expect(start).resolves.toEqual({
      type: "device.result",
      commandId: "device-navigation-start",
      status: "ok"
    } satisfies DeviceResultEvent);
    expect(initialRoute.commandId).toBe(initialRequest.commandId);

    await h.advance(1_000);
    await h.location(phone, 1, WGS_FIXES.far);
    await h.advance(1_000);
    await h.location(phone, 2, WGS_FIXES.far, { timestamp: h.now() - 10_001 });
    expect(h.helmetFrames.filter((event) => event.type === "phone.location")).toHaveLength(1);

    await h.location(phone, 2, WGS_FIXES.far);
    await h.advance(1_000);
    await h.location(phone, 3, WGS_FIXES.near);
    await h.advance(1_000);
    await h.location(phone, 4, WGS_FIXES.now);
    await h.advance(1_000);
    await h.location(phone, 5, WGS_FIXES.offRoute);

    expect(h.interruptOrder).toEqual(["interrupt"]);
    const rerouteRequest = h.outgoingRequests.at(-1)!;
    expect(rerouteRequest).toMatchObject({
      type: "nav.request",
      commandId: "e2e-id-6",
      reason: "reroute",
      destinationName: "人民广场"
    });
    const replacementRoute = h.relayRoute(rerouteRequest);
    expect(replacementRoute.commandId).toBe(rerouteRequest.commandId);

    await h.advance(10_000);
    expect(h.navigationStates.at(-1)).toMatchObject({
      phase: "paused",
      location: { connection: "stale", usable: false, reason: "stale" }
    });

    await h.advance(1_000);
    await h.location(phone, 6, WGS_FIXES.start);
    await h.advance(1_000);
    await h.location(phone, 7, WGS_FIXES.arrival);

    expect(h.providerVisibleInputs.filter((event) => event.kind === "arrived")).toHaveLength(1);
    const stopAfterArrival = await h.controller.handleCommand({
      commandId: "device-navigation-stop-1",
      action: "navigation.stop",
      args: {}
    });
    const repeatedStopAfterArrival = await h.controller.handleCommand({
      commandId: "device-navigation-stop-2",
      action: "navigation.stop",
      args: {}
    });
    expect(stopAfterArrival).toEqual({
      type: "device.result",
      commandId: "device-navigation-stop-1",
      status: "failed",
      reason: "navigation.notActive"
    });
    expect(repeatedStopAfterArrival).toEqual({
      type: "device.result",
      commandId: "device-navigation-stop-2",
      status: "failed",
      reason: "navigation.notActive"
    });

    await h.companionSend(phone, { type: "companion.stop" });
    await h.companionSend(phone, { type: "companion.stop" });
    expect(h.timeline).toEqual(EXPECTED_TIMELINE);
    expect(h.providerVisibleInputs.filter((event) => event.kind === "arrived")).toHaveLength(1);
    expect(h.navigationStates.at(-1)?.phase).toBe("idle");

    const replacementPhone = h.attachPhone();
    const replacementHelmetDetach = h.attachHelmet();
    detachHelmet();
    const framesAfterReplacement = h.helmetFrames.length;
    await h.companionSend(phone, { type: "companion.start" });
    await h.location(phone, 8, WGS_FIXES.arrival);
    expect(h.helmetFrames).toHaveLength(framesAfterReplacement);

    const observableBeforeClose = {
      helmetFrames: h.helmetFrames.length,
      companionFrames: h.companionFrames.length,
      navigationStates: h.navigationStates.length,
      providerVisibleInputs: h.providerVisibleInputs.length,
      timeline: h.timeline.length
    };
    h.controller.close();
    h.source.close();
    await h.registry.close();
    replacementPhone.detach();
    replacementHelmetDetach();
    await h.companionSend(replacementPhone, { type: "companion.start" });
    await h.advance(20_000);
    expect({
      helmetFrames: h.helmetFrames.length,
      companionFrames: h.companionFrames.length,
      navigationStates: h.navigationStates.length,
      providerVisibleInputs: h.providerVisibleInputs.length,
      timeline: h.timeline.length
    }).toEqual(observableBeforeClose);
  });

  it("pairs by discovery + voice confirm, then rides the same nav flow", async () => {
    const DISCOVERY_TOKEN = "a".repeat(32);
    const h = buildHarness({ randomToken: () => DISCOVERY_TOKEN });
    h.attachHelmet();
    const phone = h.attachPhone();

    expect(h.helmetFrames.filter((event) => event.type === "companion.discovery")).toHaveLength(1);
    expect(h.helmetFrames.find((event) => event.type === "companion.discovery")).toMatchObject({
      type: "companion.discovery",
      token: DISCOVERY_TOKEN
    });

    await h.companionSend(phone, { type: "companion.pairDiscover", token: DISCOVERY_TOKEN });
    expect(h.helmetSpoken.at(-1)).toBe(PAIR_CONFIRM_PROMPT);

    h.registry.handleRiderUtterance(DEVICE_ID, "确认");
    await vi.waitFor(() => expect(h.store.bindingForAccount(ACCOUNT_ID)?.deviceId).toBe(DEVICE_ID));

    expect(h.helmetSpoken.at(-1)).toBe(PAIR_CONFIRM_OK_SPEECH);
    expect(h.helmetFrames.filter((event) => event.type === "companion.pairing").at(-1)).toMatchObject({
      paired: true
    });
    expect(h.helmetFrames.filter((event) => event.type === "companion.discovery").at(-1)).toEqual({
      type: "companion.discovery",
      token: null
    });

    await h.companionSend(phone, { type: "companion.start" });

    let startSettled = false;
    const start = h.controller
      .handleCommand({
        commandId: "device-navigation-start-discovery",
        action: "navigation.start",
        args: { query: "人民广场" }
      })
      .then((value) => {
        startSettled = true;
        return value;
      });
    await flush();
    expect(startSettled).toBe(false);
    expect(h.outgoingRequests).toEqual([]);

    await h.location(phone, 1, WGS_FIXES.start);
    await flush();
    expect(h.outgoingRequests).toHaveLength(1);
    const initialRequest = h.outgoingRequests[0]!;
    expect(initialRequest).toMatchObject({
      type: "nav.request",
      commandId: "e2e-id-1",
      reason: "start",
      query: "人民广场"
    });
    const initialRoute = h.relayRoute(initialRequest);
    await expect(start).resolves.toEqual({
      type: "device.result",
      commandId: "device-navigation-start-discovery",
      status: "ok"
    } satisfies DeviceResultEvent);
    expect(initialRoute.commandId).toBe(initialRequest.commandId);

    await h.advance(1_000);
    await h.location(phone, 2, WGS_FIXES.far);

    expect(h.timeline).toEqual(["paired", "sharing", "navigation.start.pending", "nav.route", "prompt.far"]);

    h.controller.close();
    h.source.close();
    await h.registry.close();
  });

  it("keeps private fix and pairing sentinels only in the protocol transport that needs them", async () => {
    const h = buildHarness();
    h.attachHelmet();
    const phone = h.attachPhone();
    const metricsBefore = h.metricsSnapshot();

    await h.companionSend(phone, { type: "companion.pair", code: PAIR_CODE });
    await h.companionSend(phone, { type: "companion.start" });
    const start = h.controller.handleCommand({
      commandId: "privacy-navigation-start",
      action: "navigation.start",
      args: { query: "人民广场" }
    });
    await h.location(phone, 1, WGS_FIXES.start);
    await flush();
    h.relayRoute(h.outgoingRequests[0]!);
    await start;

    const binding = h.store.bindingForAccount(ACCOUNT_ID);
    expect(binding).toEqual({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000
    });
    expect(fs.statSync(path.dirname(h.bindingFile)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(h.bindingFile).mode & 0o777).toBe(0o600);

    const bindingFileContents = fs.readFileSync(h.bindingFile, "utf8");
    const temporaryDocuments = allFiles(h.tempDirectory).map((file) => ({
      relativePath: path.relative(h.tempDirectory, file),
      contents: fs.readFileSync(file, "utf8")
    }));
    const acceptancePath = path.resolve("docs/rdk-ios-companion-acceptance.md");
    const acceptanceEvidence = fs.existsSync(acceptancePath) ? fs.readFileSync(acceptancePath, "utf8") : "";
    const privateSurfaces = JSON.stringify({
      loggerCalls: h.loggerCalls,
      metricsBefore,
      metricsAfter: h.metricsSnapshot(),
      providerVisibleInputs: h.providerVisibleInputs,
      userMemory: userConversationMemory(ACCOUNT_ID),
      binding,
      bindingFileContents,
      temporaryDocuments,
      acceptanceEvidence,
      renderedHudEvidence: h.renderedHudEvidence
    });
    const rawSentinels = [
      PAIR_CODE,
      String(WGS_FIXES.start.lat),
      String(WGS_FIXES.start.lon),
      String(COURSE_SENTINEL),
      String(SPEED_SENTINEL),
      String(ACCURACY_SENTINEL)
    ];
    for (const sentinel of rawSentinels) expect(privateSurfaces).not.toContain(sentinel);

    const transportEvidence = JSON.stringify({
      helmetFrames: h.helmetFrames,
      agentTransportFrames: h.agentTransportFrames
    });
    expect(transportEvidence).toContain(PAIR_CODE);
    expect(transportEvidence).toContain(String(WGS_FIXES.start.lat));
    expect(transportEvidence).toContain(String(COURSE_SENTINEL));

    h.controller.close();
    h.source.close();
    await h.registry.close();
  });
});
