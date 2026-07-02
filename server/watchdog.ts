// Session watchdog for the /agent WebSocket: ping/pong liveness plus an idle
// timeout. Both exist to free leaked Doubao upstream slots — a client that
// vanished without a close frame (phone lost signal, laptop lid closed) leaves
// a half-open TCP connection whose provider session would otherwise live
// forever, and a forgotten-but-healthy tab holds its upstream just as long.
//
// Idle closes use IDLE_CLOSE_CODE (4001) so clients know NOT to auto-reconnect
// (an automatic reconnect would immediately re-open an upstream session and
// defeat the timeout). Liveness failures use terminate(): the peer is gone, so
// there is no one to close-handshake with.

import type { WebSocket } from "ws";
import { IDLE_CLOSE_CODE } from "../shared/agent";
import type { Logger } from "./logger";
import { metrics } from "./metrics";

// Watchdog bookkeeping riding on the ws instance itself, so state lives and
// dies with the socket and needs no external map to clean up.
type TrackedSocket = WebSocket & { isAlive?: boolean; lastActivityAt?: number };

/** Registers a freshly-connected client with the watchdog. */
export function trackClient(client: WebSocket, now = Date.now()) {
  const tracked = client as TrackedSocket;
  tracked.isAlive = true;
  tracked.lastActivityAt = now;
  client.on("pong", () => {
    tracked.isAlive = true;
  });
}

/** Records client traffic (any JSON event or audio frame) for the idle timer. */
export function markClientActivity(client: WebSocket, now = Date.now()) {
  (client as TrackedSocket).lastActivityAt = now;
}

export type SweepResult = { pinged: number; terminated: number; idled: number };

/**
 * One watchdog pass. A client that failed to pong since the previous pass is
 * terminated; a client silent past `idleTimeoutMs` is closed with
 * IDLE_CLOSE_CODE (after a status event explaining why); everyone else is
 * pinged for the next pass. Exported for tests.
 */
export function sweepClients(
  clients: Iterable<WebSocket>,
  options: { idleTimeoutMs: number; pingEnabled: boolean },
  now = Date.now()
): SweepResult {
  const result: SweepResult = { pinged: 0, terminated: 0, idled: 0 };

  for (const client of clients) {
    const tracked = client as TrackedSocket;

    if (options.pingEnabled && tracked.isAlive === false) {
      client.terminate();
      result.terminated += 1;
      continue;
    }

    const lastActivityAt = tracked.lastActivityAt ?? now;
    if (options.idleTimeoutMs > 0 && now - lastActivityAt >= options.idleTimeoutMs) {
      try {
        client.send(
          JSON.stringify({
            type: "status",
            state: "closed",
            detail: "会话闲置超时，已断开以释放语音通道；开启免提即可重新连接"
          })
        );
      } catch {
        /* best-effort courtesy message */
      }
      client.close(IDLE_CLOSE_CODE, "idle timeout");
      result.idled += 1;
      continue;
    }

    if (options.pingEnabled) {
      tracked.isAlive = false;
      client.ping();
      result.pinged += 1;
    }
  }

  return result;
}

/**
 * Starts the periodic watchdog. The heartbeat interval drives both checks;
 * with heartbeat disabled (0) the idle check still runs on a fixed cadence.
 * Returns a stop function.
 */
export function startWatchdog(options: {
  clients: () => Iterable<WebSocket>;
  heartbeatMs: number;
  idleTimeoutMs: number;
  log: Logger;
}): () => void {
  const pingEnabled = options.heartbeatMs > 0;
  if (!pingEnabled && options.idleTimeoutMs <= 0) return () => {};

  const cadenceMs = pingEnabled ? options.heartbeatMs : 60_000;
  const timer = setInterval(() => {
    const result = sweepClients(options.clients(), { idleTimeoutMs: options.idleTimeoutMs, pingEnabled });
    if (result.terminated || result.idled) {
      metrics.watchdogSweep(result.terminated, result.idled);
      options.log.info("watchdog closed sessions", {
        unresponsive: result.terminated,
        idle: result.idled
      });
    }
  }, cadenceMs);
  timer.unref();
  return () => clearInterval(timer);
}
