import { randomInt } from "node:crypto";
import type { CompanionPairingEvent, PhoneLocationEvent, PhoneLocationStatusEvent } from "../shared/agent";
import type { CompanionClientEvent, CompanionServerEvent } from "../shared/companion";
import type { CompanionBinding, CompanionBindingStore } from "./companion-store";
import type { Logger } from "./logger";

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

type PairCode = {
  code: string;
  deviceId: string;
  expiresAt: number;
};

type HelmetSession = {
  peer: HelmetPeer;
};

type CompanionSession = {
  peer: CompanionPeer;
  active: boolean;
  sharing: boolean;
  lastSequence: number;
  lastAcceptedAt?: number;
  staleTimer?: ReturnType<typeof setTimeout>;
};

type AttemptBucket = {
  count: number;
  startedAt: number;
};

const DEFAULT_PAIR_LIFETIME_MS = 5 * 60_000;
const DEFAULT_MIN_FIX_INTERVAL_MS = 1_000;
const MAX_PAIR_FAILURES = 5;
const FIX_STALE_MS = 10_000;
const MAX_FUTURE_FIX_MS = 2_000;
const MAX_HORIZONTAL_ACCURACY_METERS = 50;

function defaultRandomCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function validIdentity(value: string): boolean {
  return value.trim().length > 0;
}

function finiteRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

