import { Readable } from "node:stream";
import express from "express";
import type { PublicUser } from "./accounts";
import type { Logger } from "./logger";
import { env } from "./providers/live/engine";
import { maxSpeechEnabled, maxSpeechUrl } from "./providers/live/max-speech";

/**
 * The Studio's window onto Max Speech's custom voices. The relay holds the
 * speech server's address and key, so the browser never sees either; this
 * module validates every request, then forwards it with the key attached.
 *
 * Request sizes are limited per route, after the admin check, so a signed-out
 * caller can never make the relay buffer a recording. The relay's global JSON
 * parser must therefore skip these paths (see jsonParserExceptStudioVoices).
 */

/** Paths the global JSON parser leaves alone: each route here sets its own limit. */
const STUDIO_VOICE_PREFIXES = ["/auth/admin/studio/voices", "/auth/admin/studio/lexicon"];

/** The relay's global JSON parser: everywhere except the Studio voice routes, which set their own limits. */
export function jsonParserExceptStudioVoices(limit: string): express.RequestHandler {
  const parse = express.json({ limit, strict: true });
  return (req, res, next) => {
    if (STUDIO_VOICE_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) next();
    else parse(req, res, next);
  };
}

const VOICE_ID = /^v_[0-9a-f]{10}$/;
/** Kokoro presets such as af_heart or zf_002. The v_ prefix belongs to custom voices only. */
const PRESET_ID = /^(?!v_)[a-z]{1,3}[fm]?_[a-z0-9]{1,24}$/;
const CANDIDATE_ID = /^c_[0-9a-f]{12}$/;
const LANGUAGE = /^[A-Za-z0-9-]{1,12}$/;
const GENDERS = ["female", "male", "neutral"];

const DEFAULT_TIMEOUT_MS = 10_000;
/** Cloning and design may run a model before they answer. */
const SLOW_TIMEOUT_MS = 120_000;
const MAX_AUDIO_BYTES = 9 * 1024 * 1024;
const MAX_LEXICON_ENTRIES = 500;

const SMALL_LIMIT = "64kb";
// base64 of 9 MiB is about 12.6 MB; the limit leaves headroom so a clip that is
// too big gets the readable 400 below instead of a bare 413.
const CLONE_LIMIT = "12.5mb";
// 500 entries of up to 64 + 128 characters can outgrow the small limit.
const LEXICON_LIMIT = "256kb";

type Dependencies = {
  requireAdmin(req: express.Request, res: express.Response): PublicUser | null;
  log: Logger;
  /** Clears the assistant's saved voice when it is this id; true when it did. */
  clearAssistantVoice?: (id: string) => boolean;
  /** Test seam; defaults to the global fetch. */
  request?: typeof fetch;
};

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const bad = (message: string) => new HttpFailure(400, "invalid_request", message);
const unavailable = (message: string) => new HttpFailure(503, "speech_unavailable", message);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad("Send a JSON object.");
  return value as Record<string, unknown>;
}

