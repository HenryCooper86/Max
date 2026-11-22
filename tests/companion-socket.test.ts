import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { CompanionClientEvent } from "../shared/companion";
import { logoutSession, registerUser, resetAccounts } from "../server/accounts";
import { resetRateLimit } from "../server/auth";
import { closeAuthenticatedConnections } from "../server/authenticated-connections";
import type { CompanionRegistry } from "../server/companion-registry";
import { createCompanionSocketServer } from "../server/companion-socket";
import { config } from "../server/config";
import type { Logger } from "../server/logger";

// The pairing socket: only a logged-in account may open it (the operator relay
// token is deliberately not enough), and a revoked login must lose it.

const quietLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const original = {
  relayAuthToken: config.relayAuthToken,
  allowedOrigins: config.allowedOrigins,
  connPerMinute: config.connPerMinute
};

type Harness = {
  url: string;
  attached: Array<{ accountId: string; address: string }>;
  handled: CompanionClientEvent[];
  close(): Promise<void>;
};

let harness: Harness | undefined;
const openClients: WebSocket[] = [];

async function startServer(): Promise<Harness> {
  const attached: Harness["attached"] = [];
  const handled: CompanionClientEvent[] = [];
  const registry: CompanionRegistry = {
    attachHelmet: () => () => {},
    attachCompanion(peer) {
      attached.push({ accountId: peer.accountId, address: peer.address });
      return {
        handle: async (event) => {
          handled.push(event);
        },
        detach: () => {}
      };
    },
    handleRiderUtterance: () => {},
    close: async () => {}
  };
  const sockets = createCompanionSocketServer({ registry, log: quietLog });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/companion`,
    attached,
    handled,
    async close() {
      await sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

/** Resolves with the HTTP status of a refused upgrade, or "open". */
function attempt(url: string, headers: Record<string, string> = {}): Promise<number | "open"> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url, { headers });
    openClients.push(client);
    client.once("open", () => resolve("open"));
    client.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    client.once("error", reject);
  });
}

async function connect(token: string): Promise<WebSocket> {
  const client = new WebSocket(harness!.url, { headers: { Authorization: `Bearer ${token}` } });
  openClients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  return client;
}

function closed(client: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => client.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
}

async function login(username = "rider"): Promise<{ token: string; userId: string }> {
  const result = await registerUser(username, "password123");
  if (!result.ok) throw new Error(result.error);
  return { token: result.token, userId: result.user.id };
}

beforeEach(async () => {
  resetRateLimit();
  resetAccounts();
  config.relayAuthToken = "";
  config.allowedOrigins = [];
  config.connPerMinute = 30;
  harness = await startServer();
});

afterEach(async () => {
  for (const client of openClients.splice(0)) client.terminate();
  await harness?.close();
  harness = undefined;
  resetAccounts();
  config.relayAuthToken = original.relayAuthToken;
  config.allowedOrigins = original.allowedOrigins;
  config.connPerMinute = original.connPerMinute;
});

describe("companion socket authentication", () => {
  it("refuses a connection without a login", async () => {
    expect(await attempt(harness!.url)).toBe(401);
    expect(harness!.attached).toEqual([]);
  });

  it("refuses the operator relay token: a companion needs an account identity", async () => {
    config.relayAuthToken = "operator-secret";
    expect(await attempt(`${harness!.url}?token=operator-secret`)).toBe(401);
    expect(await attempt(harness!.url, { Authorization: "Bearer operator-secret" })).toBe(401);
  });

  it("refuses an unknown or logged-out session token", async () => {
    const { token } = await login();
    logoutSession(token);
    expect(await attempt(harness!.url, { Authorization: `Bearer ${token}` })).toBe(401);
    expect(await attempt(harness!.url, { Authorization: "Bearer sess_not-a-real-session" })).toBe(401);
  });

  it("refuses a browser from an origin outside the allowlist", async () => {
    const { token } = await login();
    config.allowedOrigins = ["https://max.example.com"];
    expect(await attempt(harness!.url, { Authorization: `Bearer ${token}`, Origin: "https://evil.example" })).toBe(403);
    expect(await attempt(harness!.url, { Authorization: `Bearer ${token}`, Origin: "https://max.example.com" })).toBe(
      "open"
    );
  });

  it("rate-limits upgrade attempts per address", async () => {
    config.connPerMinute = 2;
    expect(await attempt(harness!.url)).toBe(401);
    expect(await attempt(harness!.url)).toBe(401);
    expect(await attempt(harness!.url)).toBe(429);
  });

  it("attaches a logged-in account and hands its messages to the registry", async () => {
    const { token, userId } = await login();
    const client = await connect(token);
    expect(harness!.attached).toEqual([{ accountId: userId, address: "127.0.0.1" }]);
    client.send(JSON.stringify({ type: "companion.start" }));
    await vi.waitFor(() => expect(harness!.handled).toEqual([{ type: "companion.start" }]));
  });

  it("answers binary or malformed traffic with a policy error and closes", async () => {
    const { token } = await login();
    const client = await connect(token);
    const message = new Promise<Record<string, unknown>>((resolve) =>
      client.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>))
    );
    const done = closed(client);
    client.send(Buffer.from([1, 2, 3]));
    expect(await message).toMatchObject({ type: "companion.error", code: "message.binary" });
    expect((await done).code).toBe(1008);
    expect(harness!.handled).toEqual([]);
  });

  it("replaces an account's previous companion socket", async () => {
    const { token } = await login();
    const first = await connect(token);
    const firstClosed = closed(first);
    await connect(token);
    expect(await firstClosed).toEqual({ code: 1008, reason: "companion replaced" });
  });

  it("closes the socket when its login is signed out", async () => {
    const mine = await login("rider");
    const theirs = await login("other-rider");
    const mineClient = await connect(mine.token);
    const theirClient = await connect(theirs.token);
    const mineClosed = closed(mineClient);

    logoutSession(mine.token);
    closeAuthenticatedConnections((connection) => connection.token === mine.token, 1008, "signed out");
    expect(await mineClosed).toEqual({ code: 1008, reason: "signed out" });
    expect(theirClient.readyState).toBe(WebSocket.OPEN);
  });
});
