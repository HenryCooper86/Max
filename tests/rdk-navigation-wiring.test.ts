import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEVICE_ACTION_TIERS, type DeviceActionName } from "../server/device-actions";
import type {
  AgentEvent,
  DeviceResultEvent,
  NavRequestEvent,
  NavRouteEvent,
  PhoneLocationEvent,
  PhoneLocationStatusEvent
} from "../shared/agent";
import type { DeviceCommand } from "../rdk/agent/src/device/dispatch";
import type { RdkNavigationController, RdkNavigationSnapshot } from "../rdk/agent/src/navigation/controller";
import type { PhoneLocationSource } from "../rdk/agent/src/navigation/phone-location";
import type { PhoneFix, PhoneLocationState } from "../rdk/agent/src/navigation/phone-location";
import type { RelayHandlers } from "../rdk/agent/src/relay";

const fixtures = vi.hoisted(() => ({
  relayHandlers: undefined as RelayHandlers | undefined,
  relayEvents: [] as unknown[],
  relayConnects: 0,
  relayDisconnects: 0,
  callbackOrder: [] as string[],
  hudPublishes: [] as unknown[],
  sources: [] as Array<{
    source: PhoneLocationSource;
    close: ReturnType<typeof vi.fn>;
    emitFix: (fix: PhoneFix) => void;
    emitState: (state: PhoneLocationState) => void;
  }>,
  controllers: [] as Array<{
    controller: RdkNavigationController;
    close: ReturnType<typeof vi.fn>;
    handleFix: ReturnType<typeof vi.fn>;
    handleLocationState: ReturnType<typeof vi.fn>;
    states: RdkNavigationSnapshot[];
    emitState: (state: RdkNavigationSnapshot) => void;
    canPrompt: () => boolean;
    interruptOrdinaryPlayback: () => void;
  }>,
  captureStop: vi.fn(),
  playbackStop: vi.fn(),
  playbackFlush: vi.fn(),
  playbackWrite: vi.fn(() => true),
  playbackRank: 0,
  hudClose: vi.fn(),
  spawn: vi.fn(),
  gateOpen: false,
  captureOnFrame: undefined as ((frame: Int16Array) => void) | undefined,
  signalHandlers: new Map<string, (...args: unknown[]) => void>()
}));

vi.mock("node:net", () => ({
  Socket: class {
    on(): this {
      return this;
    }
    write(): boolean {
      return true;
    }
    connect(): this {
      return this;
    }
  }
}));

// Only the ALSA volume helper and "Max，关机" start a process; a test that
// needs one gives `spawn` an implementation.
vi.mock("node:child_process", () => ({ spawn: fixtures.spawn }));

vi.mock("../rdk/agent/src/config", () => ({
  loadConfig: () => ({
    deviceIdFile: "/tmp/max-test-device-id",
    voiceGateRms: 100,
    voiceGateMs: 100,
    aecMode: "off",
    alsaPlayback: "hw:0,0",
    hudPort: 8787,
    visionPreviewPort: 8081,
    adasAudio: false,
    adasAudioDir: "/tmp/max-test-alerts",
    visionSocket: "/tmp/max-test-vision.sock",
    alsaCapture: "hw:0,0",
    aecBin: "max-aec",
    aecDelayMs: 0,
    aecSuppression: 0,
    aecDump: false
  })
}));

vi.mock("../rdk/agent/src/device/identity", () => ({
  loadOrCreateDeviceId: () => "rdk-123e4567-e89b-42d3-a456-426614174000"
}));

vi.mock("../rdk/agent/src/audio/capture", () => ({
  createCapture: (options: { onFrame: (frame: Int16Array) => void }) => {
    fixtures.captureOnFrame = options.onFrame;
    return { start: vi.fn(), stop: fixtures.captureStop };
  }
}));

vi.mock("../rdk/agent/src/audio/playback", () => ({
  createPlayback: () => ({
    write: fixtures.playbackWrite,
    flush: fixtures.playbackFlush,
    holdPriority: vi.fn(),
    releasePriority: vi.fn(),
    priorityRank: () => fixtures.playbackRank,
    stop: fixtures.playbackStop
  })
}));

vi.mock("../rdk/agent/src/audio/reference", () => ({
  createReferenceSink: () => ({ write: vi.fn(), flush: vi.fn(), close: vi.fn() })
}));

