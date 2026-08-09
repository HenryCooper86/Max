import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { parseCompanionClientEvent, type CompanionServerEvent } from "../shared/companion";
import { authorizeAccountUpgrade, clientAddress } from "./auth";
import type { PublicUser } from "./accounts";
import type { CompanionRegistry } from "./companion-registry";
import type { Logger } from "./logger";
import { metrics } from "./metrics";
import { registerAuthenticatedConnection, unregisterAuthenticatedConnection } from "./authenticated-connections";

const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024;
// Leave enough room for the application layer to return companion.error/1008
// at its 8 KiB policy limit, while retaining a small hard reassembly guard for
// peers that ignore the close and send a much larger frame.
const HARD_TRANSPORT_MAX_PAYLOAD_BYTES = 64 * 1024;

type AuthenticatedCompanion = { token: string; user: PublicUser };

function rawDataBytes(data: RawData): number {
  return Array.isArray(data) ? data.reduce((total, chunk) => total + chunk.byteLength, 0) : data.byteLength;
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export function createCompanionSocketServer(options: {
  registry: CompanionRegistry;
  maxPayloadBytes?: number;
  log: Logger;
}): {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): Promise<void>;
  clients(): Iterable<WebSocket>;
} {
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Math.max(HARD_TRANSPORT_MAX_PAYLOAD_BYTES, maxPayloadBytes),
    perMessageDeflate: false
  });
  const rejectingClients = new WeakSet<WebSocket>();
  const clientsByAccount = new Map<string, WebSocket>();

  function reject(socket: Duplex, code: number, reason: string): void {
    metrics.rejectedUpgrade();
    socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  function sendPolicyError(client: WebSocket, code: string, detail: string): void {
    if (rejectingClients.has(client)) return;
    rejectingClients.add(client);
    metrics.companionRejected();
    const event: CompanionServerEvent = { type: "companion.error", code, detail };
    if (client.readyState !== WebSocket.OPEN) return;
    try {
      client.send(JSON.stringify(event));
    } finally {
      client.close(1008, "invalid companion message");
    }
  }

  function attach(client: WebSocket, request: IncomingMessage, session: AuthenticatedCompanion): void {
    const displaced = clientsByAccount.get(session.user.id);
    if (displaced && displaced !== client) displaced.close(1008, "companion replaced");

    const connection = options.registry.attachCompanion({
      accountId: session.user.id,
      address: clientAddress(request),
      send(event) {
        if (client.readyState !== WebSocket.OPEN) throw new Error("Companion socket is not open");
        client.send(JSON.stringify(event));
      }
    });
    clientsByAccount.set(session.user.id, client);
    registerAuthenticatedConnection(client, { userId: session.user.id, token: session.token });

    client.on("message", (data, isBinary) => {
      if (rejectingClients.has(client)) return;
      if (isBinary) {
        sendPolicyError(client, "message.binary", "Binary companion messages are not supported");
        return;
      }
      if (rawDataBytes(data) > maxPayloadBytes) {
        sendPolicyError(client, "message.size", "Companion message exceeds 8 KiB");
        return;
      }
      try {
        const event = parseCompanionClientEvent(rawDataText(data));
        metrics.companionAccepted();
        void connection.handle(event).catch(() => {
          sendPolicyError(client, "message.handle", "Companion message could not be handled");
        });
      } catch {
        sendPolicyError(client, "message.invalid", "Invalid companion message");
      }
    });

    client.once("close", () => {
      connection.detach();
      if (clientsByAccount.get(session.user.id) === client) clientsByAccount.delete(session.user.id);
      unregisterAuthenticatedConnection(client);
    });
    client.on("error", (error) => {
      options.log.warn("companion socket error", {
        accountId: session.user.id,
        address: clientAddress(request),
        message: error.message
      });
    });
  }

  return {
    handleUpgrade(request, socket, head) {
      const decision = authorizeAccountUpgrade(request);
      if (!decision.ok) {
        options.log.warn("rejected /companion upgrade", {
          address: clientAddress(request),
          code: decision.code,
          reason: decision.reason
        });
        reject(socket, decision.code, decision.reason);
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => {
        attach(client, request, { token: decision.token, user: decision.user });
      });
    },
    close() {
      for (const client of wss.clients) client.close(1001, "server shutdown");
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
    clients() {
      return wss.clients;
    }
  };
}
