import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../server/logger";
import { createStudioVoicesRouter, jsonParserExceptStudioVoices } from "../server/studio-voices";

// A fake speech server records what the relay forwards; the relay under test
// is the real router on an express app with a stand-in admin check.

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };
type Reply = { status?: number; type?: string; body?: string | Buffer; delayMs?: number };

let speech: http.Server;
let relay: http.Server;
let base = "";
let seen: Seen[];
let replies: Record<string, Reply>;
let logged: Array<{ message: string; fields?: Record<string, unknown> }>;
let aborted: number;
let cleared: string[];
let admin: { username: string; role: string } | null;
const saved = { url: process.env.MAX_SPEECH_URL, key: process.env.MAX_SPEECH_API_KEY };

const VOICE = "v_0123456789";
const CAND = "c_0123456789ab";
const voiceJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id: VOICE, name: "Ann", kind: "custom", ...extra });

beforeEach(async () => {
  seen = [];
  aborted = 0;
  cleared = [];
  logged = [];
  admin = { username: "root", role: "admin" };
  replies = {};
  speech = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      const reply = replies[`${req.method} ${req.url}`] ?? { status: 404, body: "{}" };
      res.on("close", () => {
        if (!res.writableFinished) aborted += 1;
      });
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(reply.status ?? 200, { "Content-Type": reply.type ?? "application/json" });
        res.end(reply.body ?? "{}");
      }, reply.delayMs ?? 0);
    });
  });
  speech.listen(0, "127.0.0.1");
  await once(speech, "listening");
  process.env.MAX_SPEECH_URL = `ws://127.0.0.1:${(speech.address() as AddressInfo).port}/v1/speech/session`;
  process.env.MAX_SPEECH_API_KEY = "sk-test";

  const log = {
    ...createLogger("test"),
    info: (message: string, fields?: Record<string, unknown>) => logged.push({ message, fields })
  };
  const app = express();
  // The relay's global parser skips these paths; mirror it, with the real 32 KB limit.
  app.use(jsonParserExceptStudioVoices("32kb"));
  app.post("/auth/admin/studio/other", (req, res) => res.json({ ok: true, got: req.body }));
  app.use(
    "/auth/admin/studio",
    createStudioVoicesRouter({
      log,
      clearAssistantVoice: (id) => {
        cleared.push(id);
        return id === VOICE;
      },
      requireAdmin: (_req, res) => {
        if (admin) return admin as never;
        res.status(401).json({ ok: false, error: "需要管理员登录。" });
        return null;
      }
    })
  );
  // A four-argument handler is what makes express treat this as an error handler.
  app.use(((error: { status?: number }, _req, res, next) => {
    void next;
    res.status(error.status ?? 500).json({ ok: false });
  }) as express.ErrorRequestHandler);
  relay = app.listen(0, "127.0.0.1");
  await once(relay, "listening");
  base = `http://127.0.0.1:${(relay.address() as AddressInfo).port}/auth/admin/studio`;
});