vi.mock("../rdk/agent/src/audio/voice-gate", () => ({ createVoiceGate: () => () => fixtures.gateOpen }));
vi.mock("../rdk/agent/src/audio/barge-in", () => ({
  createBargeInGuard: () => ({ request: vi.fn(), observe: vi.fn() })
}));
vi.mock("../rdk/agent/src/audio/mixer", () => ({ applyCrosstalk: async () => true }));
vi.mock("../rdk/agent/src/audio/alert-player", () => ({ createAlertPlayer: () => ({}) }));
vi.mock("../rdk/agent/src/audio/cues", () => ({ writeCue: vi.fn() }));
vi.mock("../rdk/agent/src/hazard", () => ({ createHazardHandler: () => ({ handle: async () => {} }) }));
vi.mock("../rdk/agent/src/device/poweroff", () => ({
  createPoweroffController: () => ({ schedule: () => "scheduled", cancel: () => false })
}));
vi.mock("../rdk/agent/src/hud/server", () => ({
  createHudServer: () => ({
    publish: (state: unknown) => {
      fixtures.callbackOrder.push("hud");
      fixtures.hudPublishes.push(state);
    },
    close: fixtures.hudClose
  })
}));
vi.mock("../rdk/agent/src/watchdog", () => ({ startHeartbeat: vi.fn() }));

vi.mock("../rdk/agent/src/relay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rdk/agent/src/relay")>();
  return {
    ...actual,
    createRelayClient: (_config: unknown, _deviceId: string, handlers: RelayHandlers) => {
      let generation = 0;
      fixtures.relayHandlers = {
        ...handlers,
        onClosed: (close) => {
          generation += 1;
          handlers.onClosed(close);
        }
      };
      return {
        connect: () => {
          fixtures.relayConnects += 1;
        },
        disconnect: () => {
          fixtures.relayDisconnects += 1;
        },
        sendFrame: vi.fn(),
        sendEvent: (event: unknown) => fixtures.relayEvents.push(event),
        captureEventSender: () => {
          const owner = generation;
          return (event: unknown) => {
            if (owner === generation) fixtures.relayEvents.push(event);
          };
        },
        isReady: () => true
      };
    }
  };
});

vi.mock("../rdk/agent/src/navigation/phone-location", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rdk/agent/src/navigation/phone-location")>();
  return {
    ...actual,
    createPhoneLocationSource: (
      options: Parameters<typeof actual.createPhoneLocationSource>[0]
    ): PhoneLocationSource => {
      const source = actual.createPhoneLocationSource(options);
      const originalClose = source.close.bind(source);
      const close = vi.fn(originalClose);
      source.close = close;
      fixtures.sources.push({
        source,
        close,
        emitFix: options.onFix ?? (() => undefined),
        emitState: options.onState ?? (() => undefined)
      });
      return source;
    }
  };
});

vi.mock("../rdk/agent/src/navigation/controller", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rdk/agent/src/navigation/controller")>();
  return {
    ...actual,
    createRdkNavigationController: (
      options: Parameters<typeof actual.createRdkNavigationController>[0]
    ): RdkNavigationController => {
      const states: RdkNavigationSnapshot[] = [];
      const onState = options.onState;
      const controller = actual.createRdkNavigationController({
        ...options,
        onState: (state) => {
          states.push(state);
          onState(state);
        }
      });
      const originalClose = controller.close.bind(controller);
      const originalHandleFix = controller.handleFix.bind(controller);
      const originalHandleLocationState = controller.handleLocationState.bind(controller);
      const close = vi.fn(originalClose);
      const handleFix = vi.fn(originalHandleFix);
      const handleLocationState = vi.fn((state: PhoneLocationState) => {
        fixtures.callbackOrder.push("navigation");
        originalHandleLocationState(state);
      });
      controller.close = close;
      controller.handleFix = handleFix;
      controller.handleLocationState = handleLocationState;
      fixtures.controllers.push({
        controller,
        close,
        handleFix,
        handleLocationState,
        states,
        emitState: onState,
        canPrompt: options.canPrompt,
        interruptOrdinaryPlayback: options.interruptOrdinaryPlayback
      });
      return controller;
    }
  };
});

type MainModule = typeof import("../rdk/agent/src/main");
let main: MainModule;
let restoreProcessOn: (() => void) | undefined;
let restoreProcessExit: (() => void) | undefined;

