# RDK gallery: viewing, playback, and delete

2026-07-30. Extends the capture gallery from
`2026-07-25-rdk-x5-embedded-client-design.md` and the recovery work recorded in
`rdk/README.md` ("Seeing captures").

## Problem

Captures land in `/var/lib/max/gallery` and the bench HUD lists them, but the
gallery is a listing, not a tool:

- A recording is a `.mjpeg` (concatenated JPEG). No browser plays that inline,
  so the HUD offers it only as a download — the one client attached to the
  board that made the clip cannot play it.
- Nothing deletes a capture. The page was deliberately read-only, so clearing
  space means `rm` over SSH — at ~1.7 GB per ten-minute clip on a board with a
  1 GB free-space floor, deletion is routine, not exceptional.
- A tile shows one side, no capture time, no duration, and nothing says how
  close the disk is to the floor that refuses the next capture.

## Decisions

**The viewer is the bench HUD.** The gallery lives on the RDK; the HUD at
`MAX_HUD_PORT` is the RDK's own screen-facing surface and already renders the
grid. Image bytes stay on the sidecar's port — the agent process never touches
them, same as preview.

**Playback re-streams the file as `multipart/x-mixed-replace`.** The HUD
already renders that for live preview in a plain `<img>`; replaying a segment
through the same mechanism needs no transcoding (the board plateaus near 90 °C
with a ride running — an ffmpeg pass per view is heat and RAM it does not
have), no new client machinery, and streams chunk-at-a-time so an 835 MB clip
never costs more than one frame of RAM. `?fps=` (clamped 1–30, default the
recorded 10) gives the viewer a speed control for free. The stream ends when
the file does; a clip still being written plays what is on disk and stops.

**Delete removes a whole pair, over POST, with no auth token.**

- The unit is the pair directory — a capture event — matching what the grid
  shows and what the iOS gallery deletes. Per-side delete would leave manifests
  claiming files that are gone, the exact broken-tile state `reconcile()` exists
  to repair.
- `POST /gallery/<pair>/delete` rather than HTTP DELETE: the page is served
  from the agent's port, so a DELETE would be a cross-origin request needing a
  preflight OPTIONS handler; a POST with no custom headers is a simple request
  and needs only the `Access-Control-Allow-Origin` header the listing already
  sends.
- A pair whose manifest says `recording: true` is refused with 409 — the writer
  is appending to it (reconcile at service start means a live flag can only be
  the live recording). Stop the recording first, then delete.
- Refused/unknown paths stay 404 via `safe_path`, and the target must be a
  directory directly under the gallery root holding a `manifest.json` — the
  route can delete a capture, and nothing else, whoever calls it.
- No token: the HUD page itself is served unauthenticated on the same LAN, so
  a token embedded in it would be theater, not auth. The honest trust model is
  that the bench surface trusts the LAN (preview already streams frames to
  anyone who asks); delete widens what that trust covers from reading captures
  to removing them, and the README says so in place of the old "read-only"
  paragraph.

**The listing carries what a viewer needs.** Each pair gains `created` (ISO
timestamp parsed from the pair id, falling back to the directory mtime for ids
that do not parse) and `duration_s` when the manifest has it; the response
gains `disk: {free_mb, min_free_mb}` so the page can show how far the disk is
from the floor. `duration_s` is stamped by `stop_recording` from the wall
clock (`recording_started_at`), not frames ÷ fps — the writer measurably falls
behind nominal fps, and the wall clock is the truth about how long the rider
recorded. Reconciled clips have no trustworthy clock and carry no duration.

## Components

- `gallery.py` — `delete_pair(pair_id)`: validates the id resolves to a pair
  directory under the root, reads the manifest, refuses `recording: true`,
  removes the directory. `write_manifest` gains optional `duration_s`.
- `camera.py` — `stop_recording` stamps `duration_s` into the final manifest.
- `bench_server.py` — `do_POST` for delete; `/play` handler that walks a
  segment chunk-at-a-time emitting one JPEG per multipart part, paced by
  `?fps=`; `listing()` gains `created`, `duration_s` passthrough, and `disk`.
- `hud/index.html` — tiles show capture time and duration and open a viewer
  overlay: front and rear panels (photo full-size, video via `/play` with a
  1×/2×/4× speed control), download links, delete with a confirm, prev/next
  and Esc. Captures header shows count and free space against the floor.
  Delete refreshes the listing; the live-recording tile hides the button.

## Error handling

- `/play` of a path that is not an existing `.mjpeg` under the root: 404.
- Bad or out-of-range `?fps=`: 400, matching `/frame`'s width handling.
- Client closing mid-stream (`BrokenPipeError`) returns quietly, as preview
  does.
- Delete of an unknown pair or a traversal spelling: 404. Live recording: 409.
  Success: 200 JSON `{"deleted": "<pair-id>"}` with ACAO so the page can read
  the outcome.
- A delete that fails partway (`shutil.rmtree` on a vanishing file) uses
  `ignore_errors=False`; an OSError surfaces as 500 rather than reporting a
  delete that did not happen.

## Testing

Vision suite (runs on the board, and now also locally — pytest exists on the
dev machine): delete semantics (success, unknown, traversal, live-recording
refusal, non-pair paths), play streaming (frame boundaries, single-frame file,
fps clamp, 404s), listing fields (created, duration, disk), manifest duration
stamping in the camera policy tests. Repo gate `npm run check` covers the
agent side; the HUD page is verified live on the board (task: play a real
clip, delete a scratch capture, watch free space move).
