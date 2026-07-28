# Speech on the Helmet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the relay's deterministic device confirmations audible on the helmet, so the rider hears "拍好了" instead of the model's invented chatter.

**Architecture:** A new `server/speech.ts` synthesises text to 24 kHz mono PCM16 through Doubao's HTTP TTS and hands it to a small speaker object; the Doubao provider calls it from `applyDeviceReconciliation` for embedded clients only, writing the bytes with the same `client.send(chunk, { binary: true })` it already uses for Doubao's voice. The board changes not at all.

**Tech Stack:** TypeScript, Node's global `fetch`, vitest.

**Spec:** `docs/superpowers/specs/2026-07-28-speech-on-the-helmet-design.md`

## Global Constraints

- **These tests run locally**, not on the board: `npm test` (vitest). The board is only needed for the final live check.
- **No new dependencies.** Node's global `fetch` and `Buffer` are enough.
- **The board must not be touched.** If a task starts editing anything under `rdk/`, the approach has gone wrong — the whole point is that the downlink already works.
- **Embedded clients only.** Web and mobile speak the transcript themselves via `useBrowserSpeech`; sending them audio too would say every confirmation twice. The gate is `platform?.() === "embedded"`, matching `server/hazard-injector.ts:80`.
- **The transcript event is still emitted in every case.** This change adds audio and removes nothing — the HUD, QA transcript and user memory must see exactly what they see today.
- **Synthesis must never block or throw into the reconciliation path.** Every failure degrades to today's behaviour: transcript only, silence on the helmet.
- **Credentials are the switch.** `DOUBAO_TTS_APPID` / `DOUBAO_TTS_TOKEN`, the same pair `rdk/vision/tools/render_alerts.py` uses. Absent → no synthesis, no error, no behaviour change.
- Work on branch `feat/speech-on-the-helmet` (already created; the spec is committed there).

---

### Task 1: `synthesize` — text to PCM, cached

**Files:**
- Create: `server/speech.ts`
- Test: `tests/speech.test.ts`

**Interfaces:**
- Produces: `createSynthesizer(options): (text: string) => Promise<Buffer | null>`, where `options` is `{ appid?: string; token?: string; voice?: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxEntries?: number }`. Returns `null` for any failure or missing credentials — never throws.
- `TTS_ENDPOINT = "https://openspeech.bytedance.com/api/v1/tts"`, `TTS_RATE = 24_000`.

The request shape is copied from `rdk/vision/tools/render_alerts.py:doubao_synth`, which is proven against the real service.

- [ ] **Step 1: Write the failing tests**

Create `tests/speech.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createSynthesizer } from "../server/speech";

function okResponse(pcm: string) {
  return {
    ok: true,
    json: async () => ({ data: Buffer.from(pcm, "utf8").toString("base64") })
  } as unknown as Response;
}

function synth(overrides: Partial<Parameters<typeof createSynthesizer>[0]> = {}) {
  const fetchImpl = vi.fn(async () => okResponse("audio-bytes"));
  const synthesize = createSynthesizer({
    appid: "app",
    token: "tok",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides
  });
  return { synthesize, fetchImpl };
}

describe("createSynthesizer", () => {
  it("returns the decoded pcm", async () => {
    const { synthesize } = synth();
    expect((await synthesize("拍好了。"))?.toString("utf8")).toBe("audio-bytes");
  });

  it("posts the text and the proven request shape", async () => {
    const { synthesize, fetchImpl } = synth();
    await synthesize("拍好了。");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openspeech.bytedance.com/api/v1/tts");
    const body = JSON.parse(String(init.body));
    expect(body.request.text).toBe("拍好了。");
    expect(body.audio).toMatchObject({ encoding: "pcm", rate: 24_000 });
    expect(body.app).toMatchObject({ appid: "app", token: "tok", cluster: "volcano_tts" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer;tok");
  });

  it("synthesises a repeated phrase only once", async () => {
    // The confirmation vocabulary is tiny and fixed, so after first use this
    // takes the network off the common path entirely.
    const { synthesize, fetchImpl } = synth();
    await synthesize("拍好了。");
    await synthesize("拍好了。");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats different text as a different entry", async () => {
    const { synthesize, fetchImpl } = synth();
    await synthesize("拍好了。");
    await synthesize("开始录像。");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry past its bound", async () => {
    const { synthesize, fetchImpl } = synth({ maxEntries: 2 });
    await synthesize("one");
    await synthesize("two");
    await synthesize("three");
    await synthesize("one");
    // "one" was evicted, so it costs a second call — the cache cannot grow
    // without limit if a future caller passes dynamic text.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("returns null without credentials and never calls out", async () => {
    const fetchImpl = vi.fn();
    const synthesize = createSynthesizer({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await synthesize("拍好了。")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when the service rejects", async () => {
    const { synthesize } = synth({
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    });
    expect(await synthesize("拍好了。")).toBeNull();
  });

  it("returns null when the payload has no data field", async () => {
    const { synthesize } = synth({
      fetchImpl: (async () => ({ ok: true, json: async () => ({ code: 3000 }) })) as unknown as typeof fetch
    });
    expect(await synthesize("拍好了。")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const { synthesize } = synth({
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch
    });
    expect(await synthesize("拍好了。")).toBeNull();
  });

  it("does not cache a failure", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return okResponse("audio-bytes");
    });
    const synthesize = createSynthesizer({
      appid: "app",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(await synthesize("拍好了。")).toBeNull();
    expect((await synthesize("拍好了。"))?.toString("utf8")).toBe("audio-bytes");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/speech.test.ts`