export function createCompanionRegistry(options: {
  store: CompanionBindingStore;
  now?: () => number;
  randomCode?: () => string;
  pairLifetimeMs?: number;
  minFixIntervalMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  log?: Pick<Logger, "info" | "warn">;
}): CompanionRegistry {
  const clock = options.now ?? Date.now;
  const randomCode = options.randomCode ?? defaultRandomCode;
  const pairLifetimeMs = options.pairLifetimeMs ?? DEFAULT_PAIR_LIFETIME_MS;
  const minFixIntervalMs = options.minFixIntervalMs ?? DEFAULT_MIN_FIX_INTERVAL_MS;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const helmets = new Map<string, HelmetSession>();
  const companions = new Map<string, CompanionSession>();
  const pairCodes = new Map<string, PairCode>();
  const codeByDevice = new Map<string, string>();
  const pendingPairCodes = new Set<string>();
  const accountAttempts = new Map<string, AttemptBucket>();
  const addressAttempts = new Map<string, AttemptBucket>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  function sendError(session: CompanionSession, code: string, detail: string): void {
    if (!session.active) return;
    session.peer.send({ type: "companion.error", code, detail });
    options.log?.warn("companion request rejected", {
      accountId: session.peer.accountId,
      address: session.peer.address,
      reason: code
    });
  }

  function cancelStale(session: CompanionSession): void {
    if (session.staleTimer === undefined) return;
    clearTimer(session.staleTimer);
    session.staleTimer = undefined;
  }

  function deleteCode(code: string): void {
    const entry = pairCodes.get(code);
    pairCodes.delete(code);
    if (entry && codeByDevice.get(entry.deviceId) === code) codeByDevice.delete(entry.deviceId);
  }

  function deleteDeviceCode(deviceId: string): void {
    const code = codeByDevice.get(deviceId);
    if (code) deleteCode(code);
  }

  function expireCodes(at: number): void {
    for (const [code, entry] of pairCodes) {
      if (at >= entry.expiresAt && !pendingPairCodes.has(code)) deleteCode(code);
    }
  }

  function issuePairCode(deviceId: string): PairCode {
    deleteDeviceCode(deviceId);
    expireCodes(clock());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = randomCode();
      if (!/^\d{6}$/.test(code)) throw new Error("Companion pairing code source must return six digits");
      if (pairCodes.has(code) || pendingPairCodes.has(code)) continue;
      const entry = { code, deviceId, expiresAt: clock() + pairLifetimeMs };
      pairCodes.set(code, entry);
      codeByDevice.set(deviceId, code);
      return entry;
    }
    throw new Error("Unable to allocate a unique companion pairing code");
  }

  function sendPairing(helmet: HelmetSession, entry: PairCode, paired: boolean): void {
    helmet.peer.send({
      type: "companion.pairing",
      code: entry.code,
      expiresAt: entry.expiresAt,
      paired
    });
  }

  function sendCompanionState(
    session: CompanionSession,
    state: "unpaired" | "paired" | "helmetOffline" | "ready" | "sharing",
    binding?: CompanionBinding,
    helmet?: HelmetSession
  ): void {
    if (!session.active) return;
    session.peer.send({
      type: "companion.status",
      state,
      ...(binding ? { deviceId: binding.deviceId } : {}),
      ...(helmet ? { deviceLabel: helmet.peer.deviceLabel } : {})
    });
  }

  function sendHelmetState(helmet: HelmetSession, state: PhoneLocationStatusEvent["state"]): void {
    helmet.peer.send({ type: "phone.location.status", state });
  }

  function syncCompanion(session: CompanionSession): void {
    const binding = options.store.bindingForAccount(session.peer.accountId);
    if (!binding) {
      session.sharing = false;
      cancelStale(session);
      sendCompanionState(session, "unpaired");
      return;
    }
    const helmet = helmets.get(binding.deviceId);
    if (!helmet) {
      cancelStale(session);
      sendCompanionState(session, "helmetOffline", binding);
      return;
    }
    const state = session.sharing ? "sharing" : "ready";
    sendCompanionState(session, state, binding, helmet);
    sendHelmetState(helmet, session.sharing ? "sharing" : "connected");
  }

  function currentBucket(map: Map<string, AttemptBucket>, key: string, at: number): AttemptBucket | undefined {
    const bucket = map.get(key);
    if (!bucket) return undefined;
    if (at - bucket.startedAt >= pairLifetimeMs) {
      map.delete(key);
      return undefined;
    }
    return bucket;
  }

  function pairingBlocked(session: CompanionSession, at: number): boolean {
    return (
      (currentBucket(accountAttempts, session.peer.accountId, at)?.count ?? 0) >= MAX_PAIR_FAILURES ||
      (currentBucket(addressAttempts, session.peer.address, at)?.count ?? 0) >= MAX_PAIR_FAILURES
    );
  }

  function recordPairFailure(session: CompanionSession, at: number): void {
    for (const [map, key] of [
      [accountAttempts, session.peer.accountId],
      [addressAttempts, session.peer.address]
    ] as const) {
      const bucket = currentBucket(map, key, at);
      if (bucket) bucket.count += 1;
      else map.set(key, { count: 1, startedAt: at });
    }
  }

  function clearPairFailures(session: CompanionSession): void {
    accountAttempts.delete(session.peer.accountId);
    addressAttempts.delete(session.peer.address);
  }

  function markHelmetUnpaired(deviceId: string): void {
    const helmet = helmets.get(deviceId);
    if (!helmet) {
      deleteDeviceCode(deviceId);
      return;
    }
    sendHelmetState(helmet, "unpaired");
    const entry = issuePairCode(deviceId);
    sendPairing(helmet, entry, false);
  }

  function notifyDisplaced(displaced: CompanionBinding[], nextAccountId: string, nextDeviceId: string): void {
    for (const binding of displaced) {
      if (binding.accountId !== nextAccountId) {
        const phone = companions.get(binding.accountId);
        if (phone) {
          phone.sharing = false;
          cancelStale(phone);
          sendCompanionState(phone, "unpaired");
        }
      }
      if (binding.deviceId !== nextDeviceId) markHelmetUnpaired(binding.deviceId);
    }
  }

  async function handlePair(session: CompanionSession, code: string): Promise<void> {
    const at = clock();
    if (pairingBlocked(session, at)) {
      sendError(session, "pair.attempts", "Too many pairing attempts");
      return;
    }
    expireCodes(at);
    const entry = pairCodes.get(code);
    if (!entry || at >= entry.expiresAt || pendingPairCodes.has(code)) {
      recordPairFailure(session, at);
      sendError(session, "pair.code", "Pairing code is invalid or expired");
      return;
    }

    pendingPairCodes.add(code);
    try {
      const result = await options.store.bind(session.peer.accountId, entry.deviceId, at);
      deleteCode(code);
      clearPairFailures(session);
      session.sharing = false;
      cancelStale(session);
      notifyDisplaced(result.displaced, session.peer.accountId, entry.deviceId);

      const helmet = helmets.get(entry.deviceId);
      if (helmet) {
        sendPairing(helmet, entry, true);
        sendCompanionState(session, "ready", result.binding, helmet);
        sendHelmetState(helmet, "connected");
      } else {
        sendCompanionState(session, "helmetOffline", result.binding);
      }
      options.log?.info("companion pairing changed", {
        accountId: session.peer.accountId,
        deviceId: entry.deviceId,
        displaced: result.displaced.length
      });
    } catch {
      sendError(session, "pair.persistence", "Pairing could not be persisted");
    } finally {
      pendingPairCodes.delete(code);
    }
  }

  async function handleUnpair(session: CompanionSession): Promise<void> {
    const binding = options.store.bindingForAccount(session.peer.accountId);
    if (!binding) {
      session.sharing = false;
      cancelStale(session);
      sendCompanionState(session, "unpaired");
      return;
    }
    try {
      const removed = await options.store.unbindAccount(session.peer.accountId);
      if (!removed) {
        syncCompanion(session);
        return;
      }
      session.sharing = false;
      cancelStale(session);
      sendCompanionState(session, "unpaired");
      markHelmetUnpaired(removed.deviceId);
      options.log?.info("companion unpaired", {
        accountId: removed.accountId,
        deviceId: removed.deviceId
      });
    } catch {
      sendError(session, "unpair.persistence", "Unpairing could not be persisted");
    }
  }

  function handleStart(session: CompanionSession): void {
    const binding = options.store.bindingForAccount(session.peer.accountId);
    if (!binding) {
      session.sharing = false;
      sendCompanionState(session, "unpaired");
      return;
    }
    session.sharing = true;
    const helmet = helmets.get(binding.deviceId);
    if (!helmet) {
      sendCompanionState(session, "helmetOffline", binding);
      return;
    }
    sendCompanionState(session, "sharing", binding, helmet);
    sendHelmetState(helmet, "sharing");
  }

  function handleStop(session: CompanionSession): void {
    session.sharing = false;
    cancelStale(session);
    const binding = options.store.bindingForAccount(session.peer.accountId);
    if (!binding) {
      sendCompanionState(session, "unpaired");
      return;
    }
    const helmet = helmets.get(binding.deviceId);
    if (!helmet) {
      sendCompanionState(session, "helmetOffline", binding);
      return;
    }
    sendCompanionState(session, "ready", binding, helmet);
    sendHelmetState(helmet, "stopped");
  }

  function rejectLocation(session: CompanionSession, code: string, detail: string): void {
    sendError(session, code, detail);
  }

  function scheduleStale(session: CompanionSession, binding: CompanionBinding, timestamp: number, at: number): void {
    cancelStale(session);
    const delay = Math.max(0, timestamp + FIX_STALE_MS - at);
    session.staleTimer = setTimer(() => {
      session.staleTimer = undefined;
      if (!session.active || !session.sharing || companions.get(session.peer.accountId) !== session) return;
      const currentBinding = options.store.bindingForAccount(session.peer.accountId);
      if (!currentBinding || currentBinding.deviceId !== binding.deviceId) return;
      const helmet = helmets.get(binding.deviceId);
      if (helmet) sendHelmetState(helmet, "stale");
    }, delay);
  }

  function handleLocation(
    session: CompanionSession,
    event: Extract<CompanionClientEvent, { type: "companion.location" }>
  ): void {
    const binding = options.store.bindingForAccount(session.peer.accountId);
    if (!binding) {
      rejectLocation(session, "location.binding", "No helmet is paired");
      return;
    }
    if (!session.sharing) {
      rejectLocation(session, "location.state", "Location sharing is not started");
      return;
    }
    const at = clock();
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= session.lastSequence) {
      rejectLocation(session, "location.sequence", "Location sequence must increase");
      return;
    }
    if (session.lastAcceptedAt !== undefined && at - session.lastAcceptedAt < minFixIntervalMs) {
      rejectLocation(session, "location.rate", "Location fixes are arriving too quickly");
      return;
    }
    if (
      !Number.isFinite(event.timestamp) ||
      event.timestamp < at - FIX_STALE_MS ||
      event.timestamp > at + MAX_FUTURE_FIX_MS
    ) {
      rejectLocation(session, "location.timestamp", "Location timestamp is outside the accepted window");
      return;
    }
    if (!finiteRange(event.lat, -90, 90) || !finiteRange(event.lon, -180, 180)) {
      rejectLocation(session, "location.coordinates", "Location coordinates are outside their accepted ranges");
      return;
    }
    if (!finiteRange(event.horizontalAccuracyMeters, 0, MAX_HORIZONTAL_ACCURACY_METERS)) {
      rejectLocation(session, "location.accuracy", "Location accuracy is outside its accepted range");
      return;
    }
    if (event.courseDegrees !== undefined && !finiteRange(event.courseDegrees, 0, 360)) {
      rejectLocation(session, "location.course", "Location course is outside its accepted range");
      return;
    }
    if (event.speedMps !== undefined && (!Number.isFinite(event.speedMps) || event.speedMps < 0)) {
      rejectLocation(session, "location.speed", "Location speed is outside its accepted range");
      return;
    }

    const helmet = helmets.get(binding.deviceId);
    if (!helmet) return;
    session.lastSequence = event.sequence;
    session.lastAcceptedAt = at;
    helmet.peer.send({
      type: "phone.location",
      sequence: event.sequence,
      lat: event.lat,
      lon: event.lon,
      horizontalAccuracyMeters: event.horizontalAccuracyMeters,
      timestamp: event.timestamp,
      ...(event.courseDegrees === undefined ? {} : { courseDegrees: event.courseDegrees }),
      ...(event.speedMps === undefined ? {} : { speedMps: event.speedMps })
    });
    scheduleStale(session, binding, event.timestamp, at);
  }

  function detachCompanion(session: CompanionSession): void {
    if (!session.active) return;
    session.active = false;
    cancelStale(session);
    if (companions.get(session.peer.accountId) === session) companions.delete(session.peer.accountId);
    session.sharing = false;
    const binding = options.store.bindingForAccount(session.peer.accountId);
    const helmet = binding && helmets.get(binding.deviceId);
    if (helmet) sendHelmetState(helmet, "stopped");
  }

  const registry: CompanionRegistry = {
    attachHelmet(peer) {
      if (closed) throw new Error("Companion registry is closed");
      if (!validIdentity(peer.deviceId)) throw new Error("Helmet deviceId is required");
      if (!validIdentity(peer.deviceLabel)) throw new Error("Helmet deviceLabel is required");

      const existingBinding = options.store.bindingForDevice(peer.deviceId);
      if (helmets.has(peer.deviceId) && existingBinding) {
        const phone = companions.get(existingBinding.accountId);
        if (phone) cancelStale(phone);
      }
      const helmet = { peer };
      helmets.set(peer.deviceId, helmet);
      const entry = issuePairCode(peer.deviceId);
      const binding = options.store.bindingForDevice(peer.deviceId);
      sendPairing(helmet, entry, Boolean(binding));
      if (binding) {
        const phone = companions.get(binding.accountId);
        if (phone) syncCompanion(phone);
      }
      options.log?.info("companion helmet attached", { deviceId: peer.deviceId, paired: Boolean(binding) });

      return () => {
        if (helmets.get(peer.deviceId) !== helmet) return;
        helmets.delete(peer.deviceId);
        deleteDeviceCode(peer.deviceId);
        const currentBinding = options.store.bindingForDevice(peer.deviceId);
        if (!currentBinding) return;
        const phone = companions.get(currentBinding.accountId);
        if (!phone) return;
        cancelStale(phone);
        sendCompanionState(phone, "helmetOffline", currentBinding);
      };
    },

    attachCompanion(peer) {
      if (closed) throw new Error("Companion registry is closed");
      if (!validIdentity(peer.accountId)) throw new Error("Companion accountId is required");
      if (!validIdentity(peer.address)) throw new Error("Companion address is required");

      const previous = companions.get(peer.accountId);
      if (previous) detachCompanion(previous);
      const session: CompanionSession = {
        peer,
        active: true,
        sharing: false,
        lastSequence: 0
      };
      companions.set(peer.accountId, session);
      syncCompanion(session);
      options.log?.info("companion phone attached", { accountId: peer.accountId, address: peer.address });

      return {
        async handle(event) {
          if (!session.active || closed) return;
          switch (event.type) {
            case "companion.pair":
              await handlePair(session, event.code);
              return;
            case "companion.start":
              handleStart(session);
              return;
            case "companion.stop":
              handleStop(session);
              return;
            case "companion.unpair":
              await handleUnpair(session);
              return;
            case "companion.location":
              handleLocation(session, event);
              return;
          }
        },
        detach() {
          detachCompanion(session);
        }
      };
    },

    close() {
      if (closePromise) return closePromise;
      closed = true;
      for (const session of companions.values()) {
        session.active = false;
        cancelStale(session);
      }
      companions.clear();
      helmets.clear();
      pairCodes.clear();
      codeByDevice.clear();
      pendingPairCodes.clear();
      accountAttempts.clear();
      addressAttempts.clear();
      closePromise = options.store.flush();
      return closePromise;
    }
  };

  return registry;
}
