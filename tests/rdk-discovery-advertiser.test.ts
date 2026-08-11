import { describe, expect, it } from "vitest";
import {
  createDiscoveryAdvertiser,
  type DiscoveryTransport
} from "../rdk/agent/src/discovery/advertiser";

type FakeTransport = DiscoveryTransport & {
  calls: string[];
  failNextStart(message: string): void;
  gate(): { release(): void };
};

function fakeTransport(name: string): FakeTransport {
  const calls: string[] = [];
  let failure: string | undefined;
  let gate: Promise<void> | undefined;
  let releaseGate: (() => void) | undefined;
  return {
    name,
    calls,
    failNextStart(message) {
      failure = message;
    },
    gate() {
      gate = new Promise((resolve) => {
        releaseGate = resolve;
      });
      return { release: () => releaseGate?.() };
    },
    async start(token) {
      calls.push(`start:${token}`);
      if (gate) {
        const wait = gate;
        gate = undefined;
        await wait;
      }
      if (failure) {
        const message = failure;
        failure = undefined;
        throw new Error(message);
      }
    },
    async stop() {
      calls.push("stop");
    }
  };
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("discovery advertiser", () => {
  const TOKEN = "a".repeat(32);

  it("starts every transport with the token and reports status", async () => {
    const mdns = fakeTransport("mdns");
    const statuses: string[] = [];
    const advertiser = createDiscoveryAdvertiser({ transports: [mdns], onStatus: (s) => statuses.push(s) });
    advertiser.setToken(TOKEN);
    await settled();
    expect(mdns.calls).toEqual([`start:${TOKEN}`]);
    expect(advertiser.status()).toBe("mdns");
    expect(statuses).toEqual(["mdns"]);
    await advertiser.close();
  });

  it("stops on null and reports off", async () => {
    const mdns = fakeTransport("mdns");
    const advertiser = createDiscoveryAdvertiser({ transports: [mdns] });
    advertiser.setToken(TOKEN);
    advertiser.setToken(null);
    await settled();
    expect(mdns.calls).toEqual([`start:${TOKEN}`, "stop"]);
    expect(advertiser.status()).toBe("off");
    await advertiser.close();
  });

  it("tears down cleanly when a stop interrupts a slow start", async () => {
    const mdns = fakeTransport("mdns");
    const gate = mdns.gate();
    const advertiser = createDiscoveryAdvertiser({ transports: [mdns] });
    advertiser.setToken(TOKEN);
    advertiser.setToken(null);
    gate.release();
    await settled();
    expect(mdns.calls).toEqual([`start:${TOKEN}`, "stop"]);
    expect(advertiser.status()).toBe("off");
    await advertiser.close();
  });

  it("keeps other transports alive when one fails, and logs without the token", async () => {
    const mdns = fakeTransport("mdns");
    const flaky = fakeTransport("flaky");
    flaky.failNextStart("dbus unavailable");
    const lines: string[] = [];
    const advertiser = createDiscoveryAdvertiser({ transports: [mdns, flaky], log: (line) => lines.push(line) });
    advertiser.setToken(TOKEN);
    await settled();
    expect(advertiser.status()).toBe("mdns");
    expect(lines.some((line) => line.includes("flaky failed"))).toBe(true);
    expect(lines.every((line) => !line.includes(TOKEN))).toBe(true);
    await advertiser.close();
  });

  it("rotating the token restarts transports with the new one", async () => {
    const mdns = fakeTransport("mdns");
    const advertiser = createDiscoveryAdvertiser({ transports: [mdns] });
    advertiser.setToken(TOKEN);
    await settled();
    advertiser.setToken("b".repeat(32));
    await settled();
    expect(mdns.calls).toEqual([`start:${TOKEN}`, `start:${"b".repeat(32)}`]);
    await advertiser.close();
  });

  it("close stops transports and disables later setToken", async () => {
    const mdns = fakeTransport("mdns");
    const advertiser = createDiscoveryAdvertiser({ transports: [mdns] });
    advertiser.setToken(TOKEN);
    await advertiser.close();
    advertiser.setToken(TOKEN);
    await settled();
    expect(mdns.calls).toEqual([`start:${TOKEN}`, "stop"]);
    expect(advertiser.status()).toBe("off");
  });

  it("rapid back-to-back setToken calls with no settle between them still converge to the final token, in order", async () => {
    const mdns = fakeTransport("mdns");
    const advertiser = createDiscoveryAdvertiser({ transports: [mdns] });
    const NEW_TOKEN = "b".repeat(32);
    advertiser.setToken(TOKEN);
    advertiser.setToken(NEW_TOKEN); // no await/settled() between these two calls
    await settled();
    expect(mdns.calls).toEqual([`start:${TOKEN}`, `start:${NEW_TOKEN}`]);
    expect(advertiser.status()).toBe("mdns");
    await advertiser.close();
  });

  it("rejoins status() once a later setToken succeeds after an earlier failure", async () => {
    const flaky = fakeTransport("flaky");
    flaky.failNextStart("dbus unavailable");
    const advertiser = createDiscoveryAdvertiser({ transports: [flaky] });
    advertiser.setToken(TOKEN);
    await settled();
    expect(advertiser.status()).toBe("off");
    const NEW_TOKEN = "b".repeat(32);
    advertiser.setToken(NEW_TOKEN);
    await settled();
    expect(advertiser.status()).toBe("flaky");
    expect(flaky.calls).toEqual([`start:${TOKEN}`, `start:${NEW_TOKEN}`]);
    await advertiser.close();
  });
});