beforeAll(async () => {
  const argv1 = process.argv[1];
  const on = vi.spyOn(process, "on").mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
    fixtures.signalHandlers.set(event, listener);
    return process;
  }) as typeof process.on);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);
  restoreProcessOn = () => on.mockRestore();
  restoreProcessExit = () => exit.mockRestore();
  process.argv[1] = "/virtual/rdk/agent/src/main.ts";
  main = await import("../rdk/agent/src/main");
  process.argv[1] = argv1;
});

afterAll(() => {
  restoreProcessOn?.();
  restoreProcessExit?.();
});

function navigationStub(
  handleCommand: (command: DeviceCommand) => Promise<DeviceResultEvent>
): RdkNavigationController {
  return {
    handleCommand: vi.fn(handleCommand),
    handleRoute: vi.fn(),
    handleError: vi.fn(),
    handleFix: vi.fn(),
    handleLocationState: vi.fn(),
    close: vi.fn()
  };
}

function locationStub(): PhoneLocationSource {
  return {
    acceptStatus: vi.fn(),
    acceptLocation: vi.fn(() => true),
    latest: vi.fn(),
    waitForUsableFix: vi.fn(async () => undefined),
    close: vi.fn()
  };
}

function command(action: DeviceActionName, commandId = `cmd-${action}`): DeviceCommand {
  return { commandId, action, args: action === "navigation.start" ? { query: "人民广场" } : {} };
}

function resultFor(commandId: string, detail: string): DeviceResultEvent {
  return { type: "device.result", commandId, status: "ok", detail };
}

function route(commandId: string): NavRouteEvent {
  return {
    type: "nav.route",
    commandId,
    destinationName: "人民广场",
    destination: { lat: 31.24, lon: 121.47 },
    distanceMeters: 1_109,
    etaSeconds: 240,
    polyline: [
      { lat: 31.23, lon: 121.47 },
      { lat: 31.24, lon: 121.47 }
    ],
    steps: [{ instruction: "直行", lat: 31.24, lon: 121.47, alongRouteMeters: 1_109 }]
  };
}

const SHARING: PhoneLocationStatusEvent = { type: "phone.location.status", state: "sharing" };