function text(body: Record<string, unknown>, key: string, max: number, required = false): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw bad(`${key} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw bad(`${key} must be text.`);
  if (value.length > max) throw bad(`${key} must be at most ${max} characters.`);
  if (required && !value.trim()) throw bad(`${key} is required.`);
  return value;
}

function languages(body: Record<string, unknown>): string[] | undefined {
  const value = body.languages;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 8) throw bad("languages must be a list of at most 8 codes.");
  for (const item of value) {
    if (typeof item !== "string" || !LANGUAGE.test(item)) throw bad("Each language must be a short code such as en.");
  }
  return value as string[];
}

function gender(body: Record<string, unknown>): string | undefined {
  const value = text(body, "gender", 16);
  if (value !== undefined && !GENDERS.includes(value)) throw bad("gender must be female, male or neutral.");
  return value;
}

/** Where the speech server's HTTP API lives, derived from the session URL the
 *  `max-speech` backend uses, so the Studio and live sessions always agree
 *  (including the localhost default when only MAX_SPEECH=on is set). */
function speechBase(): URL | undefined {
  if (!maxSpeechEnabled()) return undefined;
  try {
    const url = new URL(maxSpeechUrl(env("MAX_SPEECH_URL")));
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return url;
  } catch {
    return undefined;
  }
}

export function createStudioVoicesRouter({
  requireAdmin,
  log,
  clearAssistantVoice,
  request = fetch
}: Dependencies): express.Router {
  const router = express.Router();

  async function call(
    path: string,
    init: { method?: string; json?: unknown; form?: FormData; timeoutMs?: number; abort?: AbortSignal } = {}
  ): Promise<Response> {
    const base = speechBase();
    if (!base) throw unavailable("Max Speech is not enabled: set MAX_SPEECH=on or MAX_SPEECH_URL.");
    const headers: Record<string, string> = {};
    const key = env("MAX_SPEECH_API_KEY");
    if (key) headers.Authorization = `Bearer ${key}`;
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) {
      body = init.form;
    }
    let response: Response;
    try {
      response = await request(new URL(path, base), {
        method: init.method ?? "GET",
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: "manual",
        signal: init.abort
          ? AbortSignal.any([init.abort, AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS)])
          : AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw unavailable(timedOut ? "Max Speech did not answer in time." : "Max Speech could not be reached.");
    }
    if (response.ok) return response;
    throw await upstreamFailure(response);
  }

  async function upstreamFailure(response: Response): Promise<HttpFailure> {
    let code = "speech_error";
    let message = `Max Speech answered ${response.status}.`;
    try {
      const parsed = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
      if (typeof parsed.error?.code === "string") code = parsed.error.code;
      if (typeof parsed.error?.message === "string") message = parsed.error.message;
    } catch {
      // Not the speech server's error shape; keep the generic one.
    }
    // Redirects and other non-error statuses are not an answer the relay can relay.
    if (response.status < 400 || response.status >= 600) {
      return new HttpFailure(502, "speech_bad_response", "Max Speech sent an unexpected answer.");
    }
    // The browser reads 401/403 as "your Max session ended", which is not what
    // happened: the relay's key for the speech server was refused.
    if (response.status === 401 || response.status === 403) {
      return new HttpFailure(502, "speech_unauthorized", "Max Speech refused the relay's key (MAX_SPEECH_API_KEY).");
    }
    return new HttpFailure(response.status, code, message);
  }

  const json = async (response: Response): Promise<unknown> => {
    try {
      return await response.json();
    } catch {
      throw new HttpFailure(502, "speech_error", "Max Speech sent an unreadable answer.");
    }
  };

  async function sendAudio(res: express.Response, response: Response): Promise<void> {
    const type = response.headers.get("content-type") ?? "";
    res.status(200);
    res.setHeader("Content-Type", type.startsWith("audio/") ? type : "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    if (!response.body) {
      res.end();
      return;
    }
    const stream = Readable.fromWeb(response.body as never);
    stream.on("error", () => res.destroy());
    // A listener who left stops the upstream download too.
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  type Context = {
    admin: PublicUser;
    req: express.Request;
    res: express.Response;
    /** `call`, aborted when the browser goes away before the answer is sent. */
    call: typeof call;
  };

  /** Admin check, id checks, then this route's own body parser, in that order. */
  function route(
    options: { limit?: string; ids?: Array<"id" | "cid" | "playable"> },
    handler: (context: Context) => Promise<void>
  ): express.RequestHandler[] {
    const gate: express.RequestHandler = (req, res, next) => {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      res.locals.admin = admin;
      for (const name of options.ids ?? []) {
        const value = String(req.params[name === "cid" ? "cid" : "id"] ?? "");
        const pattern = name === "cid" ? CANDIDATE_ID : name === "id" ? VOICE_ID : null;
        if (!(pattern ? pattern.test(value) : VOICE_ID.test(value) || PRESET_ID.test(value))) {
          res.status(404).json({ ok: false, code: "voice_not_found", error: "No such voice." });
          return;
        }
      }
      next();
    };
    const parsers = options.limit ? [express.json({ limit: options.limit, strict: true })] : [];
    const run: express.RequestHandler = (req, res) => {
      const gone = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) gone.abort();
      });
      const bound: typeof call = (path, init = {}) => call(path, { ...init, abort: gone.signal });
      handler({ admin: res.locals.admin as PublicUser, req, res, call: bound }).catch((error: unknown) => {
        if (res.headersSent) return;
        if (error instanceof HttpFailure) {
          res.status(error.status).json({ ok: false, code: error.code, error: error.message });
          return;
        }
        log.error("studio voices request failed", {
          message: error instanceof Error ? error.message : String(error)
        });
        res.status(500).json({ ok: false, code: "internal_error", error: "服务器内部错误。" });
      });
    };
    return [gate, ...parsers, run];
  }

  router.get(
    "/voices",
    ...route({}, async ({ call, res }) => {
      let list: Response;
      try {
        list = await call("/v1/voices");
      } catch (error) {
        if (error instanceof HttpFailure && error.code === "speech_unavailable") {
          res.json({ ok: true, available: false, reason: error.message });
          return;
        }
        throw error;
      }
      const listed = record(await json(list));
      // Discovery is public data; the section still works without it.
      let discovery: Record<string, unknown> = {};
      try {
        discovery = record(await json(await call("/.well-known/max-speech")));
      } catch {
        // Credits and the design flag are shown when available.
      }
      res.json({
        ok: true,
        available: true,
        cloning: listed.cloning === true,
        design: record(discovery.features ?? {}).voice_design === true,
        voices: Array.isArray(listed.voices) ? listed.voices : [],
        attributions: Array.isArray(discovery.attributions) ? discovery.attributions : []
      });
    })
  );

  router.post(
    "/voices",
    ...route({ limit: CLONE_LIMIT }, async ({ call, admin, req, res }) => {
      const body = record(req.body);
      const name = text(body, "name", 64, true) as string;
      const statement = text(body, "consentStatement", 1000, true) as string;
      const speaker = text(body, "consentSpeaker", 128, true) as string;
      const transcript = text(body, "transcript", 1000);
      const voiceGender = gender(body);
      const voiceLanguages = languages(body);
      if (body.consent !== true) throw new HttpFailure(400, "consent_required", "Consent is required.");
      const encoded = body.audio;
      if (typeof encoded !== "string" || !encoded) throw bad("audio is required.");
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw bad("audio must be base64.");
      const audio = Buffer.from(encoded, "base64");
      if (audio.length === 0) throw bad("audio is empty.");
      if (audio.length > MAX_AUDIO_BYTES) throw bad("The recording must be 9 MB or smaller.");
      const audioType = text(body, "audioType", 64) ?? "audio/wav";
      if (!/^audio\/[A-Za-z0-9.+-]+$/.test(audioType)) throw bad("audioType must be an audio type.");

      const form = new FormData();
      form.set("audio", new Blob([audio], { type: audioType }), "reference.wav");
      form.set("name", name);
      if (transcript) form.set("transcript", transcript);
      if (voiceLanguages?.length) form.set("languages", voiceLanguages.join(","));
      if (voiceGender) form.set("gender", voiceGender);
      form.set("consent", "true");
      form.set("consent_statement", statement);
      form.set("consent_speaker", speaker);
      // The record of who made a voice is the signed-in admin's, never the client's.
      form.set("created_by", admin.username);
      const created = record(
        await json(await call("/v1/voices", { method: "POST", form, timeoutMs: SLOW_TIMEOUT_MS }))
      );
      log.info("custom voice cloned from studio", { by: admin.username, voice: created.id });
      res.status(201).json(created);
    })
  );

  router.patch(
    "/voices/:id",
    ...route({ limit: SMALL_LIMIT, ids: ["id"] }, async ({ call, admin, req, res }) => {
      const body = record(req.body);
      const patch: Record<string, unknown> = {};
      const name = text(body, "name", 64);
      if (name !== undefined) patch.name = name;
      const voiceLanguages = languages(body);
      if (voiceLanguages) patch.languages = voiceLanguages;
      const voiceGender = gender(body);
      if (voiceGender) patch.gender = voiceGender;
      if (typeof body.transcript === "string") patch.transcript = text(body, "transcript", 1000) ?? "";
      if (Object.keys(patch).length === 0) throw bad("Nothing to change.");
      const id = req.params.id as string;
      const voice = await json(await call(`/v1/voices/${id}`, { method: "PATCH", json: patch }));
      if (patch.name !== undefined) log.info("custom voice renamed from studio", { by: admin.username, voice: id });
      res.json(voice);
    })
  );

  router.delete(
    "/voices/:id",
    ...route({ ids: ["id"] }, async ({ call, admin, req, res }) => {
      const id = req.params.id as string;
      await call(`/v1/voices/${id}`, { method: "DELETE" });
      log.info("custom voice deleted from studio", { by: admin.username, voice: id });
      try {
        if (clearAssistantVoice?.(id)) {
          log.info("assistant voice cleared after its voice was deleted", { by: admin.username, voice: id });
        }
      } catch (error) {
        log.error("could not clear the assistant voice", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
      res.status(204).end();
    })
  );

  router.get(
    "/voices/:id/reference",
    ...route({ ids: ["id"] }, async ({ call, req, res }) => {
      await sendAudio(res, await call(`/v1/voices/${req.params.id as string}/reference`));
    })
  );

  router.post(
    "/voices/:id/preview",
    ...route({ limit: SMALL_LIMIT, ids: ["playable"] }, async ({ call, req, res }) => {
      const body = req.body === undefined ? {} : record(req.body);
      const sample = text(body, "text", 300);
      const id = req.params.id as string;
      if (!VOICE_ID.test(id)) {
        const input = sample ?? (id.startsWith("z") ? "你好，这是我的声音。" : "Hello, this is my voice.");
        await sendAudio(
          res,
          await call("/v1/audio/speech", {
            method: "POST",
            json: { model: "kokoro", voice: id, input, response_format: "wav" },
            timeoutMs: SLOW_TIMEOUT_MS
          })
        );
        return;
      }
      const upstream = await call(`/v1/voices/${id}/preview`, {
        method: "POST",
        json: sample ? { text: sample } : {},
        timeoutMs: SLOW_TIMEOUT_MS
      });
      await sendAudio(res, upstream);
    })
  );

  router.post(
    "/voices/design",
    ...route({ limit: SMALL_LIMIT }, async ({ call, req, res }) => {
      const body = record(req.body);
      const payload: Record<string, unknown> = { description: text(body, "description", 300, true) };
      const sample = text(body, "text", 300);
      if (sample) payload.text = sample;
      const language = text(body, "language", 12);
      if (language) {
        if (!LANGUAGE.test(language)) throw bad("language must be a short code such as en.");
        payload.language = language;
      }
      if (body.count !== undefined) {
        if (!Number.isInteger(body.count) || (body.count as number) < 1 || (body.count as number) > 3) {
          throw bad("count must be 1 to 3.");
        }
        payload.count = body.count;
      }
      const made = record(
        await json(await call("/v1/voices/design", { method: "POST", json: payload, timeoutMs: SLOW_TIMEOUT_MS }))
      );
      const candidates = Array.isArray(made.candidates) ? made.candidates : [];
      res.json({
        ok: true,
        candidates: candidates.map((candidate: unknown) => {
          const item = record(candidate);
          return { id: item.id, text: item.text, description: item.description };
        })
      });
    })
  );

  router.get(
    "/voices/design/:cid/audio",
    ...route({ ids: ["cid"] }, async ({ call, req, res }) => {
      await sendAudio(res, await call(`/v1/voices/design/${req.params.cid as string}/audio`));
    })
  );

  router.post(
    "/voices/design/:cid/save",
    ...route({ limit: SMALL_LIMIT, ids: ["cid"] }, async ({ call, admin, req, res }) => {
      const body = record(req.body);
      const payload: Record<string, unknown> = {
        name: text(body, "name", 64, true),
        created_by: admin.username
      };
      const voiceGender = gender(body);
      if (voiceGender) payload.gender = voiceGender;
      const voiceLanguages = languages(body);
      if (voiceLanguages) payload.languages = voiceLanguages;
      const saved = record(
        await json(
          await call(`/v1/voices/design/${req.params.cid as string}/save`, {
            method: "POST",
            json: payload,
            timeoutMs: SLOW_TIMEOUT_MS
          })
        )
      );
      log.info("designed voice saved from studio", { by: admin.username, voice: saved.id });
      res.status(201).json(saved);
    })
  );

  router.get(
    "/lexicon",
    ...route({}, async ({ call, res }) => {
      res.json(await json(await call("/v1/lexicon")));
    })
  );

  router.put(
    "/lexicon",
    ...route({ limit: LEXICON_LIMIT }, async ({ call, admin, req, res }) => {
      const entries = record(record(req.body).entries);
      const keys = Object.keys(entries);
      if (keys.length > MAX_LEXICON_ENTRIES) throw bad(`At most ${MAX_LEXICON_ENTRIES} entries are allowed.`);
      for (const key of keys) {
        if (typeof entries[key] !== "string") throw bad("Every entry must be text.");
      }
      const saved = await json(await call("/v1/lexicon", { method: "PUT", json: { entries } }));
      log.info("pronunciation lexicon changed from studio", { by: admin.username, entries: keys.length });
      res.json(saved);
    })
  );

  return router;
}
