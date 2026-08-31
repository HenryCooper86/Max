import { hostname } from "node:os";
import makeMdns from "multicast-dns";
import type { DiscoveryTransport } from "./advertiser";

export type MdnsAnswer =
  | { name: string; type: "PTR"; ttl: number; data: string }
  | { name: string; type: "SRV"; ttl: number; data: { port: number; target: string } }
  | { name: string; type: "TXT"; ttl: number; data: string[] };

export type MdnsLike = {
  on(event: "query", listener: (query: { questions: Array<{ name: string; type: string }> }) => void): void;
  respond(response: { answers: MdnsAnswer[] }): void;
  destroy(callback?: () => void): void;
};

const SERVICE = "_maxhelmet._tcp.local";
const TTL_SECONDS = 120;

/**
 * Advertisement-only responder: the beacon IS the payload (TXT dt=<token>).
 * The SRV port points at the HUD only because SRV needs one; nothing
 * pairing-related listens there. Recreated per start so a token rotation can
 * never answer with a stale token.
 */
export function createMdnsTransport(options: {
  port: number;
  mdnsFactory?: () => MdnsLike;
  log?: (line: string) => void;
}): DiscoveryTransport {
  const factory = options.mdnsFactory ?? (() => makeMdns() as unknown as MdnsLike);
  let current: { instance: MdnsLike; token: string } | undefined;

  async function stop(): Promise<void> {
    const running = current;
    current = undefined;
    if (!running) return;
    await new Promise<void>((resolve) => running.instance.destroy(resolve));
  }

  return {
    name: "mdns",
    async start(token) {
      await stop();
      const instance = factory();
      try {
        const target = `${hostname()}.local`;
        const instanceName = `Max Helmet ${token.slice(0, 4)}.${SERVICE}`;
        const running: { instance: MdnsLike; token: string } = { instance, token };
        instance.on("query", (query) => {
          if (current !== running) return;
          if (!query.questions.some((question) => question.name === SERVICE || question.name === instanceName)) {
            return;
          }
          instance.respond({
            answers: [
              { name: SERVICE, type: "PTR", ttl: TTL_SECONDS, data: instanceName },
              { name: instanceName, type: "SRV", ttl: TTL_SECONDS, data: { port: options.port, target } },
              { name: instanceName, type: "TXT", ttl: TTL_SECONDS, data: [`dt=${token}`, "v=1"] }
            ]
          });
        });
        // Only commit the new responder once wiring above succeeded — the
        // advertiser will never send a stop() for a start() that rejected, so
        // a partially-wired instance must be destroyed here instead, not left
        // dangling as `current`.
        current = running;
      } catch (error) {
        instance.destroy();
        throw error;
      }
    },
    stop
  };
}
