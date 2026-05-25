import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentEvent } from "../shared/agent";
import { AgentSessionController } from "../server/session-controller";
import { createMockProvider } from "../server/providers/mock";

let server: http.Server | undefined;
let wss: WebSocketServer | undefined;

function waitForOpen(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function waitForEvents(socket: WebSocket, requiredTypes: string[]) {
  const seen = new Set<string>();
  const events: AgentEvent[] = [];

  return new Promise<AgentEvent[]>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${requiredTypes.join(", ")}`)), 5000);

    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(data.toString()) as AgentEvent;
      events.push(event);
      seen.add(event.type);
      if (requiredTypes.every((type) => seen.has(type))) {
        clearTimeout(timeout);
        resolve(events);
      }
    });
  });
}

async function startMockRelay() {
  server = http.createServer();
  wss = new WebSocketServer({ server, path: "/agent" });
  wss.on("connection", (client) => {
    const session = new AgentSessionController(client, createMockProvider);
    client.on("message", (data, isBinary) => void session.handleMessage(data, isBinary));
    client.on("close", () => void session.close());
  });

  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  return address.port;
}

afterEach(async () => {
  for (const client of wss?.clients ?? []) client.terminate();
  await new Promise<void>((resolve) => wss?.close(() => resolve()) ?? resolve());
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  wss = undefined;
  server = undefined;
});

describe("/agent WebSocket relay", () => {
  it("runs a mock session lifecycle with JSON and binary audio", async () => {
    const port = await startMockRelay();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent`);
    await waitForOpen(socket);

    const eventsPromise = waitForEvents(socket, [
      "session.started",
      "ride.context",
      "session.memory",
      "status",
      "weather",
      "transcript"
    ]);

    socket.send(
      JSON.stringify({
        type: "session.start",
        sampleRate: 16000,
        channels: 1,
        voiceGender: "female",
        voicePersonality: "concise",
        scenario: "commute"
      })
    );
    socket.send(JSON.stringify({ type: "audio.start" }));
    socket.send(Buffer.from([1, 2, 3, 4]));

    const events = await eventsPromise;
    expect(events.some((event) => event.type === "session.started" && event.provider === "mock")).toBe(true);
    expect(events.some((event) => event.type === "weather")).toBe(true);
    expect(events.some((event) => event.type === "transcript" && event.speaker === "rider")).toBe(true);

    socket.terminate();
  });
});
