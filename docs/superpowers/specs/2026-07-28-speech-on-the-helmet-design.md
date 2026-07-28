# Speech on the Helmet — Making Generated Text Audible

## Summary

The relay produces deterministic confirmations — "拍好了。", "开始录像。" — and
sends them as transcript events marked `useBrowserSpeech`. Web and mobile clients
speak them. **The helmet drops them**, because the board agent handles `status`,
`hazard.alert` and `device.command` and has no `transcript` case at all.

So the one device with no screen is the one device that never hears them. The
rider gets whatever the model invented instead, which is precisely what
`deviceSuccessSpeech` exists to prevent:

> *"Deterministic and tied to the real device result, so the rider hears the
> truth ("拍好了", "开始录像") instead of the model's chatter or a mistaken
> safety refusal."*

Observed 2026-07-27: asked for a photo, Max said *"好的，正在准备拍照。请保持设备
稳定，我会在3秒后自动拍摄。3，2，1。照片已拍下…"* — an invented countdown, for a
capture that is a single frame grab. "拍好了" was never spoken.

This makes generated text audible on the helmet. It is also the prerequisite for
letting Max describe what the camera sees, which is the project this was split
out of.

## Why this is small

The board's downlink is already generic. `relay.ts` treats **any** binary frame
as 24 kHz PCM16 and hands it to `playback.write`:

```
socket.on("message", (data, isBinary)) -> onVoice(pcm) -> playback.write(pcm)
```

That path is AEC-aware — `playback.write` feeds the reference sink — so injected
audio cannot reintroduce the echo loop that cost 2026-07-25.

And Doubao's HTTP TTS is already proven in this repo: `tools/render_alerts.py`
calls `https://openspeech.bytedance.com/api/v1/tts` with `DOUBAO_TTS_APPID` and
`DOUBAO_TTS_TOKEN`, and produces mono PCM16 at 24 kHz — the same rate the
downlink expects, chosen for the same reason.

**So the board needs no changes.** The relay synthesises and sends bytes down a
channel that already exists and already works.

## Architecture

```text
server/
  speech.ts          NEW — text -> 24 kHz mono PCM16, cached
  providers/doubao.ts  applyDeviceReconciliation also speaks, for embedded
```

`speech.ts` exposes `synthesize(text: string): Promise<Buffer | null>`, returning
raw PCM16 at 24 kHz, or `null` when synthesis fails or exceeds its budget.

The provider gains a `speak(text)` that, for an **embedded** client, synthesises
and writes the PCM with `client.send(chunk, { binary: true })` — the same call
`forwardTtsAudio` already makes for Doubao's own voice. Everything else is
unchanged.

**Chunked at the existing cadence, not written as one blob.** Playback pacing is
load-bearing here: pacing is what took the reference-to-mic lag from 953 ms to
81 ms, and that lag is what the AEC filter is aligned against. A single large
write would arrive as one burst and there is no reason to find out what that
does to the filter. Match the frame size Doubao's own audio arrives in.

### One hook point

`applyDeviceReconciliation` is the only place deterministic speech is produced,
and it already calls `truncateInterruptedReply()` before emitting — the model's
own audio has been cut by the time the line is spoken, so the two do not overlap.

### Gated on embedded clients

`platform === "embedded"`, following the gate already used for
`createHazardInjector` at both provider call sites, and for the same reason:
web and mobile speak the transcript themselves. If the relay also sent audio they
would say it twice.

The transcript event is still emitted in **both** cases, so the HUD, the QA
transcript and per-user memory see exactly what they see today. This change adds
audio; it removes nothing.

### Caching

The confirmation set is tiny and fixed. An in-memory cache keyed by the exact
text means one synthesis per phrase for the life of the process, which also takes
the network off the common path. A bounded map — 64 entries, oldest evicted — is
more than the vocabulary needs and cannot grow without limit if a future caller
passes dynamic text.

## Configuration

`DOUBAO_TTS_APPID` and `DOUBAO_TTS_TOKEN`, the same pair `render_alerts.py`
already uses. **When either is missing, synthesis is skipped and behaviour is
exactly today's** — a relay without TTS credentials keeps working.

No feature flag. The behaviour is what the code already documents and already
delivers on every other client; a flag would leave a stated guarantee broken by
default. The credentials are the switch.

## Failure behaviour

Every failure degrades to today's behaviour — transcript only, silence on the
helmet.

| Failure | Behaviour |
| ------- | --------- |
| No TTS credentials | Skipped; no synthesis attempted |
| TTS request fails or times out (2 s budget) | Logged once, transcript only |
| Response is not decodable PCM | Treated as failure, transcript only |
| Client is not embedded | Transcript only, as today |

Synthesis never blocks the device result and never throws into the
reconciliation path. A confirmation that arrives late is worse than one that
does not arrive: the rider has moved on.

**Not solved here:** a hazard alert is deliberately unpreemptable while it plays,
and an injected confirmation would mix with it on the shared playback. It is
rare, and choosing a winner belongs with ADAS arming rather than this change.

## Testing

**Unit (vitest), no network:**

- the cache synthesises once for a repeated phrase and evicts past its bound
- an embedded client gets audio **and** a transcript
- a web client gets a transcript and **no** audio — the double-speak guard
- TTS failure yields a transcript and no throw
- missing credentials skip synthesis entirely
- the reconciliation path passes the deterministic text, not the model's text

**On the board:**

- ask Max for a photo and **hear "拍好了"**
- confirm the invented countdown no longer plays over it
- confirm a live conversation still works afterwards — the echo loop is the
  regression that matters, since this injects audio into the playback path that
  feeds the AEC reference

## Out of scope

- Vision. That is the next spec, and it depends on this one.
- Speaking anything other than device confirmations. The hook is one function;
  new callers are new decisions.
- Board-side synthesis. Considered: it survives a degraded relay link, but costs
  real board changes and puts TTS credentials on the device. The relay already
  holds them.
- Alert-versus-confirmation contention on the shared playback.
