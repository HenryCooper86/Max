import { randomInt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { networkInterfaces } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import { parseCastFrame, type CastFrame } from "./protocol";

export const CAST_STALE_MS = 8_000;
const CODE_TTL = 5 * 60_000;

/** A separate, opt-in LAN sender. No relay credentials, transcripts or bench token. */
export function createCastReceiver(page: string, now = Date.now) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  let owner: WebSocket | undefined;
  let frame: CastFrame | null = null;
  let mapImage: Buffer | null = null;
  let mapSequence = 0;
  let mapReceivedAt = 0;
  let receivedAt = 0;
  let lastActivityAt = 0;
  let code = "";
  let expiresAt = 0;
  let attempts = 0;
  let attemptWindow = 0;
  function rotateCode() {
    code = String(randomInt(100_000, 1_000_000));
    expiresAt = now() + CODE_TTL;
  }
  rotateCode();
  function release(socket: WebSocket) {
    if (owner !== socket) return;
    owner = undefined;
    frame = null;
    mapImage = null;
    mapSequence = 0;
    mapReceivedAt = 0;
    receivedAt = 0;
    rotateCode();
  }
  sockets.on("connection", (socket) => {
    const timeout = setTimeout(() => socket.terminate(), 5_000);
    let sequence = 0;
    socket.on("error", () => release(socket));
    socket.on("close", () => {
      clearTimeout(timeout);
      release(socket);
    });
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("Text required");
        const value = JSON.parse(data.toString());
        if (owner !== socket) {
          if (now() - attemptWindow >= 60_000) {
            attempts = 0;
            attemptWindow = now();
          }
          if (
            ++attempts > 5 ||
            owner ||
            now() >= expiresAt ||
            value?.type !== "hud.join" ||
            typeof value.code !== "string" ||
            !/^\d{6}$/.test(value.code) ||
            !timingSafeEqual(Buffer.from(value.code), Buffer.from(code))
          )
            throw new Error("Join refused");
          owner = socket;
          lastActivityAt = now();
          clearTimeout(timeout);
          code = ""; // one use; displayed again only after disconnect
          socket.send(JSON.stringify({ type: "hud.ready" }));
          return;
        }
        if (value?.type === "hud.stop") {
          release(socket);
          socket.close(1000, "Stopped");
          return;
        }
        if (value?.type === "hud.ping" && Object.keys(value).length === 1) {
          lastActivityAt = now();
          socket.send(JSON.stringify({ type: "hud.pong" }));
          return;
        }
        if (value?.type === "hud.map") {
          if (
            !frame ||
            !Number.isSafeInteger(value.sequence) ||
            value.sequence <= mapSequence ||
            typeof value.jpeg !== "string" ||
            value.jpeg.length > 240_000 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(value.jpeg)
          )
            throw new Error("Invalid map");
          const jpeg = Buffer.from(value.jpeg, "base64");
          if (
            jpeg.length < 4 ||
            jpeg[0] !== 0xff ||
            jpeg[1] !== 0xd8 ||
            jpeg[jpeg.length - 2] !== 0xff ||
            jpeg[jpeg.length - 1] !== 0xd9
          )
            throw new Error("Invalid JPEG");
          mapImage = jpeg;
          mapSequence = value.sequence;
          mapReceivedAt = now();
          lastActivityAt = mapReceivedAt;
          // Map rendering and compass updates never refresh the GPS timestamp.
          socket.send(JSON.stringify({ type: "hud.map.ack", sequence: mapSequence }));
          return;
        }
        const next = parseCastFrame(value);
        if (next.sequence <= sequence) throw new Error("Old sequence");
        sequence = next.sequence;
        frame = next;
        receivedAt = now();
        lastActivityAt = receivedAt;
        socket.send(JSON.stringify({ type: "hud.ack", sequence }));
      } catch {
        release(socket);
        socket.close(1008, "Invalid or unauthorized HUD message");
      }
    });
  });
  const watchdog = setInterval(() => {
    if (owner && now() - lastActivityAt > 30_000) {
      const socket = owner;
      release(socket);
      socket.terminate();
    }
  }, 1_000);
  watchdog.unref();

  function localDisplay(request: IncomingMessage): boolean {
    const peer = request.socket.remoteAddress;
    const host = request.headers.host ?? "";
    return (
      (peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1") &&
      /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)
    );
  }
  return {
    handle(request: IncomingMessage, response: ServerResponse): boolean {
      const path = (request.url ?? "").split("?")[0];
      if (path !== "/cast" && path !== "/cast/state" && path !== "/cast/map") return false;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (request.method !== "GET" || !localDisplay(request)) {
        response.writeHead(403);
        response.end("Open HUD on the RDK at http://127.0.0.1:8080/cast");
        return true;
      }
      if (path === "/cast/map") {
        if (!owner || !mapImage || now() - mapReceivedAt > 5_000 || now() - receivedAt > CAST_STALE_MS) {
          response.writeHead(404);
          response.end();
          return true;
        }
        response.writeHead(200, { "Content-Type": "image/jpeg" });
        response.end(mapImage);
        return true;
      }
      if (path === "/cast") {
        response.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'"
        );
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(page);
      } else {
        if (!owner && now() >= expiresAt) rotateCode();
        const addresses = Object.values(networkInterfaces())
          .flatMap((entries) => entries ?? [])
          .filter((entry) => entry.family === "IPv4" && !entry.internal)
          .map((entry) => entry.address);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            code: owner ? null : code,
            expiresAt,
            addresses,
            port: request.socket.localPort,
            connected: !!owner,
            stale: !frame || now() - receivedAt > CAST_STALE_MS,
            frame,
            mapSequence: mapImage && now() - mapReceivedAt <= 5_000 ? mapSequence : null
          })
        );
      }
      return true;
    },
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      if ((request.url ?? "").split("?")[0] !== "/cast/socket") return false;
      // Native apps only. Disallow browser origins, including cross-site localhost access.
      if (request.headers.origin || sockets.clients.size >= 4) {
        socket.destroy();
        return true;
      }
      sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, request));
      return true;
    },
    close() {
      clearInterval(watchdog);
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
    }
  };
}
