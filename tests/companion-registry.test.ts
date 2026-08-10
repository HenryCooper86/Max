import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanionClientEvent, CompanionServerEvent } from "../shared/companion";
import type { CompanionPairingEvent, PhoneLocationEvent, PhoneLocationStatusEvent } from "../shared/agent";
import { createCompanionBindingStore, type CompanionBindingStore } from "../server/companion-store";
import {
  createCompanionRegistry,
  type CompanionConnection,
  type CompanionRegistry
} from "../server/companion-registry";

type HelmetEvent = CompanionPairingEvent | PhoneLocationEvent | PhoneLocationStatusEvent;

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function gatedBindingStore() {
  const base = createCompanionBindingStore({ filePath: null });
  const bindEntered = deferred();
  const bindGate = deferred();
  const unbindGate = deferred();
  let unbindStarted = false;
  const store: CompanionBindingStore = {
    ...base,
    async bind(accountId, deviceId, now) {
      bindEntered.resolve();
      await bindGate.promise;
      return base.bind(accountId, deviceId, now);
    },
    async unbindAccount(accountId) {
      unbindStarted = true;
      await unbindGate.promise;
      return base.unbindAccount(accountId);
    }
  };
  return {
    base,
    store,
    bindEntered: bindEntered.promise,
    releaseBind: bindGate.resolve,
    releaseUnbind: unbindGate.resolve,
    unbindStarted: () => unbindStarted
  };
}

type Harness = {
  registry: CompanionRegistry;
  store: CompanionBindingStore;
  logs: string[];
  now(): number;
  advance(milliseconds: number): void;
  helmet(deviceId: string, deviceLabel?: string): { events: HelmetEvent[]; detach(): void };
  phone(accountId: string, address?: string): { events: CompanionServerEvent[]; connection: CompanionConnection };
};

const openRegistries: CompanionRegistry[] = [];

function harness(
  options: {
    store?: CompanionBindingStore;
    codes?: string[];
    now?: number;
    minFixIntervalMs?: number;
  } = {}
): Harness {
  let currentTime = options.now ?? 1_000_000;
  const codes = [...(options.codes ?? ["123456", "234567", "345678", "456789", "567890", "678901"])];
  const store = options.store ?? createCompanionBindingStore({ filePath: null, now: () => currentTime });
  const logs: string[] = [];
  const registry = createCompanionRegistry({
    store,
    now: () => currentTime,
    randomCode: () => codes.shift() ?? "999999",
    minFixIntervalMs: options.minFixIntervalMs ?? 1_000,
    log: {
      info: (message, fields) => logs.push(`${message} ${JSON.stringify(fields ?? {})}`),
      warn: (message, fields) => logs.push(`${message} ${JSON.stringify(fields ?? {})}`)
    }
  });
  openRegistries.push(registry);

  return {
    registry,
    store,
    logs,
    now: () => currentTime,
    advance(milliseconds) {
      currentTime += milliseconds;
      vi.advanceTimersByTime(milliseconds);
    },
    helmet(deviceId, deviceLabel = `Helmet ${deviceId}`) {
      const events: HelmetEvent[] = [];
      const detach = registry.attachHelmet({ deviceId, deviceLabel, send: (event) => events.push(event) });
      return { events, detach };
    },
    phone(accountId, address = "203.0.113.10") {
      const events: CompanionServerEvent[] = [];
      const connection = registry.attachCompanion({ accountId, address, send: (event) => events.push(event) });
      return { events, connection };
    }
  };
}

function latest<T extends { type: string }>(events: T[], type: T["type"]): T | undefined {
  return [...events].reverse().find((event) => event.type === type);
}

function location(
  sequence: number,
  timestamp: number,
  overrides: Partial<CompanionClientEvent> = {}
): CompanionClientEvent {
  return {
    type: "companion.location",
    sequence,
    lat: 31.2304,
    lon: 121.4737,
    horizontalAccuracyMeters: 7,
    timestamp,
    ...overrides
  } as CompanionClientEvent;
}

async function pairAndStart(h: Harness, code = "123456", accountId = "acct-a", deviceId = "rdk-a") {
  const helmet = h.helmet(deviceId);
  const phone = h.phone(accountId);
  await phone.connection.handle({ type: "companion.pair", code });
  await phone.connection.handle({ type: "companion.start" });
  return { helmet, phone };
}