Expected: FAIL — cannot resolve `../server/speech`.

- [ ] **Step 3: Implement it**

Create `server/speech.ts`:

```ts
/**
 * Turning generated text into audio the helmet can play.
 *
 * The relay produces deterministic confirmations ("拍好了。") and sends them as
 * transcript events marked `useBrowserSpeech`. Web and mobile speak those
 * themselves; the board has no transcript case and drops them, so the one
 * client with no screen never hears the line whose whole purpose is that the
 * rider hears the truth rather than the model's chatter.
 *
 * The request shape is copied from rdk/vision/tools/render_alerts.py, which is
 * proven against the real service. 24 kHz mono PCM16 is not a preference: it is
 * what the board's downlink plays.
 */

export const TTS_ENDPOINT = "https://openspeech.bytedance.com/api/v1/tts";
export const TTS_RATE = 24_000;

const DEFAULT_VOICE = "zh_female_qingxin";
const DEFAULT_TIMEOUT_MS = 2_000;
/** The confirmation vocabulary is a handful of phrases; this is headroom, and a
 *  bound so a future caller passing dynamic text cannot grow the map forever. */
const DEFAULT_MAX_ENTRIES = 64;

export type SynthesizerOptions = {
  appid?: string;
  token?: string;
  voice?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxEntries?: number;
};

/**
 * Text to raw PCM16 at TTS_RATE, or null.
 *
 * Null rather than throwing, always: this sits on the device-confirmation path,
 * and a confirmation that fails to synthesise must degrade to the silence we
 * have today, never to an exception in the reconciliation.
 */
export function createSynthesizer(options: SynthesizerOptions): (text: string) => Promise<Buffer | null> {
  const {
    appid,
    token,
    voice = DEFAULT_VOICE,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxEntries = DEFAULT_MAX_ENTRIES
  } = options;

  const cache = new Map<string, Buffer>();

  return async function synthesize(text: string): Promise<Buffer | null> {
    if (!appid || !token) return null;

    const hit = cache.get(text);
    if (hit) return hit;

    const payload = {
      app: { appid, token, cluster: "volcano_tts" },
      user: { uid: "max-relay" },
      audio: { voice_type: voice, encoding: "pcm", rate: TTS_RATE },
      request: { reqid: text.slice(0, 16) || "speech", text, operation: "query" }
    };

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetchImpl(TTS_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer;${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: abort.signal
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { data?: string };
      if (!body.data) return null;

      const pcm = Buffer.from(body.data, "base64");
      // Only successes are cached. A transient failure must not poison the
      // phrase for the life of the process.
      if (cache.size >= maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(text, pcm);
      return pcm;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/speech.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add server/speech.ts tests/speech.test.ts
git commit -m "feat(speech): synthesise text to 24 kHz pcm, cached"
```

