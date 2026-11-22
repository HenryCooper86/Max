import { afterEach, describe, expect, it } from "vitest";
import type { EngineConfig, EngineEvents } from "../server/providers/live/engine";
import { createGeminiLiveEngine, redactGeminiSecrets } from "../server/providers/live/gemini-live";
import type { Logger } from "../server/logger";

// Gemini Live takes its API key in the WebSocket URL (?key=…). In Max Cloud the
// key is a customer's, and engine errors are both logged and shown to the
// connected client, so no error text this engine produces may carry the key.

const KEY = "AIzaSy-customer-secret_key+/=";
const ENCODED = encodeURIComponent(KEY);

class FakeSocket {
  readyState = 1;
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  on(event: string, handler: (...args: unknown[]) => void) {
    (this.handlers[event] ??= []).push(handler);
    return this;
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers[event] ?? []) handler(...args);
  }
}

const CONFIG: EngineConfig = {
  instructions: "You are Max.",
  voiceGender: "female",
  manualResponse: false,
  languages: ["en"],
  keyterms: [],
  tools: []
};

function capture() {
  const lines: string[] = [];
  const record = (message: string, fields?: Record<string, unknown>) =>
    lines.push(`${message} ${JSON.stringify(fields ?? {})}`);
  const log: Logger = { debug: record, info: record, warn: record, error: record };
  const seen: string[] = [];
  const events: EngineEvents = {
    onSpeechStarted: () => {},
    onRiderTranscript: () => {},
    onResponseStarted: () => {},
    onAgentText: () => {},
    onAgentAudio: () => {},
    onResponseDone: () => {},
    onError: (message) => seen.push(`error:${message}`),
    onClosed: (reason) => seen.push(`closed:${reason}`)
  };
  return { lines, seen, log, events };
}

function expectNoSecret(text: string) {
  expect(text).not.toContain(KEY);
  expect(text).not.toContain(ENCODED);
  expect(text).not.toContain("customer-secret");
}

afterEach(() => {
  delete process.env.GEMINI_LIVE_URL;
});

describe("Gemini Live key redaction", () => {
  it("redacts the key from a URL that the socket constructor rejects", async () => {
    const { lines, log, events } = capture();
    const engine = createGeminiLiveEngine(
      log,
      (url) => {
        throw new SyntaxError(`Invalid URL: ${url}`);
      },
      KEY
    );
    const failure = await engine.connect(CONFIG, events).then(
      () => "connected",
      (error: Error) => error.message
    );
    expect(failure).toContain("Gemini Live");
    expect(failure).toContain("key=[redacted]");
    expectNoSecret(failure);
    expectNoSecret(lines.join("\n"));
  });

  it("redacts socket errors, close reasons and server errors", async () => {
    const socket = new FakeSocket();
    let opened = "";
    const { lines, seen, log, events } = capture();
    const engine = createGeminiLiveEngine(
      log,
      (url) => {
        opened = url;
        return socket as never;
      },
      KEY
    );
    const ready = engine.connect(CONFIG, events);
    // The key does travel to Google: only what is reported is redacted.
    expect(opened).toContain(`?key=${ENCODED}`);
    socket.emit("message", Buffer.from(JSON.stringify({ setupComplete: {} })));
    await ready;

    socket.emit("message", Buffer.from(JSON.stringify({ error: { message: `API key ${KEY} is not valid` } })));
    socket.emit("error", new Error(`connect ECONNRESET ${opened}`));
    socket.emit("close", 1008, Buffer.from(`rejected request to ${opened}`));

    expect(seen).toHaveLength(2);
    for (const entry of [...seen, ...lines]) expectNoSecret(entry);
    expect(seen[0]).toContain("[redacted]");
    expect(seen[1]).toMatch(/^closed:closed \(1008 rejected request to wss:\/\/.*\?key=\[redacted\]/);
  });

  it("redacts the key in a failed connect's close reason", async () => {
    const socket = new FakeSocket();
    const { log, events } = capture();
    const ready = createGeminiLiveEngine(log, () => socket as never, KEY).connect(CONFIG, events);
    socket.emit("close", 1007, Buffer.from(`API key not valid: key=${ENCODED}&alt=json`));
    const failure = await ready.then(
      () => "connected",
      (error: Error) => error.message
    );
    expectNoSecret(failure);
    expect(failure).toContain("key=[redacted]&alt=json");
  });

  it("redacts any key= query parameter, not only the configured key", () => {
    expect(redactGeminiSecrets("wss://x/y?alt=json&key=abc123&z=1", [])).toBe("wss://x/y?alt=json&key=[redacted]&z=1");
    expect(redactGeminiSecrets("plain message", [KEY])).toBe("plain message");
    expect(redactGeminiSecrets(`raw ${KEY} and ${ENCODED}`, [KEY])).toBe("raw [redacted] and [redacted]");
  });
});
