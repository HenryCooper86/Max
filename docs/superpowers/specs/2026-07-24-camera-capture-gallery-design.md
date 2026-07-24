# Camera Capture & Max Gallery Design

## Summary

Give Max a camera. Voice commands capture photos and silent video through the
Spec 1 device-action spine, files land in an in-app **Max gallery** the rider
curates, and any capture can be copied to the system Photos library. Video is
deliberately silent so the voice engine keeps the microphone — the rider stays
in voice control throughout a recording, so "停止录像" always works.

Builds directly on Spec 1 (`docs/superpowers/specs/2026-07-24-voice-device-actions-design.md`):
the `device.command`/`device.result` protocol, `DeviceActionRouter` and its
locked-device gate, the reconciliation-and-truthful-speech path, and the
single relay command grammar are all reused unchanged.

## Scope

### Goals

- Voice-triggered photo capture (`camera.photo`) and silent video capture
  (`camera.record` start/stop), dispatched through the existing spine.
- An in-app Max gallery: newest-first grid, full-screen photo viewer, video
  player, per-item export-to-Photos and delete.
- Keep-until-deleted storage with a low-space guard; nothing auto-deletes.
- Truthful confirmations and spoken failures, exactly as Spec 1 established.
- Full mock-provider support so capture commands demo without Doubao credentials.

### Non-goals

- Audio on video. Video is silent by design; see "Why silent video".
- Front camera. Rear (road-facing) only in v1.
- Live camera preview. A recording indicator only; the rider reviews later.
- Multi-select batch export/delete. Per-item only in v1.
- Turn-by-turn navigation (Spec 3).
- Android and web capture. Both gain the generated event names; neither gains an
  implementation. Android must ignore the new commands without erroring.

## Why silent video

The voice agent owns the microphone through a shared `AVAudioEngine` with the
voice-processing I/O unit (that is what performs echo cancellation and lets Max
hear the wake word). iOS does not cleanly share the microphone between an
`AVCaptureSession` audio input and that engine. Recording video _with_ sound
would seize the mic, cutting Max's ears mid-recording — the rider could not then
say "停止录像". A video-only capture session
(`automaticallyConfiguresApplicationAudioSession = false`, no audio input) never
touches the mic, so the voice session and hands-free stop both survive. The cost
— clips have no audio track — is accepted.

## Architecture

```text
"Max，拍照" / "开始录像"
  └─ relay grammar (extend extractDeviceCommand) ─► device.command
                                                      { camera.photo | camera.record }
                                                        │
                                    DeviceActionRouter ─► CameraController (DeviceActionHandler)
                                                        │        │ AVCaptureSession, video-only, rear
                                                        │        ▼
                                                        │     CaptureStore ── files + captures.json + thumbnails
                                    device.result ◄─────┘        │
                                                                 ▼
                                              Max Gallery (SwiftUI) ── grid · viewer/player · export · delete
```

### Units

- **`CameraController`** (`DeviceActionHandler`) — configures and runs a
  rear-camera, video-only `AVCaptureSession`; takes photos, starts/stops silent
  video, owns recording state and the state guards. Talks to `CaptureStore` to
  persist. Talks to the capture _session_ behind a `CaptureSessioning` protocol
  so the state machine is testable without a real camera.
- **`CaptureStore`** — writes captures to a dedicated sandbox folder, maintains
  the JSON metadata index, generates thumbnails, and enforces the low-space
  guard. The single owner of everything on disk.
- **`Capture` model** — one metadata record (see "Storage").
- **`GalleryModel`** — observable bridge from `CaptureStore` to the SwiftUI
  views: the capture list, export/delete intents, and export-in-progress/error
  state. Keeps the views thin and the store testable.
- **Gallery views** — grid, full-screen viewer, video player, export/delete
  controls. Touch-driven; used when the rider is stopped.
- **Server: grammar, grounding prompt, failure speech** — camera commands stay
  in the one relay grammar, consistent with Spec 1.

### Reused from Spec 1, unchanged