---

### Task 2: `createSpeaker` — the embedded gate

Kept apart from the provider so it tests without a WebSocket, matching how `reconcileDeviceResult` and `createHazardInjector` are already structured.

**Files:**
- Modify: `server/speech.ts`
- Test: `tests/speech.test.ts`

**Interfaces:**
- Produces: `createSpeaker(options): { speak(text: string): Promise<void> }`, where `options` is `{ synthesize: (text: string) => Promise<Buffer | null>; sendAudio: (pcm: Buffer) => void; platform: () => string | undefined; onError?: (error: unknown) => void }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/speech.test.ts`, and add `createSpeaker` to the **existing**
import at the top of the file rather than writing a second import from the same
module — `import { createSpeaker, createSynthesizer } from "../server/speech";` —
so lint does not flag a duplicate import:

```ts
function speaker(overrides: Partial<Parameters<typeof createSpeaker>[0]> = {}) {
  const sent: Buffer[] = [];
  const made = createSpeaker({
    synthesize: async () => Buffer.from("pcm"),
    sendAudio: (pcm) => sent.push(pcm),
    platform: () => "embedded",
    ...overrides
  });
  return { speak: made.speak, sent };
}

describe("createSpeaker", () => {
  it("sends audio to an embedded client", async () => {
    const { speak, sent } = speaker();
    await speak("拍好了。");
    expect(sent.map((b) => b.toString("utf8"))).toEqual(["pcm"]);
  });

  it("sends nothing to a web client", async () => {
    // Web and mobile speak the transcript themselves via useBrowserSpeech.
    // Sending audio too would say every confirmation twice.
    const { speak, sent } = speaker({ platform: () => "web" });
    await speak("拍好了。");
    expect(sent).toEqual([]);
  });

  it("sends nothing when the platform is not yet known", async () => {
    const { speak, sent } = speaker({ platform: () => undefined });
    await speak("拍好了。");
    expect(sent).toEqual([]);
  });

  it("does not synthesise at all for a web client", async () => {
    // No point paying for audio nobody will play.
    const synthesize = vi.fn(async () => Buffer.from("pcm"));
    const { speak } = speaker({ platform: () => "web", synthesize });
    await speak("拍好了。");
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("stays silent when synthesis fails", async () => {
    const { speak, sent } = speaker({ synthesize: async () => null });
    await speak("拍好了。");
    expect(sent).toEqual([]);
  });

  it("never throws when synthesis rejects", async () => {
    // This sits on the device-confirmation path. An exception here would take
    // out the reconciliation that tells the rider the truth.
    const errors: unknown[] = [];
    const { speak, sent } = speaker({
      synthesize: async () => {
        throw new Error("boom");
      },
      onError: (error) => errors.push(error)
    });
    await expect(speak("拍好了。")).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("never throws when the send fails", async () => {
    const { speak } = speaker({
      sendAudio: () => {
        throw new Error("socket closed");
      }
    });
    await expect(speak("拍好了。")).resolves.toBeUndefined();
  });

  it("ignores empty text", async () => {
    const synthesize = vi.fn(async () => Buffer.from("pcm"));
    const { speak, sent } = speaker({ synthesize });
    await speak("   ");
    expect(synthesize).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/speech.test.ts`
Expected: FAIL — `createSpeaker` is not exported.

- [ ] **Step 3: Implement it**

Append to `server/speech.ts`:

