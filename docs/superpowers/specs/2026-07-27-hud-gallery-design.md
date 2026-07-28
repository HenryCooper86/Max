# HUD Gallery — Seeing the Captures

## Summary

Max takes photos correctly and reports them correctly, and there is no way to
look at one. Captures land at `/var/lib/max/gallery/<pair>/front.jpg` on the
board and stay there: `gallery.open` is `supported: false` on the device
(`device.noScreen`), and the dev HUD renders only two preview `<img>` tags. The
question that produced this spec was "where did it go?" — asked by the person
who built it, with the file sitting on disk the whole time.

This adds a **read-only** capture grid to the HUD, served by the vision sidecar.

Depends on: `docs/superpowers/specs/2026-07-27-rdk-cam1-live-design.md`, which
made captures real.

## Where it is served, and why

The sidecar, on the preview port — not the agent.

That is not arbitrary. `camera.py` states the rule: the preview is *"deliberately
served over HTTP rather than the control socket, so image bytes never pass
through the agent."* A gallery is more image bytes. Routing them through the
agent would put megabytes of JPEG through the process that must never be
disturbed, because it owns the voice path.

The sidecar also already has what is needed: `Gallery.list_pairs()` reads the
manifests, and the preview HTTP server exists and — as of today — is threaded.

The agent keeps serving exactly one thing: the page.

## Architecture

`camera.py` has become a camera *and* an HTTP server, and this change would add
three more routes to it. The HTTP surface moves to its own module.

```text
rdk/vision/
  bench_server.py         NEW — the bench-facing HTTP surface: preview + gallery
  camera.py               back to being about cameras; serve_preview moves out
  gallery.py              unchanged; list_pairs() already does the reading
rdk/agent/src/hud/
  index.html              the captures grid; still the only thing the agent serves
```

The two halves deploy separately. The sidecar is
`scp -r rdk/vision root@$BOARD:/opt/max/rdk/` plus `systemctl restart
max-vision`. The page ships with the agent, which runs from source
(`tsx /opt/max/rdk/agent/src/main.ts`) and reads `index.html` at startup — so it
is `scp -r rdk/agent root@$BOARD:/opt/max/rdk/` plus `systemctl restart
max-agent`, with no build step. **Restarting max-agent drops any live voice
session**, so it is worth doing deliberately rather than in a loop.

`bench_server.py` exposes `serve(pair, gallery, port)`. It is named for its
audience: everything it serves exists for the bench HUD, which the rider cannot
see.

### Routes

| Route | Returns |
| ----- | ------- |
| `GET /preview/front` \| `/preview/rear` | MJPEG stream; `503` when that camera is absent |
| `GET /gallery` | JSON, newest first, from `list_pairs()`, with file sizes |
| `GET /gallery/<pair>/<file>` | the bytes, with a correct content type |
| `GET /gallery/<pair>/<file>/thumb` | for a `.mjpeg`, the first JPEG only |

Preview behaviour is carried over unchanged, including the threading and the
`503`, both of which exist for reasons measured today.

`thumb` slices at the second start-of-image marker. That is what gives a
recording a thumbnail without a transcode on a board that plateaus near 94 °C.

### Path traversal must be blocked

This server binds `0.0.0.0` and the sidecar runs as **root**. Anyone on the LAN
shapes the path, so `GET /gallery/../../../etc/shadow` reads whatever root can
read unless the server refuses.

Every requested path is resolved and must sit inside the gallery root. Anything
else is a `404` — not a `403`, which would confirm the file exists. This covers
`../`, absolute paths, and URL-encoded variants, because the check is on the
resolved result rather than on the spelling of the input.

### CORS

`GET /gallery` sends `Access-Control-Allow-Origin: *`: the page is served from
`:8080` and fetches `:8081`, so the JSON is a cross-origin read. Images inside
`<img>` are not, and need nothing.

This is a LAN bench instrument with no authentication, which the wildcard does
not change — anyone who can reach the port can already read it directly.

## The page

A `captures` section under the transcript: a grid of tiles, newest first.

- A photo shows its image; clicking opens the original.
- A recording shows its first frame, labelled with size, and links the raw file
  for download. Browsers cannot play concatenated JPEG natively, so pretending
  otherwise would produce a tile that looks broken.
- A degraded pair shows whichever side exists.

The page polls `/gallery` every 3 seconds and **re-renders only when the list
differs from the last one**. Rebuilding unconditionally would reset every `src`
on each poll and flicker the whole grid.

## Error handling

| Case | Behaviour |
| ---- | --------- |
| Sidecar unreachable | The section says so |
| No captures yet | The section says *that*, distinctly |
| Manifest names a missing file | That tile is marked missing |
| Unknown pair or escaped path | `404` |

The first two rows are the point. Today a blank panel meant "the server is
wedged" and looked exactly like "there is nothing to show" — that ambiguity cost
an hour of debugging this afternoon. An empty grid must never be able to mean
two things.

## Testing

**Unit, on the board** (`rdk/vision/tests/`):

- listing returns pairs newest first, with sizes
- the file route serves bytes with the right content type
- **traversal is rejected**: `../`, an absolute path, and `%2e%2e` all `404`
- an unknown pair `404`s
- `thumb` returns exactly the first frame of a multi-frame `.mjpeg`
- **`test_preview.py` passes unchanged** — the regression guard on moving the
  server out of `camera.py`. If it needs editing, the move changed behaviour.

**Manual:** open the HUD, ask Max for a photo, watch the tile appear.

## Out of scope

- **Deleting captures.** An unauthenticated page bound to `0.0.0.0` should not
  destroy evidence on a click. Disk pressure is real, but `rm` over SSH is the
  right tool for now.
- Serving the gallery to the phone or web app. `gallery.open` stays
  `supported: false`; this is a bench instrument.
- Transcoding recordings to MP4.
- Any change to the agent beyond the page it already serves.
