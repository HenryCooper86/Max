/**
 * WATCHDOG=1 heartbeats to systemd, sent only while the component's real job
 * is being done. A wedged-but-alive agent stops heartbeating and systemd
 * restarts it after WatchdogSec — the difference between "running" and
 * "working" that finding a silent dead mic taught us to encode.
 *
 * Node cannot send unix datagrams natively, so the notify default shells out
 * to systemd-notify (one short-lived process per interval; NotifyAccess=all
 * in the unit accepts it). Outside systemd — no NOTIFY_SOCKET — this is
 * entirely inert, so bench runs behave exactly as before.
 */

import { spawn as nodeSpawn } from "node:child_process";

export type HeartbeatOptions = {
  /** True when the real job is happening — e.g. mic frames arriving. */
  isHealthy(): boolean;
  intervalMs?: number;
  notify?: () => void;
  log?: (line: string) => void;
  setInterval?: typeof globalThis.setInterval;
  env?: Record<string, string | undefined>;
};

export function startHeartbeat(options: HeartbeatOptions): { stop(): void } {
  const env = options.env ?? process.env;
  if (!env.NOTIFY_SOCKET) return { stop() {} };

  const log = options.log ?? ((line: string) => console.log(line));
  const notify =
    options.notify ??
    (() => {
      nodeSpawn("systemd-notify", ["WATCHDOG=1"], { stdio: "ignore" }).on("error", () => {});
    });
  const set = options.setInterval ?? globalThis.setInterval;
  let wasHealthy = true;

  const timer = set(() => {
    const healthy = options.isHealthy();
    if (healthy) {
      if (!wasHealthy) log("[watchdog] healthy again; resuming heartbeats");
      notify();
    } else if (wasHealthy) {
      log("[watchdog] unhealthy; withholding heartbeats so systemd restarts us");
    }
    wasHealthy = healthy;
  }, options.intervalMs ?? 10_000);

  return {
    stop(): void {
      clearInterval(timer);
    }
  };
}