```ts
export type SpeakerOptions = {
  synthesize: (text: string) => Promise<Buffer | null>;
  sendAudio: (pcm: Buffer) => void;
  /** The session's client platform. See server/hazard-injector.ts for the same gate. */
  platform: () => string | undefined;
  onError?: (error: unknown) => void;
};

/**
 * Speaks generated text on clients that cannot speak it themselves.
 *
 * Only "embedded": web and mobile already say `useBrowserSpeech` transcripts
 * with their own TTS, so audio as well would double every confirmation.
 *
 * No pacing here. The board's playback caps how far ahead of the DAC audio may
 * sit (MAX_QUEUE_MS = 80, topped up by a 10 ms pump) — the fix that took the
 * reference-to-mic lag from 953 ms to 81 ms. Whatever we hand over is metered
 * by the same mechanism that meters Doubao's own voice.
 */
export function createSpeaker(options: SpeakerOptions): { speak(text: string): Promise<void> } {
  const { synthesize, sendAudio, platform, onError } = options;

  return {
    async speak(text: string): Promise<void> {
      if (!text.trim()) return;
      if (platform() !== "embedded") return;

      try {
        const pcm = await synthesize(text);
        if (!pcm) return;
        sendAudio(pcm);
      } catch (error) {
        // Silence is the documented degradation. Throwing here would take out
        // the reconciliation that tells the rider the truth.
        onError?.(error);
      }
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/speech.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add server/speech.ts tests/speech.test.ts
git commit -m "feat(speech): speak generated text on embedded clients only"
```

---

### Task 3: Wire it into the reconciliation

**Files:**
- Modify: `server/providers/doubao.ts`

**Interfaces:**
- Consumes: `createSynthesizer`, `createSpeaker` (Tasks 1–2), the existing `sessionPlatform` and `client`.

- [ ] **Step 1: Construct the speaker next to the hazard injector**

In `server/providers/doubao.ts`, add the import beside the other server imports:

```ts
import { createSpeaker, createSynthesizer } from "../speech";
```

Then, immediately after the `const hazardInjector = createHazardInjector({...})` block — it already has `sessionPlatform` in scope:

```ts
  // The helmet has no way to speak generated text: it drops `useBrowserSpeech`
  // transcripts, and pre-rendered alert WAVs cannot cover arbitrary wording. So
  // the relay synthesises and sends the bytes down the same binary channel
  // Doubao's own voice uses.
  const speaker = createSpeaker({
    synthesize: createSynthesizer({
      appid: process.env.DOUBAO_TTS_APPID,
      token: process.env.DOUBAO_TTS_TOKEN,
      voice: process.env.DOUBAO_TTS_VOICE
    }),
    sendAudio: (pcm) => client.send(pcm, { binary: true }),
    platform: () => sessionPlatform,
    onError: (error) => log.warn("confirmation speech failed", { error: String(error) })
  });
```

If `log.warn` does not accept a second argument in this codebase, use
`log.warn(\`confirmation speech failed: ${String(error)}\`)` — check the
neighbouring `log.` calls and match them.

- [ ] **Step 2: Speak from the reconciliation**

In `applyDeviceReconciliation`, after the transcript is sent:

```ts
  function applyDeviceReconciliation(
    action: DeviceActionName,
    result: { status: DeviceActionStatus; reason?: string; detail?: string },
    okSpeech?: string
  ): void {
    const decision = reconcileDeviceResult(action, result, okSpeech);
    if (!decision.truncate) return;
    truncateInterruptedReply();
    if (decision.speech) {
      sendClient(transcriptEvent(agentDelivery, "agent", decision.speech, { final: true, useBrowserSpeech: true }));
      // Deliberately not awaited: the reconciliation is synchronous and must
      // stay that way. truncateInterruptedReply() has already cut the model's
      // audio, so the line does not land on top of it.
      void speaker.speak(decision.speech);
    }
  }
```

The transcript event is unchanged — the HUD, QA transcript and user memory see exactly what they saw before.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions. The relay's existing tests must be untouched by this change; if one fails, the wiring altered behaviour beyond adding audio.

- [ ] **Step 4: Check types and lint**

Run: `npm run check`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add server/providers/doubao.ts
git commit -m "feat(speech): speak device confirmations to the helmet"
```

---

### Task 4: Hear it on the board

**Files:**
- Modify: `rdk/README.md`

- [ ] **Step 1: Confirm the relay has TTS credentials**

The relay runs on the Lightsail test box, not the board:
`ubuntu@3.35.135.136`, app at `/home/ubuntu/app`, key at
`~/Desktop/LightsailDefaultKey-ap-northeast-2.pem`. The server `.env` is
protected and never overwritten by a deploy, so the variables must already be
there or be added by hand:

```bash
KEY=~/Desktop/LightsailDefaultKey-ap-northeast-2.pem
ssh -i "$KEY" -o BatchMode=yes ubuntu@3.35.135.136 \
  'grep -cE "^DOUBAO_TTS_(APPID|TOKEN)=." /home/ubuntu/app/.env'