afterEach(async () => {
  await Promise.all(openRegistries.splice(0).map((registry) => registry.close()));
  vi.useRealTimers();
});

describe("companion registry pairing lifecycle", () => {
  it("issues a six-digit single-use code that expires after five minutes", async () => {
    vi.useFakeTimers();
    const h = harness({ codes: ["123456", "234567"] });
    const helmet = h.helmet("rdk-a", "Road helmet");
    const firstPairing = helmet.events[0];
    expect(firstPairing).toEqual({
      type: "companion.pairing",
      code: "123456",
      expiresAt: 1_300_000,
      paired: false
    });
    expect(firstPairing && "code" in firstPairing ? firstPairing.code : "").toMatch(/^\d{6}$/);

    const wrongPhone = h.phone("acct-wrong");
    await wrongPhone.connection.handle({ type: "companion.pair", code: "000000" });
    expect(wrongPhone.events.at(-1)).toMatchObject({ type: "companion.error", code: "pair.code" });

    h.advance(300_001);
    const latePhone = h.phone("acct-late", "203.0.113.11");
    await latePhone.connection.handle({ type: "companion.pair", code: "123456" });
    expect(latePhone.events.at(-1)).toMatchObject({ type: "companion.error", code: "pair.code" });

    helmet.detach();
    const replacement = h.helmet("rdk-a");
    expect(replacement.events[0]).toMatchObject({ type: "companion.pairing", code: "234567" });
    const phone = h.phone("acct-a", "203.0.113.12");
    await phone.connection.handle({ type: "companion.pair", code: "234567" });
    expect(h.store.bindingForAccount("acct-a")?.deviceId).toBe("rdk-a");

    await phone.connection.handle({ type: "companion.unpair" });
    const reuse = h.phone("acct-b", "203.0.113.13");
    await reuse.connection.handle({ type: "companion.pair", code: "234567" });
    expect(reuse.events.at(-1)).toMatchObject({ type: "companion.error", code: "pair.code" });
  });

  it("keeps an unexpired code valid when the same unpaired helmet reconnects", async () => {
    vi.useFakeTimers();
    const h = harness({ codes: ["123456", "234567"] });
    const firstHelmet = h.helmet("rdk-a", "Road helmet");
    h.advance(30_000);

    const replacement = h.helmet("rdk-a", "Reconnected helmet");
    firstHelmet.detach();

    expect(replacement.events[0]).toEqual({
      type: "companion.pairing",
      code: "123456",
      expiresAt: 1_300_000,
      paired: false
    });

    const phone = h.phone("acct-a");
    await phone.connection.handle({ type: "companion.pair", code: "123456" });

    expect(h.store.bindingForAccount("acct-a")?.deviceId).toBe("rdk-a");
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.status", state: "ready" });
    expect(latest(replacement.events, "companion.pairing")).toMatchObject({
      type: "companion.pairing",
      code: "123456",
      paired: true
    });
  });

  it("keeps a detach-first reconnect code stable without accepting it while the helmet is offline", async () => {
    vi.useFakeTimers();
    const h = harness({ codes: ["123456", "234567"] });
    const firstHelmet = h.helmet("rdk-a", "Road helmet");
    h.advance(30_000);
    firstHelmet.detach();

    const phone = h.phone("acct-a");
    await phone.connection.handle({ type: "companion.pair", code: "123456" });
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.error", code: "pair.helmetOffline" });
    expect(h.store.bindingForAccount("acct-a")).toBeUndefined();

    const replacement = h.helmet("rdk-a", "Reconnected helmet");
    expect(replacement.events[0]).toEqual({
      type: "companion.pairing",
      code: "123456",
      expiresAt: 1_300_000,
      paired: false
    });

    await phone.connection.handle({ type: "companion.pair", code: "123456" });
    expect(h.store.bindingForAccount("acct-a")?.deviceId).toBe("rdk-a");
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.status", state: "ready" });
  });

  it("rotates an unexpired code when an already-paired helmet reconnects", async () => {
    const h = harness({ codes: ["123456", "234567", "345678"] });
    h.helmet("rdk-a", "Road helmet");
    const phone = h.phone("acct-a");
    await phone.connection.handle({ type: "companion.pair", code: "123456" });

    const firstReplacement = h.helmet("rdk-a", "First replacement");
    expect(firstReplacement.events[0]).toEqual({
      type: "companion.pairing",
      code: "234567",
      expiresAt: 1_300_000,
      paired: true
    });

    const secondReplacement = h.helmet("rdk-a", "Second replacement");
    expect(secondReplacement.events[0]).toEqual({
      type: "companion.pairing",
      code: "345678",
      expiresAt: 1_300_000,
      paired: true
    });
  });

  it("limits failed pairing attempts independently by account and network address", async () => {
    const byAccount = harness({ codes: ["123456"] });
    byAccount.helmet("rdk-a");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const phone = byAccount.phone("acct-a", `203.0.113.${10 + attempt}`);
      await phone.connection.handle({ type: "companion.pair", code: "000000" });
    }
    const accountBlocked = byAccount.phone("acct-a", "203.0.113.99");
    await accountBlocked.connection.handle({ type: "companion.pair", code: "123456" });
    expect(accountBlocked.events.at(-1)).toMatchObject({ type: "companion.error", code: "pair.attempts" });
    expect(byAccount.store.bindingForAccount("acct-a")).toBeUndefined();

    const byAddress = harness({ codes: ["654321"] });
    byAddress.helmet("rdk-b");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const phone = byAddress.phone(`acct-${attempt}`, "198.51.100.8");
      await phone.connection.handle({ type: "companion.pair", code: "000000" });
    }
    const addressBlocked = byAddress.phone("acct-final", "198.51.100.8");
    await addressBlocked.connection.handle({ type: "companion.pair", code: "654321" });
    expect(addressBlocked.events.at(-1)).toMatchObject({ type: "companion.error", code: "pair.attempts" });
    expect(byAddress.store.bindingForDevice("rdk-b")).toBeUndefined();
  });

  it("retains the code and prior authority when durable binding fails", async () => {
    const durable = createCompanionBindingStore({ filePath: null });
    await durable.bind("acct-old", "rdk-old", 10);
    let failNextBind = true;
    const store: CompanionBindingStore = {
      ...durable,
      async bind(accountId, deviceId, now) {
        if (failNextBind) {
          failNextBind = false;
          throw new Error("disk unavailable");
        }
        return durable.bind(accountId, deviceId, now);
      }
    };
    const h = harness({ store, codes: ["123456", "234567"] });
    const oldHelmet = h.helmet("rdk-old");
    const targetHelmet = h.helmet("rdk-new");
    const phone = h.phone("acct-new");

    await phone.connection.handle({ type: "companion.pair", code: "234567" });
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.error", code: "pair.persistence" });
    expect(durable.bindingForAccount("acct-old")?.deviceId).toBe("rdk-old");
    expect(durable.bindingForAccount("acct-new")).toBeUndefined();
    expect(latest(oldHelmet.events, "phone.location.status")).toBeUndefined();
    expect(targetHelmet.events.filter((event) => event.type === "companion.pairing")).toHaveLength(1);

    await phone.connection.handle({ type: "companion.pair", code: "234567" });
    expect(durable.bindingForAccount("acct-new")?.deviceId).toBe("rdk-new");
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.status", state: "ready", deviceId: "rdk-new" });
  });

  it("reconciles a durable binding when phone and helmet reconnect in either order", async () => {
    const phoneFirstStore = createCompanionBindingStore({ filePath: null });
    await phoneFirstStore.bind("acct-a", "rdk-a", 1);
    const phoneFirst = harness({ store: phoneFirstStore });
    const phone = phoneFirst.phone("acct-a");
    expect(phone.events.at(-1)).toEqual({
      type: "companion.status",
      state: "helmetOffline",
      deviceId: "rdk-a"
    });
    const helmet = phoneFirst.helmet("rdk-a", "Road helmet");
    expect(phone.events.at(-1)).toEqual({
      type: "companion.status",
      state: "ready",
      deviceId: "rdk-a",
      deviceLabel: "Road helmet"
    });
    expect(latest(helmet.events, "phone.location.status")).toEqual({
      type: "phone.location.status",
      state: "connected"
    });

    const helmetFirstStore = createCompanionBindingStore({ filePath: null });
    await helmetFirstStore.bind("acct-b", "rdk-b", 1);
    const helmetFirst = harness({ store: helmetFirstStore });
    const secondHelmet = helmetFirst.helmet("rdk-b", "City helmet");
    expect(secondHelmet.events[0]).toMatchObject({ type: "companion.pairing", paired: true });
    const secondPhone = helmetFirst.phone("acct-b");
    expect(secondPhone.events.at(-1)).toEqual({
      type: "companion.status",
      state: "ready",
      deviceId: "rdk-b",
      deviceLabel: "City helmet"
    });
    expect(latest(secondHelmet.events, "phone.location.status")).toEqual({
      type: "phone.location.status",
      state: "connected"
    });
  });

  it("notifies both sides displaced by a one-to-one rebind", async () => {
    const store = createCompanionBindingStore({ filePath: null });
    await store.bind("acct-a", "rdk-a", 1);
    await store.bind("acct-b", "rdk-b", 2);
    const h = harness({ store, codes: ["111111", "222222", "333333"] });
    const helmetA = h.helmet("rdk-a");
    const helmetB = h.helmet("rdk-b");
    const phoneA = h.phone("acct-a", "203.0.113.10");
    const phoneB = h.phone("acct-b", "203.0.113.11");

    await phoneA.connection.handle({ type: "companion.pair", code: "222222" });

    expect(store.bindingForAccount("acct-a")?.deviceId).toBe("rdk-b");
    expect(store.bindingForAccount("acct-b")).toBeUndefined();
    expect(phoneB.events.at(-1)).toMatchObject({ type: "companion.status", state: "unpaired" });
    expect(latest(helmetA.events, "phone.location.status")).toEqual({
      type: "phone.location.status",
      state: "unpaired"
    });
    expect(latest(helmetA.events, "companion.pairing")).toMatchObject({ paired: false, code: "333333" });
    expect(phoneA.events.at(-1)).toMatchObject({ type: "companion.status", state: "ready", deviceId: "rdk-b" });
    expect(latest(helmetB.events, "companion.pairing")).toMatchObject({ paired: true });
  });
});

