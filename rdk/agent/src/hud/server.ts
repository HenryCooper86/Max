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

/**
 * What a refused peer is told.
 *
 * "bench token required" alone is true and useless: whoever reads it is in a
 * browser address bar with no other clue, and the two ways in suit different
 * jobs. The query parameter is the ordinary bench look. The forward matters
 * because loopback is exempt *and* because pairing-code redaction keys off the
 * peer address — a direct-LAN browser never sees a code however good its token.
 *
 * Both ports say this, in the same words, so it does not matter which one you
 * happen to hit first.
 */
export const REFUSAL_TEXT = `bench token required.

Append the board's token to the URL:
  ?t=<MAX_VISION_TOKEN>

Or reach the board over an SSH local forward, which is exempt from the token
and is the only route that shows pairing codes:
  ssh -N -L 8080:127.0.0.1:8080 -L 8081:127.0.0.1:8081 root@<board>
  then open http://127.0.0.1:8080

Both ports must map to the same numbers: the HUD page asks the browser for
<host>:8081, so a forward on any other local port leaves its camera and
gallery panels dead. See rdk/README.md "Bench access — MAX_VISION_TOKEN".
`;

/**
 * What a served-but-not-local peer sees. The token got them in; it does not
 * make them local. Pairing secrets stay loopback-only, and so does anything
 * that would turn this page into a rider-tracking surface: the route the rider
 * is following and where they are on it.
 */
function remoteHudSnapshot(state: HudState): HudState {
  const companion = { ...state.companion };
  delete companion.pairingCode;
  delete companion.pairingExpiresAt;
  const navigation = state.navigation === null ? null : { ...state.navigation };
  if (navigation !== null) delete navigation.position;
  return { ...state, companion, navigation, route: null };
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
      response.end(REFUSAL_TEXT);
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
