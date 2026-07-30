import { describe, expect, it } from "vitest";
import { startHeartbeat } from "../rdk/agent/src/watchdog";

function harness(env: Record<string, string | undefined>, healthy: () => boolean) {
  const ticks: Array<() => void> = [];
  const notifies: number[] = [];
  const lines: string[] = [];
  const heartbeat = startHeartbeat({
    isHealthy: healthy,
    env,
    notify: () => notifies.push(1),
    log: (line) => lines.push(line),
    setInterval: ((fn: () => void) => {
      ticks.push(fn);
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof globalThis.setInterval
  });
  return { ticks, notifies, lines, heartbeat };
}

describe("startHeartbeat", () => {
  it("does nothing outside systemd", () => {
    const { ticks } = harness({}, () => true);
    expect(ticks.length).toBe(0);
  });

  it("notifies on every healthy tick", () => {
    const { ticks, notifies } = harness({ NOTIFY_SOCKET: "/run/notify" }, () => true);
    ticks[0]!();
    ticks[0]!();
    expect(notifies.length).toBe(2);
  });

  it("withholds the heartbeat while unhealthy, and says so once", () => {
    let healthy = true;
    const { ticks, notifies, lines } = harness({ NOTIFY_SOCKET: "/run/notify" }, () => healthy);
    ticks[0]!();
    healthy = false;
    ticks[0]!();
    ticks[0]!();
    expect(notifies.length).toBe(1);
    expect(lines.filter((line) => line.includes("withholding")).length).toBe(1);
    healthy = true;
    ticks[0]!();
    expect(notifies.length).toBe(2);
    expect(lines.some((line) => line.includes("healthy again"))).toBe(true);
  });
});
