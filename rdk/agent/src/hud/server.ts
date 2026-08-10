import { createServer } from "node:http";
import { readFileSync } from "node:fs";
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
export function createHudServer(port: number, previewPort: number): { publish(state: HudState): void; close(): void } {
  const here = dirname(fileURLToPath(import.meta.url));
  const page = readFileSync(join(here, "index.html"), "utf8").replace(/__PREVIEW_PORT__/g, String(previewPort));

  const http = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
  });
  const sockets = new WebSocketServer({ server: http });
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