describe("companion registry sharing lifecycle", () => {
  it("starts, stops, and unpairs without allowing an old stale timer to fire", async () => {
    vi.useFakeTimers();
    const h = harness({ codes: ["123456", "234567"] });
    const { helmet, phone } = await pairAndStart(h);
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.status", state: "sharing" });
    expect(latest(helmet.events, "phone.location.status")).toEqual({ type: "phone.location.status", state: "sharing" });

    await phone.connection.handle(location(1, h.now()));
    await phone.connection.handle({ type: "companion.stop" });
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.status", state: "ready" });
    expect(latest(helmet.events, "phone.location.status")).toEqual({ type: "phone.location.status", state: "stopped" });
    h.advance(10_001);
    expect(
      helmet.events.filter((event) => event.type === "phone.location.status" && event.state === "stale")
    ).toHaveLength(0);

    await phone.connection.handle({ type: "companion.start" });
    await phone.connection.handle(location(2, h.now()));
    await phone.connection.handle({ type: "companion.unpair" });
    expect(h.store.bindingForAccount("acct-a")).toBeUndefined();
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.status", state: "unpaired" });
    expect(latest(helmet.events, "phone.location.status")).toEqual({
      type: "phone.location.status",
      state: "unpaired"
    });
    expect(latest(helmet.events, "companion.pairing")).toMatchObject({ paired: false, code: "234567" });
    h.advance(10_001);
    expect(
      helmet.events.filter((event) => event.type === "phone.location.status" && event.state === "stale")
    ).toHaveLength(0);
  });

  it("cancels sharing on phone detach and reconnects without replaying a fix", async () => {
    vi.useFakeTimers();
    const h = harness();
    const { helmet, phone } = await pairAndStart(h);
    await phone.connection.handle(location(1, h.now()));
    const locationCount = helmet.events.filter((event) => event.type === "phone.location").length;

    phone.connection.detach();
    expect(latest(helmet.events, "phone.location.status")).toEqual({ type: "phone.location.status", state: "stopped" });
    h.advance(10_001);
    expect(
      helmet.events.filter((event) => event.type === "phone.location.status" && event.state === "stale")
    ).toHaveLength(0);

    const reconnected = h.phone("acct-a");
    expect(reconnected.events.at(-1)).toMatchObject({ type: "companion.status", state: "ready" });
    expect(helmet.events.filter((event) => event.type === "phone.location")).toHaveLength(locationCount);

    reconnected.connection.detach();
    expect(latest(helmet.events, "phone.location.status")).toEqual({
      type: "phone.location.status",
      state: "stopped"
    });
  });

  it("drops fixes while the helmet is offline and accepts only a new current fix after live reattachment", async () => {
    vi.useFakeTimers();
    const h = harness({ codes: ["123456", "234567"] });
    const { helmet, phone } = await pairAndStart(h);
    await phone.connection.handle(location(1, h.now()));
    helmet.detach();
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.status", state: "helmetOffline" });

    h.advance(1_000);
    await phone.connection.handle(location(2, h.now()));
    expect(helmet.events.filter((event) => event.type === "phone.location")).toHaveLength(1);

    const reattached = h.helmet("rdk-a", "Reconnected helmet");
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.status", state: "sharing" });
    expect(latest(reattached.events, "phone.location.status")).toEqual({
      type: "phone.location.status",
      state: "sharing"
    });
    expect(reattached.events.filter((event) => event.type === "phone.location")).toHaveLength(0);
    await phone.connection.handle(location(3, h.now()));
    expect(reattached.events.at(-1)).toMatchObject({ type: "phone.location", sequence: 3 });
  });

  it("forwards accepted fixes only to the bound live helmet and never persists private pairing or location data", async () => {
    const h = harness();
    const bound = h.helmet("rdk-a");
    const other = h.helmet("rdk-b");
    const phone = h.phone("acct-a");
    await phone.connection.handle({ type: "companion.pair", code: "123456" });
    await phone.connection.handle({ type: "companion.start" });
    await phone.connection.handle(location(1, h.now(), { courseDegrees: 90, speedMps: 12 }));

    expect(bound.events.at(-1)).toEqual({
      type: "phone.location",
      sequence: 1,
      lat: 31.2304,
      lon: 121.4737,
      horizontalAccuracyMeters: 7,
      timestamp: 1_000_000,
      courseDegrees: 90,
      speedMps: 12
    });
    expect(other.events.some((event) => event.type === "phone.location")).toBe(false);
    const durableBinding = JSON.stringify(h.store.bindingForAccount("acct-a"));
    expect(durableBinding).not.toContain("123456");
    expect(durableBinding).not.toContain("31.2304");
    expect(h.logs.join(" ")).not.toContain("123456");
    expect(h.logs.join(" ")).not.toContain("121.4737");
  });

  it("rejects fixes outside sharing, sequence, rate, timestamp, coordinate, accuracy, course, and speed gates", async () => {
    vi.useFakeTimers();
    const h = harness();
    const helmet = h.helmet("rdk-a");
    const phone = h.phone("acct-a");
    await phone.connection.handle({ type: "companion.pair", code: "123456" });

    await phone.connection.handle(location(1, h.now()));
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.error", code: "location.state" });
    await phone.connection.handle({ type: "companion.start" });
    await phone.connection.handle(location(1, h.now()));
    expect(helmet.events.at(-1)).toMatchObject({ type: "phone.location", sequence: 1 });

    h.advance(100);
    await phone.connection.handle(location(2, h.now()));
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.error", code: "location.rate" });
    h.advance(900);
    await phone.connection.handle(location(1, h.now()));
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.error", code: "location.sequence" });

    const rejected: Array<[CompanionClientEvent, string]> = [
      [location(2, h.now() - 10_001), "location.timestamp"],
      [location(2, h.now() + 2_001), "location.timestamp"],
      [location(2, h.now(), { lat: 90.1 }), "location.coordinates"],
      [location(2, h.now(), { lon: -180.1 }), "location.coordinates"],
      [location(2, h.now(), { horizontalAccuracyMeters: 50.1 }), "location.accuracy"],
      [location(2, h.now(), { courseDegrees: 360.1 }), "location.course"],
      [location(2, h.now(), { speedMps: -0.1 }), "location.speed"]
    ];
    for (const [event, code] of rejected) {
      await phone.connection.handle(event);
      expect(phone.events.at(-1)).toMatchObject({ type: "companion.error", code });
    }

    await phone.connection.handle(location(2, h.now(), { speedMps: 100.1 }));
    expect(helmet.events.at(-1)).toMatchObject({ type: "phone.location", sequence: 2, speedMps: 100.1 });
  });

  it("treats same-device helmet replacement as a detach and never carries a stale timer across sockets", async () => {
    vi.useFakeTimers();
    const h = harness({ codes: ["123456", "234567"] });
    const { helmet: firstHelmet, phone } = await pairAndStart(h);
    await phone.connection.handle(location(1, h.now()));

    const replacement = h.helmet("rdk-a", "Replacement helmet");
    firstHelmet.detach();
    h.advance(10_001);

    expect(
      replacement.events.filter((event) => event.type === "phone.location.status" && event.state === "stale")
    ).toHaveLength(0);
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.status", state: "sharing" });
  });

  it("emits stale exactly ten seconds after the accepted fix timestamp, not receipt", async () => {
    vi.useFakeTimers();
    const h = harness();
    const { helmet, phone } = await pairAndStart(h);

    await phone.connection.handle(location(1, h.now() - 4_000));
    h.advance(5_999);
    expect(
      helmet.events.filter((event) => event.type === "phone.location.status" && event.state === "stale")
    ).toHaveLength(0);
    h.advance(1);
    expect(latest(helmet.events, "phone.location.status")).toEqual({ type: "phone.location.status", state: "stale" });
  });

  it("cancels stale work when the registry closes", async () => {
    vi.useFakeTimers();
    const h = harness();
    const { helmet, phone } = await pairAndStart(h);
    await phone.connection.handle(location(1, h.now()));

    await h.registry.close();
    h.advance(10_001);

    expect(
      helmet.events.filter((event) => event.type === "phone.location.status" && event.state === "stale")
    ).toHaveLength(0);
  });
});