The `device.command`/`device.result` events, `DeviceActionRouter` (including the
`isDeviceUnlocked` gate), the relay's reconciliation + `ConversationTruncate` +
corrective-speech path, the `DEVICE_ACTION_TIERS` map, and QA transcript
handling. Camera adds cases; it changes none of that machinery.

## Capture behavior

- **Photo** (`camera.photo`) — spin up the session, capture one HEIC frame via
  `AVCapturePhotoOutput`, hand the file to `CaptureStore`, tear the session
  down. HUD shows a brief flash/confirmation; Max says "拍好了".
- **Video** (`camera.record` with `start`) — `start: true` begins a silent
  `.mov` via `AVCaptureMovieFileOutput`; the HUD shows a red dot and an elapsed
  timer. `start: false` ends it and stores the file. Max: "开始录像了" /
  "录像已保存".
- **Safety cap** — recording auto-stops at **10 minutes** so a forgotten
  "开始录像" cannot quietly fill the disk; Max announces the auto-stop.
  `AVCaptureMovieFileOutput.minFreeDiskSpaceLimit` is also set so a recording
  stops before the volume is critically full.
- **State guards** — `start` while already recording, or `stop` with nothing
  recording, speaks a friendly line ("已经在录了" / "现在没有在录像") and creates
  or loses nothing. Mechanically these ride the corrective-speech path; see
  "Error and edge handling".
- **Foreground/unlocked** — capture needs the app foregrounded and unlocked,
  the same iOS constraint as Spec 1, already enforced by the router's
  locked-device gate. During a mounted voice session the app is foregrounded, so
  this is the normal path.

### Session lifecycle

The `AVCaptureSession` is created on demand for the first camera command and
torn down when idle (after a photo, or after a recording stops) to spare
battery. A photo pays a short spin-up latency; that is acceptable for a
deliberate capture.

## Storage

`CaptureStore` owns all persistence.

- **Files** live in `Application Support/Captures/`, with
  `isExcludedFromBackup` set (video would bloat iCloud backups).
- **Index** — `captures.json`, an array of records loaded at launch and written
  atomically on every change. Each record:

  | Field           | Type                 | Notes                           |
  | --------------- | -------------------- | ------------------------------- |
  | `id`            | string (UUID)        |                                 |
  | `type`          | `"photo" \| "video"` |                                 |
  | `filename`      | string               | Relative to the Captures folder |
  | `createdAt`     | epoch seconds        |                                 |
  | `durationSec`   | number, optional     | Video only                      |
  | `exported`      | bool                 | True once copied to Photos      |
  | `thumbnailName` | string               | Relative to the Captures folder |

- **Thumbnails** — one small JPEG per capture for the grid: a downscaled image
  for photos, the first frame via `AVAssetImageGenerator` for video.
- **Low-space guard** — before any capture, check
  `volumeAvailableCapacityForImportantUsage`; below ~**500 MB**, refuse with
  `storage.full`. This is the enforcement behind keep-until-deleted retention:
  the gallery never auto-prunes, so a full disk must block new captures rather
  than silently drop old ones.

## Gallery & export

- **Reaching it** — a gallery button beside the existing HUD controls, plus a
  voice command `打开相册` that presents the gallery. Browsing itself is touch.
- **Grid** — newest-first thumbnails, each badged with type, video duration, and
  `已导出` once exported. Empty state when there is nothing yet.
- **Viewer** — tap a thumbnail for full screen: photos zoomable, videos through
  `AVPlayer`. Per-item actions live here.
