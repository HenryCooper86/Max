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

/**
 * Broadcasts the relay-issued discovery token on every transport. Dumb by
 * design: no retries, no policy — the relay decides WHAT to advertise, this
 * decides only that the radios match the latest instruction, including when
 * a stop lands while a start is still in flight.
 *
 * Each setToken()/close() call captures its target synchronously and
 * enqueues one reconcile job per transport onto that transport's own queue.
 * Jobs for a transport always run in the order they were enqueued (one op in
 * flight per transport). Capturing the target at enqueue time — rather than
 * re-reading "the current desired token" from inside an already-running job
 * — is what keeps a stop queued behind a slow start from being skipped: the
 * start job still runs (and is observable) before the stop job tears it back
 * down, so the final transport state always matches the last instruction
 * given, and a stop is always reachable no matter what it interrupts.
 */
export function createDiscoveryAdvertiser(options: {
  transports: DiscoveryTransport[];
  onStatus?: (status: string) => void;
  log?: (line: string) => void;
}): DiscoveryAdvertiser {
  const log = options.log ?? ((line: string) => console.log(line));
  const active = new Set<string>();
  const applied = new Map<string, string | null>();
  const queues = new Map<string, Promise<void>>();
  let closed = false;
  let lastStatus = "off";

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

  function enqueue(transport: DiscoveryTransport, target: string | null): void {
    const queue = queues.get(transport.name) ?? Promise.resolve();
    const next = queue.then(async () => {
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
    });
    // A failed job must not break the chain for whatever is enqueued next.
    queues.set(transport.name, next.catch(() => undefined));
  }

  return {
    setToken(token) {
      if (closed) return;
      for (const transport of options.transports) enqueue(transport, token);
    },
    status() {
      return lastStatus;
    },
    async close() {
      if (!closed) {
        closed = true;
        for (const transport of options.transports) enqueue(transport, null);
      }
      await Promise.all([...queues.values()]);
    }
  };
}
