import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { Logger } from "../server/logger";
import { metrics } from "../server/metrics";
import { createMockProvider } from "../server/providers/mock";
import { AgentSessionController, parseClientEvent } from "../server/session-controller";
import { PROTOCOL_VERSION } from "../shared/agent";

// The client and the relay each say which protocol they speak. Nothing is
// refused on a mismatch; the side that is behind is told.

const parse = (value: unknown) => parseClientEvent(Buffer.from(JSON.stringify(value)));
const START = { type: "session.start", sampleRate: 16000, channels: 1 };

describe("protocol in session.start", () => {
  it("is optional and accepts a positive integer", () => {
    expect(parse(START)).not.toHaveProperty("protocol");
    expect(parse({ ...START, protocol: 1 })).toMatchObject({ protocol: 1 });
    expect(parse({ ...START, protocol: 7 })).toMatchObject({ protocol: 7 });
  });

  it("rejects anything that is not a positive integer", () => {
    for (const protocol of [0, -1, 1.5, "1", null, {}]) {
      expect(() => parse({ ...START, protocol }), JSON.stringify(protocol)).toThrow(/protocol/);
    }
  });
});

describe("the handshake over a real connection", () => {
  let server: http.Server | undefined;
  let wss: WebSocketServer | undefined;

  afterEach(async () => {
    for (const client of wss?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => wss?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    wss = undefined;
    server = undefined;
    metrics.reset();
  });

  async function started(start: Record<string, unknown>) {
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const log = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string, fields?: Record<string, unknown>) => warnings.push({ message, fields }),
      error: () => undefined
    } as unknown as Logger;
    server = http.createServer();
    wss = new WebSocketServer({ server, path: "/agent" });
    wss.on("connection", (client) => {
      const session = new AgentSessionController(client, createMockProvider, log);
      client.on("message", (data, isBinary) => void session.handleMessage(data, isBinary));
      client.on("close", () => void session.close());
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server port");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/agent`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const event = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no session.started")), 5000);
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if (parsed.type !== "session.started") return;
        clearTimeout(timeout);
        resolve(parsed);
      });
    });
    socket.send(JSON.stringify({ ...START, ...start }));
    const result = await event;
    socket.close();
    return { event: result, warnings };
  }

  it("tells every client which protocol the relay speaks", async () => {
    const { event, warnings } = await started({});
    expect(event.protocol).toBe(PROTOCOL_VERSION);
    expect(event.provider).toBe("mock");
    expect(warnings.filter((entry) => entry.message.includes("protocol"))).toEqual([]);
  });

  it("stays quiet for a client on the same protocol", async () => {
    const { warnings } = await started({ protocol: PROTOCOL_VERSION });
    expect(warnings.filter((entry) => entry.message.includes("protocol"))).toEqual([]);
  });

  it("serves a newer client and tells the operator the relay is behind", async () => {
    const { event, warnings } = await started({ protocol: PROTOCOL_VERSION + 1, appVersion: "max-voice-agent@9.0.0" });
    expect(event.protocol).toBe(PROTOCOL_VERSION);
    expect(warnings).toContainEqual({
      message: "client speaks a newer protocol than this relay",
      fields: { client: PROTOCOL_VERSION + 1, relay: PROTOCOL_VERSION, appVersion: "max-voice-agent@9.0.0" }
    });
  });
});
