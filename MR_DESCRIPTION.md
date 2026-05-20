# Merge request: Enhance audio pipeline, reliability, and project tooling

> Paste the section below into the description field of the merge request.
> MR: https://gitlab-ce.orb.local/hct/doubao/-/merge_requests/1

---

## Summary

Enhances the helmet voice agent prototype across four areas: audio pipeline, rider controls, runtime reliability, and project tooling. No behavioral changes to the Ark or Doubao protocols.

## Changes

### 🎧 Modernized audio

- Mic capture moved from the deprecated main-thread `ScriptProcessorNode` to a new off-thread `AudioWorklet` (`public/pcm-worklet.js`). Downsampling to 16 kHz and PCM16 framing now run on the audio thread, so a busy main thread no longer glitches capture.
- Removed the manual sample queue and `setInterval` send loop — the worklet emits 320-sample (20 ms) frames directly.

### 🏍️ Rider features

- Added a `按住说话` push-to-talk (hold-to-talk) button alongside the latched mic toggle, sharing one reused audio graph (mic track is `enabled`-gated, no `getUserMedia` re-acquire on each press).
- Added barge-in: agent speech (browser TTS + queued Doubao audio) stops as soon as the rider talks or sends a new command.

### 🛡️ Reliability

- `/agent` WebSocket auto-reconnects with exponential backoff (1→8 s, 6 attempts); intentional disconnects are not retried.
- Added `ErrorBoundary` for a recoverable screen on render-time crashes.
- Added `server/config.ts` — startup env validation that warns on missing `ARK_API_KEY` or `VOICE_PROVIDER=doubao` with no credentials, instead of failing cryptically at request time.

### 🧹 Code quality

- Extracted language gating into `shared/language.ts`, removing client/server duplication.
- Added ESLint (flat config), Prettier, and Vitest with **19 unit tests** (language gating, Ark local fallbacks, Doubao binary frame parser).
- New scripts: `lint`, `format`, `format:check`, `test`, `test:watch`.
- Updated `README.md` and added `CLAUDE.md`.

## Testing

- ✅ `npm run build` — type-check + bundle (worklet ships to `dist/`)
- ✅ `npm run lint` — clean
- ✅ `npm test` — 19/19 passing
- ✅ `npm run format:check` — clean
- ⚠️ Not runtime-tested in a browser — AudioWorklet, push-to-talk, reconnect, and barge-in are verified by type-checking and review only. Recommend a manual `npm run dev` pass before merge.