describe("companion registry concurrent lifecycle reconciliation", () => {
  it("orders a later unpair after an in-flight pair for the same account", async () => {
    const gated = gatedBindingStore();
    const h = harness({ store: gated.store, codes: ["123456", "234567"] });
    const helmet = h.helmet("rdk-a");
    const phone = h.phone("acct-a");

    const pair = phone.connection.handle({ type: "companion.pair", code: "123456" });
    await gated.bindEntered;
    const unpair = phone.connection.handle({ type: "companion.unpair" });
    gated.releaseBind();
    await pair;
    await Promise.resolve();
    const unbindStartedAfterPair = gated.unbindStarted();
    gated.releaseUnbind();
    await unpair;

    expect(unbindStartedAfterPair).toBe(true);
    expect(gated.base.bindingForAccount("acct-a")).toBeUndefined();
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.status", state: "unpaired" });
    expect(latest(helmet.events, "phone.location.status")).toEqual({
      type: "phone.location.status",
      state: "unpaired"
    });
  });

  it("reconciles pair completion to a replacement phone generation", async () => {
    const gated = gatedBindingStore();
    const h = harness({ store: gated.store });
    const helmet = h.helmet("rdk-a");
    const first = h.phone("acct-a");

    const pair = first.connection.handle({ type: "companion.pair", code: "123456" });
    await gated.bindEntered;
    const firstEventCount = first.events.length;
    const replacement = h.phone("acct-a");
    gated.releaseBind();
    await pair;

    expect(gated.base.bindingForAccount("acct-a")?.deviceId).toBe("rdk-a");
    expect(first.events).toHaveLength(firstEventCount);
    expect(replacement.events.at(-1)).toMatchObject({
      type: "companion.status",
      state: "ready",
      deviceId: "rdk-a"
    });
    expect(latest(helmet.events, "phone.location.status")).toEqual({
      type: "phone.location.status",
      state: "connected"
    });
  });

  it("finishes an in-flight pair after phone detach without reviving that phone generation", async () => {
    const gated = gatedBindingStore();
    const h = harness({ store: gated.store });
    const helmet = h.helmet("rdk-a");
    const phone = h.phone("acct-a");

    const pair = phone.connection.handle({ type: "companion.pair", code: "123456" });
    await gated.bindEntered;
    const eventCount = phone.events.length;
    phone.connection.detach();
    gated.releaseBind();
    await pair;

    expect(gated.base.bindingForAccount("acct-a")?.deviceId).toBe("rdk-a");
    expect(phone.events).toHaveLength(eventCount);
    expect(latest(helmet.events, "companion.pairing")).toMatchObject({ paired: true });
    expect(latest(helmet.events, "phone.location.status")).toEqual({
      type: "phone.location.status",
      state: "stopped"
    });
  });

  it("orders start and location after an in-flight pair", async () => {
    const gated = gatedBindingStore();
    const h = harness({ store: gated.store });
    const helmet = h.helmet("rdk-a");
    const phone = h.phone("acct-a");

    const pair = phone.connection.handle({ type: "companion.pair", code: "123456" });
    await gated.bindEntered;
    const start = phone.connection.handle({ type: "companion.start" });
    const fix = phone.connection.handle(location(1, h.now()));
    gated.releaseBind();
    await Promise.all([pair, start, fix]);

    expect(phone.events.at(-1)).toMatchObject({ type: "companion.status", state: "sharing" });
    expect(phone.events.some((event) => event.type === "companion.error")).toBe(false);
    expect(helmet.events.at(-1)).toMatchObject({ type: "phone.location", sequence: 1 });
  });

  it("waits for in-flight account work on close and suppresses post-close peer notifications", async () => {
    const gated = gatedBindingStore();
    const h = harness({ store: gated.store });
    const helmet = h.helmet("rdk-a");
    const phone = h.phone("acct-a");
    const pair = phone.connection.handle({ type: "companion.pair", code: "123456" });
    await gated.bindEntered;
    const helmetEventCount = helmet.events.length;
    const phoneEventCount = phone.events.length;
    let closeFinished = false;
    const close = h.registry.close().then(() => {
      closeFinished = true;
    });
    await Promise.resolve();
    const closedBeforeBindFinished = closeFinished;

    gated.releaseBind();
    await Promise.all([pair, close]);

    expect(closedBeforeBindFinished).toBe(false);
    expect(gated.base.bindingForAccount("acct-a")?.deviceId).toBe("rdk-a");
    expect(helmet.events).toHaveLength(helmetEventCount);
    expect(phone.events).toHaveLength(phoneEventCount);
  });

  it("uses only the replacement helmet pairing-code generation after an in-flight pair", async () => {
    const gated = gatedBindingStore();
    const h = harness({ store: gated.store, codes: ["123456", "234567"] });
    const firstHelmet = h.helmet("rdk-a");
    const phone = h.phone("acct-a");
    const pair = phone.connection.handle({ type: "companion.pair", code: "123456" });
    await gated.bindEntered;

    const replacement = h.helmet("rdk-a", "Replacement helmet");
    firstHelmet.detach();
    gated.releaseBind();
    await pair;

    expect(
      replacement.events.filter((event): event is CompanionPairingEvent => event.type === "companion.pairing")
    ).toEqual([
      { type: "companion.pairing", code: "234567", expiresAt: 1_300_000, paired: false },
      { type: "companion.pairing", code: "234567", expiresAt: 1_300_000, paired: true }
    ]);
    expect(phone.events.at(-1)).toMatchObject({ type: "companion.status", state: "ready" });
  });
});

