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
import type { RelayHandlers } from "../rdk/agent/src/relay";

const fixtures = vi.hoisted(() => ({
  relayHandlers: undefined as RelayHandlers | undefined,
  relayEvents: [] as unknown[],
  relayConnects: 0,
  relayDisconnects: 0,
  sources: [] as Array<{ source: PhoneLocationSource; close: ReturnType<typeof vi.fn> }>,
  controllers: [] as Array<{
    controller: RdkNavigationController;
    close: ReturnType<typeof vi.fn>;
    handleFix: ReturnType<typeof vi.fn>;
    handleLocationState: ReturnType<typeof vi.fn>;
    states: RdkNavigationSnapshot[];
  }>,
  captureStop: vi.fn(),
  playbackStop: vi.fn(),
  playbackFlush: vi.fn(),
  hudClose: vi.fn(),
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
  createCapture: () => ({ start: vi.fn(), stop: fixtures.captureStop })
}));

vi.mock("../rdk/agent/src/audio/playback", () => ({
  createPlayback: () => ({
    write: vi.fn(),
    flush: fixtures.playbackFlush,
    holdPriority: vi.fn(),
    releasePriority: vi.fn(),
    stop: fixtures.playbackStop
  })
}));

vi.mock("../rdk/agent/src/audio/reference", () => ({
  createReferenceSink: () => ({ write: vi.fn(), flush: vi.fn(), close: vi.fn() })
}));

vi.mock("../rdk/agent/src/audio/voice-gate", () => ({ createVoiceGate: () => () => false }));
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
  createHudServer: () => ({ publish: vi.fn(), close: fixtures.hudClose })
}));
vi.mock("../rdk/agent/src/watchdog", () => ({ startHeartbeat: vi.fn() }));

vi.mock("../rdk/agent/src/relay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rdk/agent/src/relay")>();
  return {
    ...actual,
    createRelayClient: (_config: unknown, _deviceId: string, handlers: RelayHandlers) => {
      fixtures.relayHandlers = handlers;
      return {
        connect: () => {
          fixtures.relayConnects += 1;
        },
        disconnect: () => {
          fixtures.relayDisconnects += 1;
        },
        sendFrame: vi.fn(),
        sendEvent: (event: unknown) => fixtures.relayEvents.push(event),
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
      fixtures.sources.push({ source, close });
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
      const handleLocationState = vi.fn(originalHandleLocationState);
      controller.close = close;
      controller.handleFix = handleFix;
      controller.handleLocationState = handleLocationState;
      fixtures.controllers.push({ controller, close, handleFix, handleLocationState, states });
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

describe.sequential("start navigation lifecycle wiring", () => {
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
    handlers!.onClosed(true);
    handlers!.onClosed(true);
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
    ).toEqual([
      {
        type: "device.result",
        commandId: "pending-at-close",
        status: "failed",
        reason: "navigation.cancelled"
      }
    ]);

    handlers!.onReady();
    expect(fixtures.sources).toHaveLength(2);
    expect(fixtures.controllers).toHaveLength(2);
    const secondController = fixtures.controllers[1]!;
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

    handlers!.onClosed(false);
    expect(secondController.close).toHaveBeenCalledTimes(1);
    expect(fixtures.sources[1]!.close).toHaveBeenCalledTimes(1);
    handlers!.onReady();
    expect(fixtures.sources).toHaveLength(3);
    expect(fixtures.controllers).toHaveLength(3);
    const thirdController = fixtures.controllers[2]!;
    handlers!.onEvent(SHARING);
    handlers!.onEvent(phoneFix(1));
    expect(thirdController.handleFix).toHaveBeenCalledOnce();
    expect(thirdController.states.at(-1)?.phase).toBe("idle");
  });

  it("process shutdown closes the live source and controller exactly once", () => {
    const currentSource = fixtures.sources.at(-1)!;
    const currentController = fixtures.controllers.at(-1)!;
    const shutdown = fixtures.signalHandlers.get("SIGTERM");
    expect(shutdown).toBeDefined();

    shutdown!();
    fixtures.relayHandlers!.onClosed(true);

    expect(currentController.close).toHaveBeenCalledTimes(1);
    expect(currentSource.close).toHaveBeenCalledTimes(1);
    expect(fixtures.captureStop).toHaveBeenCalledOnce();
    expect(fixtures.playbackStop).toHaveBeenCalledOnce();
    expect(fixtures.hudClose).toHaveBeenCalledOnce();
    expect(fixtures.relayDisconnects).toBe(1);
  });
});
