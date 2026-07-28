# Vision — Letting Max Describe What the Camera Sees

## Summary

Asked "你能看到什么", Max answers "我没办法直接看到车的情况". That is honest: no
frame has ever reached a model. The camera feeds capture, preview and the ADAS
detector, and nothing else.

This adds one on-request path: the rider asks, one frame goes up, a vision model
describes it, and Max says what it saw.

Second half of the project split in
`docs/superpowers/specs/2026-07-28-speech-on-the-helmet-design.md`. That half
made generated text audible on the helmet; without it a description would have
had nothing to speak it.

Depends on: `docs/superpowers/specs/2026-07-27-rdk-cam1-live-design.md` (a live
camera) and the speech spec above.

## Why a second model at all

The relay talks to Doubao's realtime **speech dialogue** socket
(`openspeech.bytedance.com/api/v3/realtime/dialogue`): voice in, voice out. It
has no image input, and the relay has no other outbound model integration —
every `DOUBAO_*` variable is speech or session config. Seeing therefore means a
separate call to a vision endpoint, and that call is a new integration rather
than a parameter on the existing one.

## Flow

```text
rider asks → detect camera.look → device.command → board
  board: GET /frame/front?w=640 (localhost)  →  device.result ok   (< 1 s)
                                                  ├→ "我看看…" spoken now
                                                  └→ camera.frame {commandId, image}
                                                        → relay → vision model
                                                        → description spoken
```

The slow part happens **after** the device round trip closes. The board answers
in well under a second because `jpeg()` is a buffer read, so the relay's 8 s
`DEVICE_RESULT_TIMEOUT_MS` is never in play — the model is not consulted until
the command has already succeeded.

### The filler costs nothing new

`deviceSuccessSpeech("camera.look")` returns "我看看…" and the existing
reconciliation speaks it, through the path the speech spec just built. Silence
on a helmet reads as "he didn't hear me", and a repeated question would send a
second frame.

The only new speech work is letting the vision path speak the description later,
outside a reconciliation.

`camera.look` joins the `DeviceActionName` union in `server/device-actions.ts`,
gets `{ supported: true }` in the board's `EMBEDDED_CAPABILITIES`, and gets a
denied-case line in `reconcileDeviceResult` so a refusal is spoken rather than
swallowed. Every other client already reports unsupported actions correctly, so
no other platform needs a change for it.

## The frame

A new `GET /frame/front` on `rdk/vision/bench_server.py` returns a single JPEG,
downscaled to **640 px on the longest edge** (~40 KB). The width is an optional
`?w=` parameter defaulting to 640, so the size can be changed at the bench
without a redeploy; the board always requests the default. The board fetches it
over localhost and never puts image bytes on the control socket — the rule that
server exists to honour.

640 px is enough for a model to describe a scene and cheap to upload from a
board that usually lives on a phone tether. It will not resolve distant signs or
small text; that is an accepted limit, not an oversight.

### Board → relay

A new client→server event, `camera.frame`, carrying the JPEG base64-encoded and
correlated by `commandId`. Base64 costs ~33% (a 40 KB frame becomes ~55 KB on the
wire), which buys explicit correlation and schema validation.

Sending raw bytes on the uplink was rejected: that path currently treats every
binary frame as PCM mic audio, and disambiguating it means new framing on the
one path that must never break.

This means regenerating `protocol/agent-events.schema.json` into TypeScript,
Kotlin and Swift via `scripts/generate-agent-protocol.ts`. Mechanical, but it
touches all three clients and is the largest single piece of this work.

## Consent and capability are different things

`MAX_VISION_SHARE=0` by default, **on the board**. With it off the sidecar
refuses to return a frame, so an image cannot leave the device at all regardless
of how the relay is configured.

Credentials on the relay control **capability**. This flag controls **consent**.
Keeping them apart means turning the feature on for development never silently
starts uploading a rider's surroundings.

A refusal returns a device failure, so Max says he cannot look. Going quiet would
be indistinguishable from not having heard.

## Error handling

Every failure ends with Max saying something true.

| Failure                                           | Behaviour                                            |
| ------------------------------------------------- | ---------------------------------------------------- |
| `MAX_VISION_SHARE` off                            | Device denied; "我现在不能看"                        |
| No camera open                                    | Existing capture-failed line                         |
| Vision call fails, rejects, or exceeds its budget | "我看不清"                                           |
| Relay lacks TTS credentials                       | Description reaches transcript and HUD, is not heard |
| Relay lacks vision credentials                    | Same as a failed call; logged distinctly             |

**Never a guessed description.** On a motorcycle, an invented answer about what
is ahead is the one output worse than silence. If the model did not answer, Max
says he could not see — he does not fill the gap.

The description path inherits the speech spec's rule that synthesis failures
degrade to transcript-only, so a vision answer can be read at the bench even
when the helmet stays silent.

## Two unknowns, settled before anything depends on them

Neither the vision model id, its endpoint, nor its response shape exists in this
repo. **Task one probes them against the real API with a real frame** and records
what works, exactly as the `nv12` question was settled before the camera work
built on it.

It also answers whether the existing `DOUBAO_API_KEY` authenticates against the
vision endpoint or a separate credential is required. If a new credential is
needed, that is a stop-and-ask, not a guess — the same shape as the TTS
credentials that currently leave the speech feature inert.

## Testing

**Unit, no network:**

- the `camera.look` regex matches the intended phrasings and does not steal
  `拍照` or `录像`
- `/frame/front` downscales to 640 px on the longest edge and preserves aspect
- the share gate refuses when off, and the refusal reaches the rider as speech
- the vision client's failure paths — rejected, malformed, timeout — each yield
  the "could not see" line and never a fabricated description
- the description is spoken on embedded clients and reaches the transcript on all

**On the board:**

- ask, hear "我看看…" immediately
- get a description that actually matches what the camera is pointed at — checked
  against the frame itself, not just "a plausible sentence arrived"
- confirm with `MAX_VISION_SHARE=0` that no frame leaves and Max says so

## Out of scope

- Continuous or unprompted narration.
- Describing ADAS hazards. That path is deliberately silent in shadow mode.
- Storing or logging the frames that are sent.
- An on-board vision model. The BPU runs a yolov5s detector — boxes, not
  descriptions — and replacing it is a far larger project.