describe("companion registry throwing transport isolation", () => {
  it("keeps a successful binding authoritative when the helmet throws during post-bind notification", async () => {
    const h = harness();
    const helmetEvents: HelmetEvent[] = [];
    h.registry.attachHelmet({
      deviceId: "rdk-a",
      deviceLabel: "Throwing helmet",
      send(event) {
        if (event.type === "companion.pairing" && event.paired) throw new Error("helmet transport closed");
        helmetEvents.push(event);
      }
    });
    const phone = h.phone("acct-a");

    await phone.connection.handle({ type: "companion.pair", code: "123456" });

    expect(h.store.bindingForAccount("acct-a")?.deviceId).toBe("rdk-a");
    expect(phone.events.some((event) => event.type === "companion.error" && event.code === "pair.persistence")).toBe(
      false
    );
    expect(phone.events.at(-1)).toMatchObject({
      type: "companion.status",
      state: "helmetOffline",
      deviceId: "rdk-a"
    });
    expect(helmetEvents).toHaveLength(1);
  });

  it("continues helmet reconciliation when the phone throws after a successful bind", async () => {
    const h = harness();
    const helmet = h.helmet("rdk-a");
    const phoneEvents: CompanionServerEvent[] = [];
    const phone = h.registry.attachCompanion({
      accountId: "acct-a",
      address: "203.0.113.10",
      send(event) {
        if (event.type === "companion.status" && event.state === "ready") throw new Error("phone transport closed");
        phoneEvents.push(event);
      }
    });

    await phone.handle({ type: "companion.pair", code: "123456" });

    expect(h.store.bindingForAccount("acct-a")?.deviceId).toBe("rdk-a");
    expect(phoneEvents.some((event) => event.type === "companion.error" && event.code === "pair.persistence")).toBe(
      false
    );
    expect(latest(helmet.events, "companion.pairing")).toMatchObject({ paired: true });
    expect(latest(helmet.events, "phone.location.status")).toEqual({
      type: "phone.location.status",
      state: "stopped"
    });
  });

  it("continues every surviving displacement notification after phone and helmet sends throw", async () => {
    const store = createCompanionBindingStore({ filePath: null });
    await store.bind("acct-a", "rdk-a", 1);
    await store.bind("acct-b", "rdk-b", 2);
    const h = harness({ store, codes: ["111111", "222222", "333333"] });
    h.registry.attachHelmet({
      deviceId: "rdk-a",
      deviceLabel: "Broken old helmet",
      send(event) {
        if (event.type === "phone.location.status" && event.state === "unpaired") {
          throw new Error("old helmet transport closed");
        }
      }
    });
    const targetHelmet = h.helmet("rdk-b");
    const phoneA = h.phone("acct-a", "203.0.113.10");
    h.registry.attachCompanion({
      accountId: "acct-b",
      address: "203.0.113.11",
      send(event) {
        if (event.type === "companion.status" && event.state === "unpaired") {
          throw new Error("displaced phone transport closed");
        }
      }
    });

    await phoneA.connection.handle({ type: "companion.pair", code: "222222" });

    expect(store.bindingForAccount("acct-a")?.deviceId).toBe("rdk-b");
    expect(store.bindingForAccount("acct-b")).toBeUndefined();
    expect(phoneA.events.at(-1)).toMatchObject({ type: "companion.status", state: "ready", deviceId: "rdk-b" });
    expect(latest(targetHelmet.events, "companion.pairing")).toMatchObject({ paired: true });
    expect(latest(targetHelmet.events, "phone.location.status")).toEqual({
      type: "phone.location.status",
      state: "connected"
    });
  });

  it("continues helmet unpair notification when the phone send throws", async () => {
    const store = createCompanionBindingStore({ filePath: null });
    await store.bind("acct-a", "rdk-a", 1);
    const h = harness({ store, codes: ["123456", "234567"] });
    const helmet = h.helmet("rdk-a");
    const phone = h.registry.attachCompanion({
      accountId: "acct-a",
      address: "203.0.113.10",
      send(event) {
        if (event.type === "companion.status" && event.state === "unpaired") {
          throw new Error("phone transport closed");
        }
      }
    });

    await phone.handle({ type: "companion.unpair" });

    expect(store.bindingForAccount("acct-a")).toBeUndefined();
    expect(latest(helmet.events, "phone.location.status")).toEqual({
      type: "phone.location.status",
      state: "unpaired"
    });
    expect(latest(helmet.events, "companion.pairing")).toMatchObject({ paired: false, code: "234567" });
  });

  it("contains a stale-timer helmet throw and reconciles the surviving phone offline", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.registry.attachHelmet({
      deviceId: "rdk-a",
      deviceLabel: "Throwing helmet",
      send(event) {
        if (event.type === "phone.location.status" && event.state === "stale") {
          throw new Error("helmet transport closed");
        }
      }
    });
    const phone = h.phone("acct-a");
    await phone.connection.handle({ type: "companion.pair", code: "123456" });
    await phone.connection.handle({ type: "companion.start" });
    await phone.connection.handle(location(1, h.now()));

    expect(() => h.advance(10_000)).not.toThrow();
    expect(phone.events.at(-1)).toMatchObject({
      type: "companion.status",
      state: "helmetOffline",
      deviceId: "rdk-a"
    });
  });

  it("contains initial peer sends that throw", () => {
    const h = harness();
    expect(() =>
      h.registry.attachHelmet({
        deviceId: "rdk-a",
        deviceLabel: "Throwing helmet",
        send() {
          throw new Error("helmet transport closed");
        }
      })
    ).not.toThrow();
    expect(() =>
      h.registry.attachCompanion({
        accountId: "acct-a",
        address: "203.0.113.10",
        send() {
          throw new Error("phone transport closed");
        }
      })
    ).not.toThrow();
  });
});