```

Expected: `2`. **If it is not 2, stop and ask** — without both variables this
feature is a deliberate no-op and a live test would prove nothing. They are the
same pair `render_alerts.py` used to render the alert WAVs, so they exist
somewhere; they may simply never have been added to the relay's env.

- [ ] **Step 2: Deploy the relay**

```bash
./deploy-lightsail.command
```

The script refuses a dirty tree and, by default, only deploys `main` when local
HEAD equals `origin/main`. To deploy this branch before merging, use its
supported staging path: `LIGHTSAIL_ALLOW_NON_MAIN=on ./deploy-lightsail.command`.

Then confirm what is actually live:

```bash
curl -ks https://3.35.135.136/health
```

Expected: healthy, `build.gitCommit` matching the commit just deployed, and
`uptimeSec` back down to seconds. `metrics.activeSessions` returns to 1 once the
board reconnects.

- [ ] **Step 3: Ask for a photo and listen**

With the headset on and a live session, say **"Max 帮我拍照"**.

Expected: Max says **"拍好了。"** — and the invented "3、2、1。照片已拍下" countdown
does not play. Watch the HUD transcript at the same time; the agent line should
still appear there exactly as before.

- [ ] **Step 4: Confirm the echo loop has not returned**

This injects audio into the playback path that feeds the AEC reference, so it is
the regression that matters. Hold a normal conversation of several turns with
the headset on, then:

```bash
ssh root@10.42.0.11 'journalctl -u max-agent -n 80 --no-pager | grep -iE "echo|loop|barge" | tail -5'
```

Expected: no echo-loop detection, and no `rider:` turn that is a prefix of Max's
previous reply. **If the loop returns, stop** — that is the failure mode the AEC
work exists to prevent, and it outranks this feature.

- [ ] **Step 5: Confirm a web client did not start double-speaking**

Open the web app, ask for a photo, and confirm the confirmation is spoken
**once**. The relay must not be sending it audio.

- [ ] **Step 6: Document it**

In `rdk/README.md`, under the bench-findings table:

```markdown
| Helmet speaks confirmations | **works** — "拍好了" heard on the board, no echo-loop return | 2026-07-28 |
```

And add a short section near the AEC notes:

```markdown
### Why the helmet can speak generated text

`deviceSuccessSpeech` sends its line as a transcript marked `useBrowserSpeech`.
Web and mobile speak that themselves; the board has no transcript case and drops
it, so until 2026-07-28 the one client with no screen never heard "拍好了" and
the rider got the model's invented wording instead.

The relay now synthesises those lines through Doubao's HTTP TTS
(`DOUBAO_TTS_APPID` / `DOUBAO_TTS_TOKEN`, the same pair `render_alerts.py` uses)
and sends 24 kHz mono PCM16 down the binary channel the board already plays.
**The board was not changed.** Without the credentials the relay behaves exactly
as before.

Pacing stays on the board: `playback.ts` caps the queue at 80 ms, which is the
fix that took the reference-to-mic lag from 953 ms to 81 ms. The relay sends the
buffer and that cap meters it, exactly as it meters Doubao's own voice.
```

- [ ] **Step 7: Commit**

```bash
git add rdk/README.md
git commit -m "docs(speech): record confirmations audible on the helmet"
```

---

## Notes for the implementer

- **Do not touch anything under `rdk/`** except the README. The board's downlink already plays any binary frame as 24 kHz PCM16; if you find yourself editing the agent, the approach has gone wrong.
- **`speak` is fire-and-forget on purpose.** `applyDeviceReconciliation` is synchronous and called from a socket handler. Awaiting synthesis there would stall the reconciliation behind a network call.
- **Failures are silent by design.** Every path returns `null` or swallows into `onError`. The worst outcome must be today's behaviour, never a broken confirmation.
- **The echo loop is the regression to fear**, not a wrong word. Task 4 Step 4 is the one that must not be skipped.