function phoneFix(sequence: number): PhoneLocationEvent {
  return {
    type: "phone.location",
    sequence,
    lat: 31.23 + sequence / 100_000,
    lon: 121.47,
    horizontalAccuracyMeters: 5,
    timestamp: Date.now()
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** What `amixer -c 0 get Playback` prints with the mixer at its ceiling. */
const AMIXER_AT_CEILING = [
  "Simple mixer control 'Playback',0",
  "  Capabilities: pvolume",
  "  Playback channels: Front Left - Front Right",
  "  Limits: Playback 0 - 255",
  "  Mono:",
  "  Front Left: Playback 255 [100%] [0.00dB]",
  "  Front Right: Playback 255 [100%] [0.00dB]",
  ""
].join("\n");

/** The child `spawn("amixer", …)` hands back: prints its output, then closes. */
function amixerChild(stdout: string): EventEmitter & { stdout: EventEmitter } {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
  setImmediate(() => {
    child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", 0);
  });
  return child;
}

describe("routeDeviceCommand", () => {
  it("routes navigation start and stop only through the navigation controller", async () => {
    const navigation = navigationStub(async (input) => resultFor(input.commandId, "navigation"));
    const dispatch = vi.fn(async (input: DeviceCommand) => resultFor(input.commandId, "generic"));

    await expect(
      main.routeDeviceCommand({ command: command("navigation.start"), navigation, dispatch })
    ).resolves.toMatchObject({ detail: "navigation" });
    await expect(
      main.routeDeviceCommand({ command: command("navigation.stop"), navigation, dispatch })
    ).resolves.toMatchObject({ detail: "navigation" });

    expect(navigation.handleCommand).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps every non-navigation action on the generic dispatcher", async () => {
    const navigation = navigationStub(async (input) => resultFor(input.commandId, "navigation"));
    const dispatch = vi.fn(async (input: DeviceCommand) => resultFor(input.commandId, input.action));
    const actions = (Object.keys(DEVICE_ACTION_TIERS) as DeviceActionName[]).filter(
      (action) => action !== "navigation.start" && action !== "navigation.stop"
    );

    for (const action of actions) {
      await expect(main.routeDeviceCommand({ command: command(action), navigation, dispatch })).resolves.toMatchObject({
        commandId: `cmd-${action}`,
        detail: action
      });
    }

    expect(dispatch).toHaveBeenCalledTimes(actions.length);
    expect(navigation.handleCommand).not.toHaveBeenCalled();
  });

  it("always resolves one truthful failure when either selected dependency throws or rejects", async () => {
    const throwingNavigation = navigationStub((() => {
      throw new Error("controller closed");
    }) as (input: DeviceCommand) => Promise<DeviceResultEvent>);
    const rejectedDispatch = vi.fn(async () => {
      throw new Error("sidecar gone");
    });

    await expect(
      main.routeDeviceCommand({
        command: command("navigation.start", "nav-fail"),
        navigation: throwingNavigation,
        dispatch: vi.fn()
      })
    ).resolves.toEqual({ type: "device.result", commandId: "nav-fail", status: "failed" });
    await expect(
      main.routeDeviceCommand({
        command: command("camera.photo", "camera-fail"),
        navigation: throwingNavigation,
        dispatch: rejectedDispatch
      })
    ).resolves.toEqual({ type: "device.result", commandId: "camera-fail", status: "failed" });
  });
});

describe("routeAgentNavigationEvent", () => {
  it("routes each navigation and phone event to exactly one owner", () => {
    const location = locationStub();
    const navigation = navigationStub(async (input) => resultFor(input.commandId, "navigation"));
    const navRoute = route("route-1");
    const navError: AgentEvent = { type: "nav.error", commandId: "route-2", code: "route.unavailable" };
    const fix = phoneFix(1);

    expect(main.routeAgentNavigationEvent(navRoute, location, navigation)).toBe(true);
    expect(main.routeAgentNavigationEvent(navError, location, navigation)).toBe(true);
    expect(main.routeAgentNavigationEvent(fix, location, navigation)).toBe(true);
    expect(main.routeAgentNavigationEvent(SHARING, location, navigation)).toBe(true);

    expect(navigation.handleRoute).toHaveBeenCalledOnce();
    expect(navigation.handleRoute).toHaveBeenCalledWith(navRoute);
    expect(navigation.handleError).toHaveBeenCalledOnce();
    expect(navigation.handleError).toHaveBeenCalledWith(navError);
    expect(location.acceptLocation).toHaveBeenCalledOnce();
    expect(location.acceptLocation).toHaveBeenCalledWith(fix);
    expect(location.acceptStatus).toHaveBeenCalledOnce();
    expect(location.acceptStatus).toHaveBeenCalledWith(SHARING);
  });

  it("returns false for unrelated events and contains synchronous throws and reentrancy", () => {
    const location = locationStub();
    const navigation = navigationStub(async (input) => resultFor(input.commandId, "navigation"));
    const unrelated: AgentEvent = { type: "error", message: "not navigation" };

    expect(main.routeAgentNavigationEvent(unrelated, location, navigation)).toBe(false);
    expect(location.acceptLocation).not.toHaveBeenCalled();
    expect(location.acceptStatus).not.toHaveBeenCalled();
    expect(navigation.handleRoute).not.toHaveBeenCalled();
    expect(navigation.handleError).not.toHaveBeenCalled();

    location.acceptLocation = vi.fn(() => {
      throw new Error("closed during callback");
    });
    expect(() => main.routeAgentNavigationEvent(phoneFix(2), location, navigation)).not.toThrow();
    expect(main.routeAgentNavigationEvent(phoneFix(3), location, navigation)).toBe(true);

    const order: string[] = [];
    const reentrantLocation = locationStub();
    const reentrantNavigation = navigationStub(async (input) => resultFor(input.commandId, "navigation"));
    reentrantNavigation.handleError = vi.fn(() => order.push("nav.error"));
    reentrantLocation.acceptStatus = vi.fn(() => {
      order.push("status:start");
      expect(
        main.routeAgentNavigationEvent(
          { type: "nav.error", commandId: "reentrant", code: "route.unavailable" },
          reentrantLocation,
          reentrantNavigation
        )
      ).toBe(true);
      order.push("status:end");
    });
    expect(main.routeAgentNavigationEvent(SHARING, reentrantLocation, reentrantNavigation)).toBe(true);
    expect(order).toEqual(["status:start", "nav.error", "status:end"]);
  });
});

describe("start navigation lifecycle wiring", () => {
  it("keeps relay PCM rankless and gives navigation the live shared ADAS priority gate", () => {
    const handlers = fixtures.relayHandlers!;
    const active = fixtures.controllers.at(-1)!;
    const pcm = new Int16Array([12, 34]);
    fixtures.playbackWrite.mockClear();
    fixtures.playbackFlush.mockClear();

    handlers.onVoice(pcm);
    expect(fixtures.playbackWrite).toHaveBeenCalledWith(pcm);
    expect(fixtures.playbackWrite.mock.calls[0]).toHaveLength(1);

    fixtures.playbackRank = 1;
    expect(active.canPrompt()).toBe(false);
    fixtures.playbackRank = 2;
    expect(active.canPrompt()).toBe(false);
    fixtures.playbackRank = 0;
    expect(active.canPrompt()).toBe(true);

    active.interruptOrdinaryPlayback();
    expect(fixtures.playbackFlush).toHaveBeenCalledOnce();
    expect(fixtures.playbackFlush.mock.calls[0]).toHaveLength(0);
  });

  it("publishes coordinate-free companion and navigation HUD snapshots in owner order", () => {
    const firstSource = fixtures.sources[0]!;
    const firstController = fixtures.controllers[0]!;
    fixtures.callbackOrder.length = 0;
    const before = fixtures.hudPublishes.length;
    firstSource.emitState({
      connection: "sharing",
      usable: true,
      horizontalAccuracyMeters: 8,
      ageMs: 500,
      ...({ lat: 31.2304, lon: 121.4737 } as object)
    });

    expect(fixtures.callbackOrder).toEqual(["navigation", "hud", "hud"]);
    expect(fixtures.hudPublishes).toHaveLength(before + 2);
    expect(fixtures.hudPublishes.at(-1)).toMatchObject({
      companion: {
        paired: false,
        locationState: "sharing",
        horizontalAccuracyMeters: 8,
        lastFixAgeMs: 500
      }
    });
    expect(JSON.stringify(fixtures.hudPublishes.at(-1))).not.toMatch(/31\.2304|121\.4737/);

    firstController.emitState({
      phase: "guiding",
      destinationName: "人民广场",
      instruction: "前方右转",
      remainingMeters: 2_000,
      remainingSeconds: 300
    });
    expect(fixtures.hudPublishes.at(-1)).toMatchObject({ navigation: { phase: "guiding" } });
    firstController.emitState({ phase: "idle" });
    expect(fixtures.hudPublishes.at(-1)).toMatchObject({ navigation: null });
  });

  it("keeps ordinary pairing and status events flowing through the HUD reducer", () => {
    const handlers = fixtures.relayHandlers!;
    handlers.onEvent({ type: "companion.pairing", code: "246810", expiresAt: 50_000, paired: false });
    expect(fixtures.hudPublishes.at(-1)).toMatchObject({
      companion: {
        pairingCode: "246810",
        pairingExpiresAt: 50_000,
        paired: false
      }
    });
    handlers.onEvent({ type: "phone.location.status", state: "connected" });
    expect(fixtures.hudPublishes.at(-1)).toMatchObject({
      companion: { locationState: "connected" }
    });
  });

  it("feeds fixes and states, tears a closed session down once, and reconnects with fresh navigation", async () => {
    const handlers = fixtures.relayHandlers;
    expect(handlers).toBeDefined();
    expect(fixtures.sources).toHaveLength(1);
    expect(fixtures.controllers).toHaveLength(1);
    const firstSource = fixtures.sources[0]!;
    const firstController = fixtures.controllers[0]!;

    handlers!.onReady();
    handlers!.onEvent({ type: "phone.location.status", state: "connected" });
    handlers!.onEvent({ type: "phone.location.status", state: "stopped" });
    handlers!.onEvent({ type: "phone.location.status", state: "stale" });
    handlers!.onEvent({ type: "phone.location.status", state: "unpaired" });
    handlers!.onEvent(SHARING);
    handlers!.onEvent(phoneFix(1));
    expect(
      firstController.handleLocationState.mock.calls.map(
        ([state]) => (state as RdkNavigationSnapshot["location"])!.connection
      )
    ).toEqual(expect.arrayContaining(["connected", "stopped", "stale", "unpaired", "sharing"]));
    expect(firstController.handleFix).toHaveBeenCalledOnce();

    handlers!.onEvent({
      type: "device.command",
      commandId: "start-1",
      action: "navigation.start",
      args: { query: "人民广场" },
      tier: "low"
    });
    await flush();
    const firstRequest = fixtures.relayEvents.find(
      (event): event is NavRequestEvent =>
        typeof event === "object" && event !== null && (event as { type?: string }).type === "nav.request"
    );
    expect(firstRequest).toMatchObject({ type: "nav.request", reason: "start", query: "人民广场" });
    handlers!.onEvent(route(firstRequest!.commandId));
    await flush();
    expect(
      fixtures.relayEvents.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: string; commandId?: string }).type === "device.result" &&
          (event as { commandId?: string }).commandId === "start-1"
      )
    ).toEqual([{ type: "device.result", commandId: "start-1", status: "ok" }]);

    handlers!.onEvent({
      type: "device.command",
      commandId: "pending-at-close",
      action: "navigation.start",
      args: { query: "外滩" },
      tier: "low"
    });
    await flush();
    const oldRequests = fixtures.relayEvents.filter(
      (event): event is NavRequestEvent =>
        typeof event === "object" && event !== null && (event as { type?: string }).type === "nav.request"
    );
    const pendingRequest = oldRequests.at(-1)!;
    handlers!.onClosed({ kind: "idle", reason: "idle timeout" });
    handlers!.onClosed({ kind: "idle", reason: "idle timeout" });
    await flush();
    expect(firstController.close).toHaveBeenCalledTimes(1);
    expect(firstSource.close).toHaveBeenCalledTimes(1);
    expect(
      fixtures.relayEvents.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: string; commandId?: string }).type === "device.result" &&
          (event as { commandId?: string }).commandId === "pending-at-close"
      )
    ).toEqual([]);

    handlers!.onReady();
    expect(fixtures.sources).toHaveLength(2);
    expect(fixtures.controllers).toHaveLength(2);
    const secondController = fixtures.controllers[1]!;
    fixtures.playbackRank = 2;
    expect(secondController.canPrompt()).toBe(false);
    fixtures.playbackRank = 0;
    expect(secondController.canPrompt()).toBe(true);
    const publishCountAfterReconnect = fixtures.hudPublishes.length;
    firstSource.emitState({ connection: "stale", usable: false, reason: "stale" });
    firstController.emitState({ phase: "guiding", destinationName: "stale route" });
    expect(fixtures.hudPublishes).toHaveLength(publishCountAfterReconnect);
    const secondStateCount = secondController.states.length;
    firstController.controller.handleRoute(route(pendingRequest.commandId));
    firstController.controller.handleError({
      type: "nav.error",
      commandId: pendingRequest.commandId,
      code: "route.unavailable"
    });
    firstSource.source.acceptStatus(SHARING);
    expect(firstSource.source.acceptLocation(phoneFix(2))).toBe(false);
    expect(secondController.states).toHaveLength(secondStateCount);

    handlers!.onEvent(SHARING);
    handlers!.onEvent(phoneFix(1));
    expect(secondController.handleLocationState).toHaveBeenCalled();
    expect(secondController.handleFix).toHaveBeenCalledOnce();
    expect(secondController.states.at(-1)?.phase).toBe("idle");

    handlers!.onEvent({
      type: "device.command",
      commandId: "start-2",
      action: "navigation.start",
      args: { query: "外滩" },
      tier: "low"
    });
    await flush();
    const freshRequest = fixtures.relayEvents
      .filter(
        (event): event is NavRequestEvent =>
          typeof event === "object" && event !== null && (event as { type?: string }).type === "nav.request"
      )
      .at(-1)!;
    expect(freshRequest.commandId).not.toBe(pendingRequest.commandId);
    handlers!.onEvent(route(freshRequest.commandId));
    await flush();
    expect(
      fixtures.relayEvents.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: string; commandId?: string }).type === "device.result" &&
          (event as { commandId?: string }).commandId === "start-2"
      )
    ).toEqual([{ type: "device.result", commandId: "start-2", status: "ok" }]);

    handlers!.onClosed({ kind: "dropped", reason: "" });
    expect(secondController.close).toHaveBeenCalledTimes(1);
    expect(fixtures.sources[1]!.close).toHaveBeenCalledTimes(1);
    handlers!.onReady();
    expect(fixtures.sources).toHaveLength(3);
    expect(fixtures.controllers).toHaveLength(3);
    const thirdController = fixtures.controllers[2]!;
    fixtures.playbackRank = 1;
    expect(thirdController.canPrompt()).toBe(false);
    fixtures.playbackRank = 0;
    expect(thirdController.canPrompt()).toBe(true);
    handlers!.onEvent(SHARING);
    handlers!.onEvent(phoneFix(1));
    expect(thirdController.handleFix).toHaveBeenCalledOnce();
    expect(thirdController.states.at(-1)?.phase).toBe("idle");
  });

  it("steps the board's playback volume when the relay asks for quieter", async () => {
    // The command extractDeviceCommand sends for "Max, 小声一点". Until the
    // dispatcher read `direction` this came back `failed` every time, and
    // nothing on the board touched the mixer at all.
    fixtures.spawn.mockImplementation((_command: string, args: string[]) =>
      amixerChild(args.includes("get") ? AMIXER_AT_CEILING : "")
    );
    fixtures.relayHandlers!.onEvent({
      type: "device.command",
      commandId: "quieter-1",
      action: "volume.set",
      args: { direction: "down" },
      tier: DEVICE_ACTION_TIERS["volume.set"]
    });
    await vi.waitFor(() =>
      expect(fixtures.relayEvents).toContainEqual({ type: "device.result", commandId: "quieter-1", status: "ok" })
    );
    expect(fixtures.spawn.mock.calls).toEqual([
      ["amixer", ["-c", "0", "get", "Playback"]],
      ["amixer", ["-c", "0", "sset", "Playback", "86%"]]
    ]);
  });

  it("keeps reconnecting after an ordinary drop", () => {
    vi.useFakeTimers();
    try {
      const connects = fixtures.relayConnects;
      fixtures.relayHandlers!.onClosed({ kind: "dropped", reason: "" });
      vi.advanceTimersByTime(1_000);
      expect(fixtures.relayConnects).toBe(connects + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops for good on a close the relay would repeat, and says why", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const connects = fixtures.relayConnects;
      fixtures.gateOpen = true;
      fixtures.relayHandlers!.onClosed({ kind: "usage-limit", reason: "usage limit reached" });
      // Speech is what brings an idle helmet back. It must not bring this one
      // back: the relay refuses every new session until the minutes are restored.
      fixtures.captureOnFrame!(new Int16Array(320));
      vi.advanceTimersByTime(2_000);
      expect(fixtures.relayConnects).toBe(connects);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("[relay] voice minutes used up (usage limit reached)"));
      expect(fixtures.hudPublishes.at(-1)).toMatchObject({
        lastError: expect.stringContaining("the agent is not reconnecting: restart max-agent once it has")
      });
    } finally {
      vi.useRealTimers();
      log.mockRestore();
    }
    // Leave a live session for the shutdown test below.
    fixtures.relayHandlers!.onReady();
  });

  it("puts the relay's own reason on the HUD when it refuses this board", () => {
    fixtures.relayHandlers!.onClosed({ kind: "credentials", reason: "session expired" });
    const expected =
      "the relay refused this device's credentials: session expired; the same ones would be refused again, so the agent is not retrying; " +
      "sort out what the reason names, then restart max-agent; this board's own credential is MAX_RELAY_TOKEN in /etc/max/agent.env";
    expect(fixtures.hudPublishes.at(-1)).toMatchObject({ lastError: expected });
    fixtures.relayHandlers!.onReady();
  });

  it("process shutdown closes the live source and controller exactly once", () => {
    const currentSource = fixtures.sources.at(-1)!;
    const currentController = fixtures.controllers.at(-1)!;
    const shutdown = fixtures.signalHandlers.get("SIGTERM");
    expect(shutdown).toBeDefined();

    shutdown!();
    fixtures.relayHandlers!.onClosed({ kind: "intentional", reason: "" });

    expect(currentController.close).toHaveBeenCalledTimes(1);
    expect(currentSource.close).toHaveBeenCalledTimes(1);
    expect(fixtures.captureStop).toHaveBeenCalledOnce();
    expect(fixtures.playbackStop).toHaveBeenCalledOnce();
    expect(fixtures.hudClose).toHaveBeenCalledOnce();
    expect(fixtures.relayDisconnects).toBe(1);
  });
});
