import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { IDLE_CLOSE_CODE } from "../shared/agent";
import { markClientActivity, sweepClients, trackClient } from "../server/watchdog";

type FakeClient = {
  ping: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  pongHandler?: () => void;
};

function fakeClient(): FakeClient {
  const client: FakeClient = {
    ping: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "pong") client.pongHandler = handler;
    })
  };
  return client;
}

const asSocket = (client: FakeClient) => client as unknown as WebSocket;

describe("relay session watchdog", () => {
  it("pings live clients and terminates ones that missed a pong", () => {
    const client = fakeClient();
    trackClient(asSocket(client), 0);

    // First sweep: the client is alive, so it gets pinged and marked pending.
    let result = sweepClients([asSocket(client)], { idleTimeoutMs: 0, pingEnabled: true }, 1000);
    expect(result).toEqual({ pinged: 1, terminated: 0, idled: 0 });
    expect(client.ping).toHaveBeenCalledTimes(1);

    // No pong before the second sweep: the link is half-open — terminate.
    result = sweepClients([asSocket(client)], { idleTimeoutMs: 0, pingEnabled: true }, 2000);
    expect(result.terminated).toBe(1);
    expect(client.terminate).toHaveBeenCalledTimes(1);
  });

  it("keeps a client alive across sweeps when pongs arrive", () => {
    const client = fakeClient();
    trackClient(asSocket(client), 0);

    sweepClients([asSocket(client)], { idleTimeoutMs: 0, pingEnabled: true }, 1000);
    client.pongHandler?.();
    const result = sweepClients([asSocket(client)], { idleTimeoutMs: 0, pingEnabled: true }, 2000);

    expect(result).toEqual({ pinged: 1, terminated: 0, idled: 0 });
    expect(client.terminate).not.toHaveBeenCalled();
  });

  it("closes idle sessions with IDLE_CLOSE_CODE after a courtesy status", () => {
    const client = fakeClient();
    trackClient(asSocket(client), 0);

    const result = sweepClients([asSocket(client)], { idleTimeoutMs: 5000, pingEnabled: false }, 6000);

    expect(result.idled).toBe(1);
    expect(client.close).toHaveBeenCalledWith(IDLE_CLOSE_CODE, "idle timeout");
    const status = JSON.parse(String(client.send.mock.calls[0][0])) as { type: string; state: string };
    expect(status).toMatchObject({ type: "status", state: "closed" });
  });

  it("treats client traffic as activity that defers the idle timeout", () => {
    const client = fakeClient();
    trackClient(asSocket(client), 0);
    markClientActivity(asSocket(client), 5500);

    const result = sweepClients([asSocket(client)], { idleTimeoutMs: 5000, pingEnabled: false }, 6000);

    expect(result.idled).toBe(0);
    expect(client.close).not.toHaveBeenCalled();
  });
});

// Companion sockets (the phone's /companion link) had no keepalive at all,
// while the /agent socket has had one since the beginning. On the 2026-08-12
// bench the phone reattached five times in four minutes with the app in the
// foreground and the screen on: nothing on the relay closes those sockets
// (`rejectLocation` only sends an error, and the agent watchdog sweeps
// `wss.clients`, not the companion server), so an idle link — a GPS dropout is
// enough — can be reaped by carrier NAT with neither end noticing until the
// next write fails.
//
// They get ping/pong liveness and DELIBERATELY NOT the idle timeout: that
// timeout exists to free leaked Doubao upstream slots, which a companion
// socket does not hold, and a paired-but-idle phone is a legitimate state —
// especially since syncCompanionStateIfNeeded opens a socket that may sit idle
// by design. Idle-closing those would recreate the disconnect being fixed.
describe("companion socket liveness", () => {
  it("terminates a companion socket that missed a pong", () => {
    const client = fakeClient();
    trackClient(asSocket(client), 0);

    expect(sweepClients([asSocket(client)], { idleTimeoutMs: 0, pingEnabled: true }, 0)).toEqual({
      pinged: 1,
      terminated: 0,
      idled: 0
    });

    // No pong arrived before the next sweep.
    expect(sweepClients([asSocket(client)], { idleTimeoutMs: 0, pingEnabled: true }, 30_000).terminated).toBe(1);
    expect(client.terminate).toHaveBeenCalledTimes(1);
  });

  it("keeps a companion socket that pongs", () => {
    const client = fakeClient();
    trackClient(asSocket(client), 0);
    sweepClients([asSocket(client)], { idleTimeoutMs: 0, pingEnabled: true }, 0);

    client.pongHandler?.();

    expect(sweepClients([asSocket(client)], { idleTimeoutMs: 0, pingEnabled: true }, 30_000)).toEqual({
      pinged: 1,
      terminated: 0,
      idled: 0
    });
    expect(client.terminate).not.toHaveBeenCalled();
  });

  it("never idle-closes a silent companion socket, however long it sits", () => {
    const client = fakeClient();
    trackClient(asSocket(client), 0);

    // A full day of silence, ponging each round: still open.
    for (let sweep = 1; sweep <= 8; sweep += 1) {
      const result = sweepClients([asSocket(client)], { idleTimeoutMs: 0, pingEnabled: true }, sweep * 3 * 3_600_000);
      expect(result.idled).toBe(0);
      expect(result.terminated).toBe(0);
      client.pongHandler?.();
    }
    expect(client.close).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });
});