- **Export to Photos** — `PHAssetCreationRequest` adds the file using **add-only**
  authorization (`NSPhotoLibraryAddUsageDescription`, the minimal scope — Max
  never reads the rider's existing library). Copy semantics: on success mark
  `exported = true` (the badge); the capture stays in the Max gallery. Denied
  permission surfaces a visible error and leaves the capture unexported.
- **Delete** — removes file, thumbnail, and index record, behind a confirm.
  This is how the rider reclaims space under keep-until-deleted.

## Grammar, permissions & failures

- **Relay grammar** gains two actions (staying in Spec 1's one-grammar model,
  behind the same `IntentExtractor` interface):
  - `拍照 / 拍张照片 / 拍照片 / take a photo / take a picture` → `camera.photo`
  - `开始录像 / 录个视频 / 录像 / 开始录制 / start recording / record video` →
    `camera.record` `{ start: true }`
  - `停止录像 / 结束录像 / 停止录制 / stop recording` → `camera.record`
    `{ start: false }`
- **Tier** — both are **low** (capture calls no one), so they execute
  immediately with a spoken confirmation.
- **Grounding prompt** — add 拍照 and 录像 to Max's declared real capabilities.
- **Failure-speech keys** added to Spec 1's map: `permission.camera`,
  `storage.full`, `camera.recording`, `camera.notRecording`, `capture.failed`.
- **`Info.plist`** (both `Info.plist` and `Info-Debug.plist`):
  `NSCameraUsageDescription`, `NSPhotoLibraryAddUsageDescription`.

## Error and edge handling

- Every command resolves to exactly one `device.result`; silence is a bug.
- Camera permission denied → `denied` / `permission.camera`; Max says which
  permission and that Settings grants it.
- Low space → `denied` / `storage.full`; Max says to export or delete first.
- `start` while recording, or `stop` while idle, is a benign no-op — but it must
  still correct Max, which is mid-sentence saying "开始录像了". Because Spec 1's
  relay stays silent on `ok` (letting Doubao's own confirmation stand) and speaks
  only on a non-`ok` result, these return `failed` with reason `camera.recording`
  / `camera.notRecording`. The wire status is `failed`, but the _spoken_ line is
  benign ("已经在录了" / "现在没有在录像") and no file is created or lost. This
  reuses the reconciliation path exactly rather than adding a new status.
- Capture pipeline failure (session config, write) → `failed` / `capture.failed`.
- Locked/backgrounded device → the router's existing `device.locked` path.
- Export permission denied → visible gallery error; the capture stays unexported
  and in the gallery.
- Unknown/old clients ignore `camera.*` commands without erroring; the relay's
  8 s timeout speaks the failure.

## Verification

### Automated

- **Vitest**: camera-command extraction across Chinese and English, including
  near-miss negatives that must not trigger capture; low-tier assignment; the
  new failure-speech keys; grounding prompt names 拍照/录像.
- **XCTest**, all against fakes (none of the real capture runs in the simulator):
  - `CameraController` against a fake `CaptureSessioning` — photo, start/stop
    record, already-recording and not-recording guards, permission-denied,
    low-space refusal, 10-minute auto-stop.
  - `CaptureStore` — add/list/delete/mark-exported, metadata persistence
    round-trip, low-space guard, thumbnail generation.
  - `GalleryModel` — newest-first ordering, export intent, delete.
  - Export against a fake `PhotoLibraryAdding`.
- Existing repository checks (protocol sync, lint, dead-code, fault matrix,
  build) stay green.

### Manual (physical device)

- Real photo and video capture; the recording indicator and elapsed timer.
- Gallery grid, full-screen viewer, video playback.
- Export to Photos and the `已导出` badge; both permission prompts (camera,
  Photos add).
- Low-space refusal; the 10-minute auto-stop.
- Locked-screen refusal.
- The critical one: **say "停止录像" mid-recording and confirm the mic stayed
  live so Max heard it** — the whole reason for silent video.

## Acceptance criteria

- Photo and video capture by voice on iOS with the app foregrounded, files
  stored in the Max gallery.
- Video is silent and the voice session keeps the microphone throughout, so
  stop-by-voice works mid-recording.
- Max's spoken confirmation matches the real result in every path, including
  every failure above; no capture is claimed without a `status: "ok"` result.
- The gallery shows captures newest-first; per-item export copies to Photos and
  badges it; delete reclaims space.
- Nothing auto-deletes; a full disk blocks new captures with a spoken warning.
- The feature demos end to end on the mock provider with no Doubao credentials.

```

```
