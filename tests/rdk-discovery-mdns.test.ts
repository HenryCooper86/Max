import { describe, expect, it } from "vitest";
import { createMdnsTransport, type MdnsLike } from "../rdk/agent/src/discovery/mdns";

const TOKEN = "a".repeat(32);
const SERVICE = "_maxhelmet._tcp.local";

function fakeMdns() {
  const responses: Array<{ answers: Array<{ name: string; type: string; data: unknown }> }> = [];
  let onQuery: ((query: { questions: Array<{ name: string; type: string }> }) => void) | undefined;
  let destroyed = false;
  const instance: MdnsLike = {
    on(_event, listener) {
      onQuery = listener;
    },
    respond(response) {
      responses.push(response as (typeof responses)[number]);
    },
    destroy(callback) {
      destroyed = true;
      callback?.();
    }
  };
  return {
    instance,
    responses,
    ask: (name: string, type: string) => onQuery?.({ questions: [{ name, type }] }),
    destroyed: () => destroyed
  };
}

describe("mdns discovery transport", () => {
  it("answers a PTR query with instance, SRV, and a TXT carrying the token", async () => {
    const fake = fakeMdns();
    const transport = createMdnsTransport({ port: 8080, mdnsFactory: () => fake.instance });
    await transport.start(TOKEN);
    fake.ask(SERVICE, "PTR");
    expect(fake.responses.length).toBe(1);
    const answers = fake.responses[0].answers;
    const ptr = answers.find((answer) => answer.type === "PTR");
    const srv = answers.find((answer) => answer.type === "SRV");
    const txt = answers.find((answer) => answer.type === "TXT");
    expect(ptr?.name).toBe(SERVICE);
    expect(String(ptr?.data)).toMatch(/\._maxhelmet\._tcp\.local$/);
    expect((srv?.data as { port: number }).port).toBe(8080);
    expect(txt?.data).toEqual([`dt=${TOKEN}`, "v=1"]);
    await transport.stop();
    expect(fake.destroyed()).toBe(true);
  });

  it("ignores unrelated queries and answers nothing after stop", async () => {
    const fake = fakeMdns();
    const transport = createMdnsTransport({ port: 8080, mdnsFactory: () => fake.instance });
    await transport.start(TOKEN);
    fake.ask("_other._tcp.local", "PTR");
    expect(fake.responses).toEqual([]);
    await transport.stop();
    fake.ask(SERVICE, "PTR");
    expect(fake.responses).toEqual([]);
  });

  it("a restart with a new token answers with the new token only", async () => {
    const fake = fakeMdns();
    let created = 0;
    const transport = createMdnsTransport({
      port: 8080,
      mdnsFactory: () => {
        created += 1;
        return fake.instance;
      }
    });
    await transport.start(TOKEN);
    await transport.start("b".repeat(32));
    fake.ask(SERVICE, "PTR");
    const txt = fake.responses.at(-1)?.answers.find((answer) => answer.type === "TXT");
    expect(txt?.data).toEqual([`dt=${"b".repeat(32)}`, "v=1"]);
    expect(created).toBe(2);
  });

  it("stop is safe when the transport was never started", async () => {
    // The advertiser can issue a spurious stop on close-before-any-token.
    const transport = createMdnsTransport({ port: 8080, mdnsFactory: () => fakeMdns().instance });
    await expect(transport.stop()).resolves.toBeUndefined();
  });

  it("destroys the responder it already created when start rejects, since the advertiser never issues a matching stop for a start that threw", async () => {
    let destroyed = false;
    const instance: MdnsLike = {
      on() {
        throw new Error("boom");
      },
      respond() {
        throw new Error("should never respond");
      },
      destroy(callback) {
        destroyed = true;
        callback?.();
      }
    };
    const transport = createMdnsTransport({ port: 8080, mdnsFactory: () => instance });
    await expect(transport.start(TOKEN)).rejects.toThrow("boom");
    expect(destroyed).toBe(true);
  });
});
