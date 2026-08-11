import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import type { HudState } from "./state";

const localHudPeers = new BlockList();
localHudPeers.addSubnet("127.0.0.0", 8, "ipv4");
localHudPeers.addAddress("::1", "ipv6");

function isLocalHudPeerAddress(address: string | undefined): boolean {
  const family = isIP(address ?? "");
  if (family === 0 || address === undefined) return false;
  return localHudPeers.check(address, family === 4 ? "ipv4" : "ipv6");
}

function tokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which is itself the answer.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Whether a request may have the HUD at all.
 *
 * The page carries the sidecar's bench token so the browser's fetches to 8081
 * work, which means serving the page to a stranger hands them that token and
 * the gate on 8081 buys nothing. So the same rule applies here: the board
 * itself is always allowed, and anyone else brings the token in the URL
 * (`http://<board>:8080/?t=…`).
 *
 * With no token configured, nothing off-box is served. Fail closed, matching
 * bench_server.authorized — this page shows the rider's live transcript,
 * destination and location accuracy.
 */
export function hudRequestAllowed(request: IncomingMessage, token: string): boolean {
  if (isLocalHudPeerAddress(request.socket.remoteAddress)) return true;
  if (!token) return false;
  const supplied = new URL(request.url ?? "/", "http://hud.invalid").searchParams.get("t") ?? "";
  return tokenMatches(supplied, token);
}

function remoteHudSnapshot(state: HudState): HudState {
  const companion = { ...state.companion };
  delete companion.pairingCode;
  delete companion.pairingExpiresAt;
  return { ...state, companion };
}

/**
 * Bench instrument, not a rider surface. It costs nothing when nobody has it
 * open, which is the normal case in a helmet.
 */
/**
 * Fills the page's placeholders.
 *
 * Exported so the render test can evaluate the page exactly as it is served:
 * the raw file's `__PREVIEW_PORT__` is not a valid URL port, so a test that
 * substituted differently — or not at all — would be exercising a page no
 * browser ever receives.
 */
export function renderHudPage(source: string, previewPort: number, visionToken: string): string {
  return source.replace(/__PREVIEW_PORT__/g, String(previewPort)).replace(/__VISION_TOKEN__/g, visionToken);
}

export function createHudServer(
  port: number,
  previewPort: number,
  visionToken = ""
): { publish(state: HudState): void; close(): void } {
  const here = dirname(fileURLToPath(import.meta.url));
  const page = renderHudPage(readFileSync(join(here, "index.html"), "utf8"), previewPort, visionToken);

  const http = createServer((request, response) => {
    if (!hudRequestAllowed(request, visionToken)) {
      response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("bench token required\n");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
  });
  // `noServer` is not used, so gate the upgrade explicitly: without this a
  // stranger who cannot read the page can still open the socket and watch the
  // rider's transcript and destination stream past.
  const sockets = new WebSocketServer({
    server: http,
    verifyClient: ({ req }: { req: IncomingMessage }) => hudRequestAllowed(req, visionToken)
  });
  const localSockets = new WeakSet<object>();
  let latest: HudState | null = null;

  sockets.on("connection", (socket, request) => {
    const isLocal = isLocalHudPeerAddress(request.socket.remoteAddress);
    if (isLocal) localSockets.add(socket);
    if (latest) socket.send(JSON.stringify(isLocal ? latest : remoteHudSnapshot(latest)));
  });

  http.listen(port);

  return {
    publish(state: HudState): void {
      latest = state;
      let localPayload: string | undefined;
      let remotePayload: string | undefined;
      for (const socket of sockets.clients) {
        if (socket.readyState !== socket.OPEN) continue;
        const payload = localSockets.has(socket)
          ? (localPayload ??= JSON.stringify(state))
          : (remotePayload ??= JSON.stringify(remoteHudSnapshot(state)));
        socket.send(payload);
      }
    },
    close(): void {
      sockets.close();
      http.close();
    }
  };
}
