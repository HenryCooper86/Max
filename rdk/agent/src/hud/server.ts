import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import type { HudState } from "./state";

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
  let latest: HudState | null = null;

  sockets.on("connection", (socket) => {
    if (latest) socket.send(JSON.stringify(latest));
  });

  http.listen(port);

  return {
    publish(state: HudState): void {
      latest = state;
      const payload = JSON.stringify(state);
      for (const socket of sockets.clients) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    },
    close(): void {
      sockets.close();
      http.close();
    }
  };
}