afterEach(async () => {
  for (const [name, value] of [
    ["MAX_SPEECH_URL", saved.url],
    ["MAX_SPEECH_API_KEY", saved.key]
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  speech.closeAllConnections();
  relay.closeAllConnections();
  speech.close();
  relay.close();
});

const send = (path: string, method = "GET", body?: unknown, raw?: string) =>
  fetch(`${base}${path}`, {
    method,
    ...(body !== undefined || raw !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: raw ?? JSON.stringify(body) }
      : {})
  });

const WAV = Buffer.from("RIFFxxxxWAVEfmt ").toString("base64");
const cloneBody = (extra: Record<string, unknown> = {}) => ({
  name: "Ann",
  gender: "female",
  languages: ["en", "zh"],
  transcript: "hello there",
  consent: true,
  consentStatement: "I, Ann, agree to have my voice cloned.",
  consentSpeaker: "Ann",
  audio: WAV,
  audioType: "audio/wav",
  ...extra
});

describe("studio voices: access", () => {
  it("answers 401 to a signed-out caller before reading the body or contacting the speech server", async () => {
    admin = null;
    expect((await send("/voices")).status).toBe(401);
    expect((await send("/voices", "POST", cloneBody())).status).toBe(401);
    expect((await send(`/voices/${VOICE}`, "DELETE")).status).toBe(401);
    expect((await send("/lexicon", "PUT", { entries: {} })).status).toBe(401);
    expect(seen).toEqual([]);
  });
});

describe("studio voices: list", () => {
  it("merges the voice list with discovery and sends the bearer key", async () => {
    replies["GET /v1/voices"] = { body: JSON.stringify({ voices: [{ id: "af_heart" }], cloning: true }) };
    replies["GET /.well-known/max-speech"] = {
      body: JSON.stringify({ features: { voice_design: true }, attributions: [{ model: "kokoro", text: "t" }] })
    };
    const response = await send("/voices");
    expect(await response.json()).toEqual({
      ok: true,
      available: true,
      cloning: true,
      design: true,
      voices: [{ id: "af_heart" }],
      attributions: [{ model: "kokoro", text: "t" }]
    });
    expect(seen.find((request) => request.url === "/v1/voices")?.headers.authorization).toBe("Bearer sk-test");
  });

  it("still lists voices when discovery fails", async () => {
    replies["GET /v1/voices"] = { body: JSON.stringify({ voices: [], cloning: false }) };
    const body = await (await send("/voices")).json();
    expect(body).toMatchObject({ available: true, design: false, attributions: [] });
  });

  it("reports available:false, with a reason, when unconfigured or unreachable", async () => {
    delete process.env.MAX_SPEECH_URL;
    const unset = await send("/voices");
    expect(unset.status).toBe(200);
    expect(await unset.json()).toMatchObject({
      ok: true,
      available: false,
      reason: expect.stringContaining("MAX_SPEECH_URL")
    });

    process.env.MAX_SPEECH_URL = "http://127.0.0.1:1";
    const down = await (await send("/voices")).json();
    expect(down).toMatchObject({ ok: true, available: false });
    expect(down.reason).toMatch(/reached/);
  });

  it("uses the max-speech backend's localhost default when only MAX_SPEECH=on is set", async () => {
    // The Studio and live sessions must agree on where Max Speech is.
    delete process.env.MAX_SPEECH_URL;
    const savedFlag = process.env.MAX_SPEECH;
    process.env.MAX_SPEECH = "on";
    const urls: string[] = [];
    const fake = (async (input: string | URL | Request) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ entries: {} }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const app = express();
    app.use(
      "/s",
      createStudioVoicesRouter({ log: createLogger("test"), requireAdmin: () => ({}) as never, request: fake })
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/s/lexicon`);
      expect(response.status).toBe(200);
      expect(urls[0]).toBe("http://localhost:8790/v1/lexicon");
    } finally {
      server.close();
      if (savedFlag === undefined) delete process.env.MAX_SPEECH;
      else process.env.MAX_SPEECH = savedFlag;
    }
  });

  it("answers other routes 503 speech_unavailable when unconfigured", async () => {
    delete process.env.MAX_SPEECH_URL;
    const response = await send(`/voices/${VOICE}/reference`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, code: "speech_unavailable" });
    expect((await send("/lexicon")).status).toBe(503);
  });

  it("maps a refused connection to 503", async () => {
    replies["GET /v1/lexicon"] = { delayMs: 300, body: "{}" };
    // The default allows 10 s; a closed port proves the mapping without waiting.
    process.env.MAX_SPEECH_URL = "http://127.0.0.1:1";
    expect((await send("/lexicon")).status).toBe(503);
  });
});

describe("studio voices: clone", () => {
  it("builds the multipart request and sets created_by to the admin, whatever the client says", async () => {
    replies["POST /v1/voices"] = { status: 201, body: voiceJson() };
    const response = await send("/voices", "POST", cloneBody({ created_by: "mallory", createdBy: "mallory" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: VOICE });
    const request = seen[0]!;
    expect(request.headers.authorization).toBe("Bearer sk-test");
    expect(request.headers["content-type"]).toMatch(/^multipart\/form-data/);
    const text = request.body.toString("latin1");
    for (const [field, value] of [
      ["name", "Ann"],
      ["transcript", "hello there"],
      ["languages", "en,zh"],
      ["gender", "female"],
      ["consent", "true"],
      ["consent_statement", "I, Ann, agree to have my voice cloned."],
      ["consent_speaker", "Ann"],
      ["created_by", "root"]
    ]) {
      expect(text).toMatch(new RegExp(`name="${field}"\\r\\n\\r\\n${value}\\r\\n`));
    }
    expect(text).not.toContain("mallory");
    expect(text).toMatch(/name="audio"; filename="[^"]+"\r\nContent-Type: audio\/wav\r\n\r\nRIFFxxxxWAVEfmt /);
  });

  it("logs the admin and voice, never the audio or the consent text", async () => {
    replies["POST /v1/voices"] = { status: 201, body: voiceJson() };
    await send("/voices", "POST", cloneBody());
    const line = JSON.stringify(logged);
    expect(line).toContain("root");
    expect(line).not.toContain("agree to have my voice");
    expect(line).not.toContain(WAV);
  });

  it("rejects bad shapes before contacting the speech server", async () => {
    const bads: Array<Record<string, unknown>> = [
      { name: "" },
      { name: "x".repeat(65) },
      { consent: false },
      { consent: "true" },
      { consentStatement: "x".repeat(1001) },
      { consentSpeaker: "x".repeat(129) },
      { transcript: "x".repeat(1001) },
      { languages: Array.from({ length: 9 }, () => "en") },
      { languages: ["x".repeat(13)] },
      { languages: ["en,zh"] },
      { languages: "en" },
      { gender: "robot" },
      { audio: "not base64!!" },
      { audio: "" },
      { audio: undefined },
      { audioType: "text/html" }
    ];
    for (const extra of bads) {
      const response = await send("/voices", "POST", cloneBody(extra));
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it("refuses audio over 9 MB decoded but accepts a long recording", async () => {
    replies["POST /v1/voices"] = { status: 201, body: voiceJson() };
    // The 12 MB body limit and the 9 MB decoded cap guard the same thing; either may fire first.
    const over = Buffer.alloc(9 * 1024 * 1024 + 3).toString("base64");
    expect([400, 413]).toContain((await send("/voices", "POST", cloneBody({ audio: over }))).status);
    expect(seen).toEqual([]);
    const ok = Buffer.alloc(8 * 1024 * 1024).toString("base64");
    expect((await send("/voices", "POST", cloneBody({ audio: ok }))).status).toBe(201);
  });

  it("applies the 12 MB limit to this route, and the global 32 KB limit to everything else", async () => {
    const huge = await send("/voices", "POST", cloneBody({ audio: "A".repeat(13 * 1024 * 1024) }));
    expect(huge.status).toBe(413);
    const medium = await send(`/voices/${VOICE}/preview`, "POST", { text: "x".repeat(70 * 1024) });
    expect(medium.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it("maps speech-server errors, keeping the status", async () => {
    replies["POST /v1/voices"] = {
      status: 400,
      body: JSON.stringify({ error: { code: "consent_required", message: "the statement is too short" } })
    };
    const response = await send("/voices", "POST", cloneBody());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, code: "consent_required", error: "the statement is too short" });

    replies["POST /v1/voices"] = {
      status: 409,
      body: JSON.stringify({ error: { code: "cloning_unavailable", message: "no" } })
    };
    expect((await send("/voices", "POST", cloneBody())).status).toBe(409);
  });

  it("does not pass the relay's key refusal on as a signed-out admin", async () => {
    replies["GET /v1/lexicon"] = {
      status: 401,
      body: JSON.stringify({ error: { code: "invalid_api_key", message: "no" } })
    };
    const response = await send("/lexicon");
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "speech_unauthorized" });
  });
});

describe("studio voices: one voice", () => {
  it("validates ids and answers 404 without forwarding", async () => {
    for (const id of ["v_zz", "design", "v_0123456789a", "V_0123456789", "..%2F..%2Fv1%2Flexicon", "v_0123456789%0A"]) {
      for (const [path, method] of [
        [`/voices/${id}`, "DELETE"],
        [`/voices/${id}`, "PATCH"],
        [`/voices/${id}/reference`, "GET"],
        [`/voices/${id}/preview`, "POST"]
      ]) {
        const response = await send(path!, method, method === "GET" ? undefined : {});
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }
    for (const cid of ["c_zz", "c_0123456789a", "x", VOICE]) {
      expect((await send(`/voices/design/${cid}/audio`)).status).toBe(404);
      expect((await send(`/voices/design/${cid}/save`, "POST", { name: "n" })).status).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it("renames and edits with a validated patch", async () => {
    replies[`PATCH /v1/voices/${VOICE}`] = { body: voiceJson({ name: "Bea" }) };
    const response = await send(`/voices/${VOICE}`, "PATCH", {
      name: "Bea",
      languages: ["en"],
      gender: "neutral",
      transcript: "t",
      evil: 1
    });
    expect(await response.json()).toMatchObject({ name: "Bea" });
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({
      name: "Bea",
      languages: ["en"],
      gender: "neutral",
      transcript: "t"
    });
    expect(logged.some((line) => line.message.includes("renamed") && line.fields?.by === "root")).toBe(true);
    expect((await send(`/voices/${VOICE}`, "PATCH", {})).status).toBe(400);
    expect((await send(`/voices/${VOICE}`, "PATCH", { name: "x".repeat(65) })).status).toBe(400);
  });

  it("deletes with 204 and logs it", async () => {
    replies[`DELETE /v1/voices/${VOICE}`] = { status: 204, body: "" };
    const response = await send(`/voices/${VOICE}`, "DELETE");
    expect(response.status).toBe(204);
    expect(logged.some((line) => line.message.includes("deleted") && line.fields?.by === "root")).toBe(true);
    replies[`DELETE /v1/voices/${VOICE}`] = {
      status: 404,
      body: JSON.stringify({ error: { code: "voice_not_found", message: "gone" } })
    };
    const missing = await send(`/voices/${VOICE}`, "DELETE");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "voice_not_found" });
  });

  it("streams the reference and preview audio through with their content type", async () => {
    replies[`GET /v1/voices/${VOICE}/reference`] = { type: "audio/wav", body: Buffer.from("RIFF-ref") };
    const reference = await send(`/voices/${VOICE}/reference`);
    expect(reference.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await reference.arrayBuffer()).toString()).toBe("RIFF-ref");

    replies[`POST /v1/voices/${VOICE}/preview`] = { type: "audio/wav", body: Buffer.from("RIFF-prev") };
    const preview = await send(`/voices/${VOICE}/preview`, "POST", { text: "hi" });
    expect(Buffer.from(await preview.arrayBuffer()).toString()).toBe("RIFF-prev");
    expect(JSON.parse(seen.at(-1)!.body.toString())).toEqual({ text: "hi" });

    expect((await send(`/voices/${VOICE}/preview`, "POST", { text: "x".repeat(301) })).status).toBe(400);
    expect((await send(`/voices/${VOICE}/preview`, "POST", { text: 5 })).status).toBe(400);
  });

  it("previews preset voices through the speech endpoint with a default line", async () => {
    replies["POST /v1/audio/speech"] = { type: "audio/wav", body: Buffer.from("RIFF-preset") };
    const en = await send("/voices/af_heart/preview", "POST", {});
    expect(en.status).toBe(200);
    expect(en.headers.get("content-type")).toBe("audio/wav");
    expect(en.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await en.arrayBuffer()).toString()).toBe("RIFF-preset");
    expect(JSON.parse(seen.at(-1)!.body.toString())).toEqual({
      model: "kokoro",
      voice: "af_heart",
      input: "Hello, this is my voice.",
      response_format: "wav"
    });
    await send("/voices/zf_002/preview", "POST", {});
    expect(JSON.parse(seen.at(-1)!.body.toString())).toMatchObject({ voice: "zf_002", input: "你好，这是我的声音。" });
    await send("/voices/zm_009/preview", "POST", { text: "custom line" });
    expect(JSON.parse(seen.at(-1)!.body.toString())).toMatchObject({ voice: "zm_009", input: "custom line" });
  });

  it("rejects ids that are neither custom nor preset", async () => {
    for (const id of ["AF_heart", "afff_heart", "af_", "af-heart", `af_${"a".repeat(25)}`]) {
      expect((await send(`/voices/${id}/preview`, "POST", {})).status, id).toBe(404);
    }
  });

  it("accepts a preview with no body", async () => {
    replies[`POST /v1/voices/${VOICE}/preview`] = { type: "audio/wav", body: Buffer.from("RIFF") };
    expect((await fetch(`${base}/voices/${VOICE}/preview`, { method: "POST" })).status).toBe(200);
  });
});

describe("studio voices: design", () => {
  it("forwards a validated request and trims the candidates", async () => {
    replies["POST /v1/voices/design"] = {
      body: JSON.stringify({
        candidates: [{ id: CAND, text: "Hi", description: "warm", language: "en", expires_at: "later" }]
      })
    };
    const response = await send("/voices/design", "POST", {
      description: "warm",
      text: "Hi",
      language: "en",
      count: 2,
      extra: 1
    });
    expect(await response.json()).toEqual({ ok: true, candidates: [{ id: CAND, text: "Hi", description: "warm" }] });
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ description: "warm", text: "Hi", language: "en", count: 2 });
  });

  it("rejects bad design requests", async () => {
    for (const body of [
      {},
      { description: "" },
      { description: "x".repeat(301) },
      { description: "d", text: "x".repeat(301) },
      { description: "d", count: 0 },
      { description: "d", count: 4 },
      { description: "d", count: 1.5 },
      { description: "d", language: "en us!" }
    ]) {
      expect((await send("/voices/design", "POST", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it("maps design_unavailable", async () => {
    replies["POST /v1/voices/design"] = {
      status: 409,
      body: JSON.stringify({ error: { code: "design_unavailable", message: "none" } })
    };
    const response = await send("/voices/design", "POST", { description: "warm" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "design_unavailable" });
  });

  it("streams candidate audio", async () => {
    replies[`GET /v1/voices/design/${CAND}/audio`] = { type: "audio/wav", body: Buffer.from("RIFF-c") };
    const response = await send(`/voices/design/${CAND}/audio`);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("RIFF-c");
  });

  it("saves a candidate as a voice with created_by set to the admin", async () => {
    replies[`POST /v1/voices/design/${CAND}/save`] = { status: 201, body: voiceJson({ origin: "designed" }) };
    const response = await send(`/voices/design/${CAND}/save`, "POST", {
      name: "Bright",
      gender: "male",
      languages: ["en"],
      created_by: "mallory"
    });
    expect(response.status).toBe(201);
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({
      name: "Bright",
      created_by: "root",
      gender: "male",
      languages: ["en"]
    });
    expect(logged.some((line) => line.message.includes("designed") && line.fields?.by === "root")).toBe(true);
    expect((await send(`/voices/design/${CAND}/save`, "POST", {})).status).toBe(400);
  });
});

describe("studio voices: lexicon", () => {
  it("reads and replaces the lexicon, and logs the change", async () => {
    replies["GET /v1/lexicon"] = { body: JSON.stringify({ entries: { GIF: "jif" } }) };
    expect(await (await send("/lexicon")).json()).toEqual({ entries: { GIF: "jif" } });
    replies["PUT /v1/lexicon"] = { body: JSON.stringify({ entries: { SQL: "sequel" } }) };
    const response = await send("/lexicon", "PUT", { entries: { SQL: "sequel" } });
    expect(await response.json()).toEqual({ entries: { SQL: "sequel" } });
    expect(JSON.parse(seen.at(-1)!.body.toString())).toEqual({ entries: { SQL: "sequel" } });
    expect(logged.some((line) => line.message.includes("lexicon") && line.fields?.by === "root")).toBe(true);
  });

  it("holds 500 entries but refuses 501, and non-text values", async () => {
    const make = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`word${index}`, "spoken"]));
    replies["PUT /v1/lexicon"] = { body: "{}" };
    expect((await send("/lexicon", "PUT", { entries: make(500) })).status).toBe(200);
    seen.length = 0;
    expect((await send("/lexicon", "PUT", { entries: make(501) })).status).toBe(400);
    expect((await send("/lexicon", "PUT", { entries: { a: 1 } })).status).toBe(400);
    expect((await send("/lexicon", "PUT", { entries: [] })).status).toBe(400);
    expect((await send("/lexicon", "PUT", {})).status).toBe(400);
    expect(seen).toEqual([]);
  });
});

describe("studio voices: robustness", () => {
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  };

  it("aborts the upstream call when the browser goes away", async () => {
    replies[`POST /v1/voices/${VOICE}/preview`] = { delayMs: 5000, type: "audio/wav", body: "RIFF" };
    const controller = new AbortController();
    const pending = fetch(`${base}/voices/${VOICE}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: controller.signal
    }).catch(() => undefined);
    await until(() => seen.length > 0);
    controller.abort();
    await pending;
    await until(() => aborted > 0);
    expect(aborted).toBe(1);
  });

  it("stops the upstream audio download when the listener leaves", async () => {
    const stream = http.createServer((_req, res) => {
      res.on("close", () => {
        if (!res.writableFinished) aborted += 1;
      });
      res.writeHead(200, { "Content-Type": "audio/wav" });
      const timer = setInterval(() => res.write(Buffer.alloc(16_384)), 10);
      res.on("close", () => clearInterval(timer));
    });
    stream.listen(0, "127.0.0.1");
    await once(stream, "listening");
    process.env.MAX_SPEECH_URL = `ws://127.0.0.1:${(stream.address() as AddressInfo).port}/v1/speech/session`;
    try {
      const response = await fetch(`${base}/voices/${VOICE}/reference`);
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      await until(() => aborted > 0);
      expect(aborted).toBe(1);
    } finally {
      stream.closeAllConnections();
      stream.close();
    }
  });

  it("maps a non-error upstream status to 502 speech_bad_response", async () => {
    replies[`GET /v1/lexicon`] = { status: 302, body: "" };
    const response = await send("/lexicon");
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("speech_bad_response");
  });

  it("gives a clip that is too big the readable 400, not a bare 413", async () => {
    const big = Buffer.alloc(9 * 1024 * 1024 + 1000, 1).toString("base64");
    const response = await send("/voices", "POST", cloneBody({ audio: big }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/9 MB/);
  });

  it("clears the assistant's voice after deleting the voice it uses", async () => {
    replies[`DELETE /v1/voices/${VOICE}`] = { status: 204, body: "" };
    expect((await send(`/voices/${VOICE}`, "DELETE")).status).toBe(204);
    expect(cleared).toEqual([VOICE]);
  });

  it("keeps the global 32 KB limit on other studio routes but not on voice routes", async () => {
    const big = { text: "x".repeat(40_000) };
    expect((await send("/other", "POST", big)).status).toBe(413);
    expect((await send("/other", "POST", { text: "ok" })).status).toBe(200);
    replies["PUT /v1/lexicon"] = { body: "{}" };
    expect((await send("/lexicon", "PUT", { entries: { a: "b".repeat(40_000) } })).status).toBe(200);
  });
});
