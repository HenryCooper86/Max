# Vision Describe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the rider asks what Max can see, one downscaled frame goes to a vision model and Max says what it saw — or says he could not see, never a guess.

**Architecture:** A new `camera.look` device action returns `ok` from the board within a second (a buffer read), so the relay's 8 s device timeout is never in play. The frame then travels board→relay as a new `camera.frame` client event, the relay calls a vision endpoint, and the description is spoken through the speech path that landed in `server/speech.ts`.

**Tech Stack:** Python 3.10 (`http.server`, OpenCV already on the board), TypeScript, vitest, pytest 6.2.5 on the board.

**Spec:** `docs/superpowers/specs/2026-07-28-vision-describe-design.md`

## Global Constraints

- **Two test suites, two places.** Python runs on the board: `scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'`. TypeScript runs locally: `npm test`. `export BOARD=10.42.0.11` — network-dependent; find it with `arp -a`, confirm with `ssh root@<ip> 'ls /usr/hobot'`.
- **`MAX_VISION_SHARE` defaults to `0`.** Only the exact string `1` enables it, matching `MAX_ADAS_SHADOW`. With it off the sidecar refuses to return a frame, so **no image leaves the board**. This is the consent control and it is not optional.
- **Max never guesses.** Any failure — refused, no camera, model error, timeout, missing credentials — produces a truthful line. Never a fabricated description. On a motorcycle an invented answer about what is ahead is worse than silence.
- **The device round trip stays fast.** `camera.look` must return `device.result` without waiting for the model. If a task makes the reconciliation await a network call, the approach has gone wrong.
- **No new dependencies** in either language. `cv2` is already on the board; Node's global `fetch` is enough.
- **The existing speech behaviour must not regress.** `server/speech.ts` chunks at 20 ms because the board's `pump()` cannot subdivide a chunk; nothing here may bypass `createSpeaker`.
- Work on branch `feat/vision-describe` (already created; the spec is committed there).

---

### Task 1: Establish the vision endpoint — a gate, not a formality

Nothing else can be built correctly until this is known. The repo contains no Ark/chat-completions integration to copy.

**Files:**

- Modify: `docs/superpowers/specs/2026-07-28-vision-describe-design.md` (record the findings)

**Interfaces:**

- Produces: the endpoint URL, the model id, the exact request body shape, the response path to the description text, and which credential authenticates. Every later task reads these from this task's report.

- [ ] **Step 1: Find a real frame to test with**

```bash
export BOARD=10.42.0.11
ssh root@$BOARD 'ls -t /var/lib/max/gallery/*/front.jpg 2>/dev/null | head -1'
```

Copy one locally. If the gallery is empty, capture one:

```bash
ssh root@$BOARD 'python3 -c "
import socket, json
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect(\"/run/max/vision.sock\")
s.sendall(json.dumps({\"id\":\"v1\",\"op\":\"camera.photo\",\"args\":{}}).encode()+b\"\n\")
print(s.recv(4096).decode().strip())
"'
```

- [ ] **Step 2: Check whether a usable credential exists at all**

```bash
KEY=~/Desktop/LightsailDefaultKey-ap-northeast-2.pem
ssh -i "$KEY" -o BatchMode=yes ubuntu@3.35.135.136 \
  'grep -oE "^[A-Z_]*(ARK|VISION|DOUBAO)[A-Z_]*=" /home/ubuntu/app/.env | sort'
```

This lists variable **names only** — do not print values.

**If no plausible vision credential exists, STOP and report.** The speech feature is already inert waiting on `DOUBAO_TTS_*`; a second feature blocked the same way is worth saying out loud before any code is written. Do not guess a key name and do not proceed to Step 3 with a credential you are not confident about.

- [ ] **Step 3: Probe the endpoint with the real frame**

Volcano Ark's chat-completions endpoint uses a standard message shape and takes an image as a
data URL. Confirm the exact model id available to this account before trusting
any of the following — it is the value most likely to differ.

```bash
# Fill ARK_KEY and ARK_MODEL from what Step 2 found and the account's model list.
python3 - <<'PY'
import base64, json, os, urllib.request

endpoint = "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
key = os.environ["ARK_KEY"]
model = os.environ["ARK_MODEL"]
image = base64.b64encode(open("/tmp/front.jpg", "rb").read()).decode()

body = {
    "model": model,
    "messages": [{
        "role": "user",
        "content": [
            {"type": "text", "text": "用一句话描述这张照片里的场景，简洁自然，像对骑手说话。"},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image}"}},
        ],
    }],
}
req = urllib.request.Request(
    endpoint,
    data=json.dumps(body).encode(),
    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=30) as r:
    payload = json.load(r)
print(json.dumps(payload, ensure_ascii=False)[:1200])
PY
```

Record: the HTTP status, the full response shape, and **where in it the text lives** (expected `choices[0].message.content`, but confirm rather than assume). Also record how long the call took — Task 5's timeout budget depends on it.

- [ ] **Step 4: Confirm the description actually matches the photo**

Open the frame you sent and read the description beside it. A plausible sentence
about the wrong scene is the failure mode that matters here, and it will not show
up as an error.

- [ ] **Step 5: Record the findings in the spec**

Replace the spec's "Two unknowns, settled before anything depends on them"
section with what you measured: endpoint, model id, credential variable name,
the JSON path to the text, and the observed latency. If a value differs from the
probe above, the measured value wins and later tasks use it.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-07-28-vision-describe-design.md
git commit -m "docs(vision): record the measured vision endpoint and model"
```

---

### Task 2: `/frame/front` on the sidecar, behind the consent gate

**Files:**

- Modify: `rdk/vision/bench_server.py`
- Test: `rdk/vision/tests/test_bench_frame.py`

**Interfaces:**

- Produces: `downscale(jpeg: bytes, width: int) -> bytes | None`, and the route `GET /frame/front[?w=N]` (default 640) returning one JPEG; `403` when sharing is off; `503` when that camera is absent.
- `serve(pair, gallery, port)` gains a keyword argument `share_frames: bool = False`.

- [ ] **Step 1: Write the failing tests**

Create `rdk/vision/tests/test_bench_frame.py`:

```python
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from bench_server import downscale, serve
from camera import CameraPair
from gallery import Gallery


def jpeg_of(width: int, height: int) -> bytes:
    """A real, decodable JPEG — downscale() must not be testable with a stub."""
    import cv2  # noqa: PLC0415 - board-only
    import numpy as np  # noqa: PLC0415

    image = np.zeros((height, width, 3), dtype=np.uint8)
    image[:, : width // 2] = (0, 0, 255)
    ok, buf = cv2.imencode(".jpg", image)
    assert ok
    return buf.tobytes()


def dims(jpeg: bytes) -> tuple[int, int]:
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    decoded = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    return decoded.shape[1], decoded.shape[0]


class FakeCamera:
    def jpeg(self):
        return jpeg_of(1920, 1080)

    def stop(self):
        pass


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def running(share: bool, front=None) -> int:
    port = free_port()
    pair = CameraPair(front_channel=0, rear_channel=2)
    pair.front = FakeCamera() if front is None else front
    gallery = Gallery("/tmp/bench-frame-test", min_free_mb=0)
    threading.Thread(
        target=serve, args=(pair, gallery, port), kwargs={"share_frames": share}, daemon=True
    ).start()
    time.sleep(0.5)
    return port


def status_of(port: int, path: str) -> int:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def test_downscale_fits_the_longest_edge():
    out = downscale(jpeg_of(1920, 1080), 640)
    assert dims(out) == (640, 360)


def test_downscale_preserves_a_portrait_aspect():
    out = downscale(jpeg_of(1080, 1920), 640)
    assert dims(out) == (360, 640)


def test_downscale_does_not_upscale_a_small_frame():
    # Enlarging invents detail the sensor never captured.
    out = downscale(jpeg_of(320, 240), 640)
    assert dims(out) == (320, 240)


def test_downscale_returns_none_for_junk():
    assert downscale(b"not a jpeg", 640) is None


def test_the_route_serves_a_downscaled_frame():
    port = running(share=True)
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/frame/front", timeout=5) as response:
        assert response.status == 200
        assert response.headers["Content-Type"] == "image/jpeg"
        body = response.read()
    assert dims(body) == (640, 360)


def test_the_route_honours_an_explicit_width():
    port = running(share=True)
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/frame/front?w=320", timeout=5) as response:
        assert dims(response.read()) == (320, 180)


def test_sharing_off_refuses_with_403():
    # The consent gate: no image may leave the board unless it is on.
    port = running(share=False)
    assert status_of(port, "/frame/front") == 403


def test_an_absent_camera_is_503_even_when_sharing_is_on():
    # The fixture never populates rear, so this is the absent-camera case
    # without needing a second fixture.
    port = running(share=True)
    assert status_of(port, "/frame/rear") == 503


def test_a_silly_width_is_rejected():
    port = running(share=True)
    assert status_of(port, "/frame/front?w=99999") == 400
    assert status_of(port, "/frame/front?w=abc") == 400
```

Note the eighth test asks for `/frame/rear`, which the fixture never populates —
that is the absent-camera case without needing a second fixture.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && timeout 180 python3 -m pytest tests/test_bench_frame.py -q'
```

Expected: FAIL — `cannot import name 'downscale'`.

- [ ] **Step 3: Implement the downscale**

In `rdk/vision/bench_server.py`, add beside the other helpers:

```python
#: Longest edge of a shared frame. Enough for a model to describe a scene and
#: cheap to upload from a board that usually lives on a phone tether.
DEFAULT_FRAME_WIDTH = 640
MAX_FRAME_WIDTH = 1920


def downscale(jpeg: bytes, width: int) -> bytes | None:
    """Re-encode a JPEG with its longest edge at ``width``. None if undecodable.

    Never upscales: enlarging invents detail the sensor did not capture, and the
    only thing that buys is a bigger upload.
    """
    import cv2  # noqa: PLC0415 - board-only
    import numpy as np  # noqa: PLC0415

    image = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return None

    height, source_width = image.shape[:2]
    longest = max(source_width, height)
    if longest > width:
        scale = width / longest
        image = cv2.resize(
            image,
            (max(1, round(source_width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    ok, buf = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
    return buf.tobytes() if ok else None
```

- [ ] **Step 4: Add the route and the gate**

Change the signature to `def serve(pair, gallery, port: int, share_frames: bool = False) -> None:`, add `from urllib.parse import urlparse, parse_qs` to the imports, extend `do_GET`:

```python
            elif self.path.startswith("/frame/"):
                self._frame()
```

and add the handler:

```python
        def _frame(self) -> None:
            # Consent, not capability: with sharing off no image leaves the
            # board at all, whatever the relay is configured to do.
            if not share_frames:
                self.send_error(403, "frame sharing is off")
                return

            parsed = urlparse(self.path)
            raw_width = parse_qs(parsed.query).get("w", [str(DEFAULT_FRAME_WIDTH)])[0]
            try:
                width = int(raw_width)
            except ValueError:
                self.send_error(400, "bad width")
                return
            if not 64 <= width <= MAX_FRAME_WIDTH:
                self.send_error(400, "width out of range")
                return

            camera = pair.front if parsed.path.endswith("front") else pair.rear
            data = pair._grab(camera)
            if data is None:
                self.send_error(503, "camera not available")
                return

            shrunk = downscale(data, width)
            if shrunk is None:
                self.send_error(503, "frame not decodable")
                return

            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(shrunk)))
            self.end_headers()
            self.wfile.write(shrunk)
```

- [ ] **Step 5: Pass the flag from the service**

In `rdk/vision/service.py`, beside the other environment reads:

```python
#: Consent gate. Only "1" lets a frame leave the board.
SHARE_FRAMES = os.environ.get("MAX_VISION_SHARE", "0") == "1"
```

and pass it to the bench server thread:

```python
    threading.Thread(
        target=serve_bench,
        args=(cameras, gallery, PREVIEW_PORT),
        kwargs={"share_frames": SHARE_FRAMES},
        daemon=True,
    ).start()
```

- [ ] **Step 6: Run the tests, then the whole board suite**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && timeout 300 python3 -m pytest tests/test_bench_frame.py -q && python3 -m pytest tests/ -q'
```

Expected: 9 new tests pass; the full board suite passes with no regressions.

- [ ] **Step 7: Commit**

```bash
git add rdk/vision/bench_server.py rdk/vision/service.py rdk/vision/tests/test_bench_frame.py
git commit -m "feat(vision): serve one downscaled frame, behind a consent gate"
```

---

### Task 3: The `camera.look` action

Control-plane only. After this task the rider can ask, Max answers "我看看…", and the board fetches a frame — it just does not go anywhere yet.

**Files:**

- Modify: `server/device-actions.ts`
- Modify: `rdk/agent/src/device/capabilities.ts`
- Modify: `rdk/agent/src/device/dispatch.ts`
- Modify: `rdk/agent/src/config.ts`
- Test: `tests/device-actions.test.ts`, `tests/device-reconciliation.test.ts`

**Interfaces:**

- Produces: `"camera.look"` in `DeviceActionName`, in `DEVICE_ACTION_TIERS` as `"low"`, in the `DeviceCommand` union with `args: Record<string, never>`, `deviceSuccessSpeech({ action: "camera.look", args: {} }) === "我看看…"` — note it takes the command object, not an action name, a denied line, and `{ supported: true }` on the board.
- The dispatcher fetches `http://127.0.0.1:<previewPort>/frame/front` and returns `denied`/`failed` appropriately. Config gains `visionPreviewPort` — already present as `MAX_VISION_PREVIEW_PORT`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/device-actions.test.ts`:

```ts
it("detects a request to look", () => {
  for (const phrase of ["你能看到什么", "前面是什么", "看看前面", "what do you see"]) {
    expect(extractDeviceCommand(phrase)?.action).toBe("camera.look");
  }
});

it("does not mistake looking for taking a photo", () => {
  // 拍照 must still win; the two are separate actions with separate speech.
  expect(extractDeviceCommand("帮我拍照")?.action).toBe("camera.photo");
  expect(extractDeviceCommand("打开相册")?.action).toBe("gallery.open");
});
```

The exported detector is `extractDeviceCommand` (an `IntentExtractor`), not
`detectDeviceAction`. Add it to the file's existing import list.

Add to `tests/device-reconciliation.test.ts`:

```ts
it("speaks a filler while it looks", () => {
  expect(reconcileDeviceResult("camera.look", { status: "ok" }, "我看看…")).toEqual({
    truncate: true,
    speech: "我看看…"
  });
});

it("says it cannot look when sharing is off", () => {
  const decision = reconcileDeviceResult("camera.look", { status: "denied", reason: "vision.sharingOff" });
  expect(decision.truncate).toBe(true);
  expect(decision.speech).toBe("我现在不能看。");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- tests/device-actions.test.ts tests/device-reconciliation.test.ts`
Expected: FAIL — `camera.look` is not a `DeviceActionName`.

- [ ] **Step 3: Add the action to the relay's types and maps**

In `server/device-actions.ts`: add `| "camera.look"` to `DeviceActionName`; add
`| { action: "camera.look"; args: Record<string, never> }` to the `DeviceCommand`
union; add `"camera.look": "low"` to `DEVICE_ACTION_TIERS`; add `"camera.look": "看看"`
to the Chinese label map beside `"camera.photo": "拍照"`.

In `deviceSuccessSpeech`, beside the `camera.photo` case:

```ts
    case "camera.look":
      // A filler, not the answer. The description arrives seconds later and is
      // spoken separately; silence here reads as "he didn't hear me" and gets
      // the question repeated, which would send a second frame.
      return "我看看…";
```

Add the denied line to `deviceFailureSpeech(action, status, reason)` — that is
where `reconcileDeviceResult` sources every non-ok line — keyed on the
`vision.sharingOff` reason, with the text `"我现在不能看。"`.

Add the detection beside the `拍照` rule — **before** it, so 看 phrasings are not
swallowed:

```ts
if (/(你能?看到?什么|前面是什么|看看前面|看一下前面)/.test(raw) || /what\s+(do|can)\s+you\s+see/i.test(raw)) {
  return { action: "camera.look", args: {} };
}
```

- [ ] **Step 4: Declare it supported on the board and fetch the frame**

In `rdk/agent/src/device/capabilities.ts`, add `"camera.look": { supported: true },`.

In `rdk/agent/src/device/dispatch.ts`, add a `previewPort: number` to
`DispatcherOptions`, and special-case the action beside `volume.set`:

```ts
if (command.action === "camera.look") {
  // Fetched over HTTP, never the control socket: image bytes stay off
  // that channel. The frame is a buffer read on the sidecar, so this
  // returns long before the relay's 8 s device timeout.
  const response = await fetch(`http://127.0.0.1:${options.previewPort}/frame/front`);
  if (response.status === 403) {
    return {
      type: "device.result",
      commandId: command.commandId,
      status: "denied",
      reason: "vision.sharingOff"
    };
  }
  if (!response.ok) {
    return { type: "device.result", commandId: command.commandId, status: "failed" };
  }
  const frame = Buffer.from(await response.arrayBuffer());
  options.onFrame?.(command.commandId, frame);
  return { type: "device.result", commandId: command.commandId, status: "ok" };
}
```

Add `onFrame?: (commandId: string, jpeg: Buffer) => void;` to `DispatcherOptions`.
Task 5 supplies it; until then the frame is fetched and dropped, which is the
point of stopping here.

In `rdk/agent/src/main.ts`, pass `previewPort: config.visionPreviewPort` where the
dispatcher is constructed.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS. The two new relay tests pass and nothing else moves.

- [ ] **Step 6: Commit**

```bash
git add server/device-actions.ts rdk/agent/src/device/ rdk/agent/src/main.ts tests/device-actions.test.ts tests/device-reconciliation.test.ts
git commit -m "feat(vision): add camera.look and fetch the frame on the board"
```

---

### Task 4: The `camera.frame` client event

**Files:**

- Modify: `protocol/agent-events.schema.json`
- Modify: `server/session-controller.ts`
- Modify: `server/providers/types.ts`
- Generated (do not hand-edit): `shared/generated/agent-protocol.ts`, `android/app/src/main/java/com/horizon/maxhelmet/agent/GeneratedAgentProtocol.kt`, `ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift`
- Test: `tests/agent.test.ts` or the existing client-event validation test file — match where `hazard.report` validation is tested

**Interfaces:**

- Produces: client event `{ type: "camera.frame", commandId: string, image: string }` where `image` is base64 JPEG; `AgentProvider` gains `cameraFrame?(event: { commandId: string; image: string }): Promise<void>`.

- [ ] **Step 1: Add the event to the schema**

In `protocol/agent-events.schema.json`, in the **ClientEvent** `oneOf` (the one containing `hazard.report`), add:

```json
{
  "title": "CameraFrame",
  "type": "object",
  "properties": {
    "type": { "const": "camera.frame" },
    "commandId": { "type": "string" },
    "image": { "type": "string" }
  },
  "required": ["type", "commandId", "image"]
}
```

- [ ] **Step 2: Regenerate the three clients**

```bash
npx tsx scripts/generate-agent-protocol.ts
git status --porcelain shared/generated android ios
```

Expected: the three generated files change. **Do not hand-edit them.** If the script is not run this way, check `package.json` for the script name and use that.

- [ ] **Step 3: Write the failing validation test**

Find where `hazard.report` validation is tested and add, in the same style:

```ts
it("accepts a camera frame", () => {
  const event = parseClientEvent({ type: "camera.frame", commandId: "c1", image: "AAAA" });
  expect(event).toMatchObject({ type: "camera.frame", commandId: "c1" });
});

it("rejects a frame with no commandId", () => {
  expect(() => parseClientEvent({ type: "camera.frame", image: "AAAA" })).toThrow();
});

it("rejects an oversized frame", () => {
  // A 640px JPEG is ~40 KB, ~55 KB base64. The cap stops a client pushing
  // megabytes through the control plane.
  const huge = "A".repeat(400_000);
  expect(() => parseClientEvent({ type: "camera.frame", commandId: "c1", image: huge })).toThrow();
});
```

Use the actual parser name from that file — do not invent `parseClientEvent` if it is called something else.

- [ ] **Step 4: Validate it in the session controller**

In `server/session-controller.ts`, beside the `hazard.report` block:

```ts
if (value.type === "camera.frame") {
  if (typeof value.commandId !== "string" || !value.commandId.trim() || value.commandId.length > 120) {
    throw new Error("Invalid camera.frame commandId");
  }
  // ~55 KB for a 640px frame. The cap is a control-plane guard, not a quality
  // setting: without it a client can push megabytes through this path.
  if (typeof value.image !== "string" || !value.image || value.image.length > 200_000) {
    throw new Error("Invalid camera.frame image");
  }
  return { type: "camera.frame", commandId: value.commandId, image: value.image };
}
```

and route it beside the `device.result` line in the handler:

```ts
if (event.type === "camera.frame") await this.provider.cameraFrame?.(event);
```

In `server/providers/types.ts`, add to `AgentProvider`:

```ts
  /** One frame the rider asked Max to look at. Providers without a vision path
   *  omit this. */
  cameraFrame?(event: { commandId: string; image: string }): Promise<void>;
```

- [ ] **Step 5: Run the suite and the protocol check**

```bash
npm run check:protocol && npm test
```

Expected: both pass. `check:protocol` verifies the generated files match the schema.

- [ ] **Step 6: Commit**

```bash
git add protocol/ shared/generated/ android/ ios/ server/session-controller.ts server/providers/types.ts tests/
git commit -m "feat(protocol): add the camera.frame client event"
```

---

### Task 5: Describe the frame and say it

**Files:**

- Create: `server/vision.ts`
- Modify: `server/providers/doubao.ts`
- Test: `tests/vision.test.ts`

**Interfaces:**

- Consumes: the endpoint, model id, credential name and response path recorded by **Task 1** — read that task's report and use the measured values, not the ones guessed in its probe script.
- Produces: `createDescriber(options): (imageBase64: string) => Promise<string | null>` returning the description or `null`, never throwing. Options: `{ apiKey?: string; model?: string; endpoint?: string; prompt?: string; fetchImpl?: typeof fetch; timeoutMs?: number; onFailure?: (reason: string) => void }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/vision.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createDescriber } from "../server/vision";

function reply(text: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: text } }] })
  } as unknown as Response;
}

function describer(overrides: Partial<Parameters<typeof createDescriber>[0]> = {}) {
  const fetchImpl = vi.fn(async () => reply("前面是一条空路。"));
  const describe_ = createDescriber({
    apiKey: "key",
    model: "vision-model",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides
  });
  return { describe: describe_, fetchImpl };
}

describe("createDescriber", () => {
  it("returns the description", async () => {
    const { describe: run } = describer();
    expect(await run("AAAA")).toBe("前面是一条空路。");
  });

  it("sends the image as a data url and asks in Chinese", async () => {
    const { describe: run, fetchImpl } = describer();
    await run("AAAA");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    const parts = body.messages[0].content;
    expect(parts.find((p: { type: string }) => p.type === "image_url").image_url.url).toBe(
      "data:image/jpeg;base64,AAAA"
    );
    expect(parts.find((p: { type: string }) => p.type === "text").text).toMatch(/描述/);
  });

  it("returns null without a key and never calls out", async () => {
    const fetchImpl = vi.fn();
    const run = createDescriber({ model: "m", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await run("AAAA")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when the service rejects", async () => {
    const { describe: run } = describer({
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    });
    expect(await run("AAAA")).toBeNull();
  });

  it("returns null when the payload has no text", async () => {
    const { describe: run } = describer({
      fetchImpl: (async () => ({ ok: true, json: async () => ({ choices: [] }) })) as unknown as typeof fetch
    });
    expect(await run("AAAA")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const { describe: run } = describer({
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch
    });
    expect(await run("AAAA")).toBeNull();
  });

  it("reports a reason on each failure", async () => {
    const reasons: string[] = [];
    const { describe: run } = describer({
      onFailure: (reason) => reasons.push(reason),
      fetchImpl: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch
    });
    await run("AAAA");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("401");
  });

  it("never caches — every look is a new scene", async () => {
    const { describe: run, fetchImpl } = describer();
    await run("AAAA");
    await run("AAAA");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
```

That last test is the important one: the speech synthesizer caches by text, and
copying that habit here would describe a stale scene.

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- tests/vision.test.ts`
Expected: FAIL — cannot resolve `../server/vision`.

- [ ] **Step 3: Implement the describer**

Create `server/vision.ts`. Use the endpoint, model default and response path
**recorded in Task 1's report**; the shape below matches the probe and is what
the tests assume:

```ts
/**
 * Describing one frame the rider asked about.
 *
 * Separate from the realtime speech socket, which has no image input. Returns
 * null on every failure rather than throwing: the caller speaks "我看不清" and
 * a guessed description about what is ahead is worse than silence.
 *
 * Nothing is cached. The synthesizer in speech.ts caches by text because a
 * confirmation is always the same sentence; a scene never is.
 */

export const VISION_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";

const DEFAULT_PROMPT = "用一句话描述这张照片里的场景，简洁自然，像对骑手说话。";
const DEFAULT_TIMEOUT_MS = 10_000;

export type DescriberOptions = {
  apiKey?: string;
  model?: string;
  endpoint?: string;
  prompt?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onFailure?: (reason: string) => void;
};

export function createDescriber(options: DescriberOptions): (imageBase64: string) => Promise<string | null> {
  const {
    apiKey,
    model,
    endpoint = VISION_ENDPOINT,
    prompt = DEFAULT_PROMPT,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onFailure
  } = options;

  let loggedMissingKey = false;

  return async function describe(imageBase64: string): Promise<string | null> {
    if (!apiKey || !model) {
      if (!loggedMissingKey) {
        loggedMissingKey = true;
        onFailure?.("not configured");
      }
      return null;
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
              ]
            }
          ]
        }),
        signal: abort.signal
      });
      if (!response.ok) {
        onFailure?.(`rejected — http ${response.status}`);
        return null;
      }
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const text = body.choices?.[0]?.message?.content?.trim();
      if (!text) {
        onFailure?.("no description in the response");
        return null;
      }
      return text;
    } catch (error) {
      onFailure?.(abort.signal.aborted ? "timed out" : `failed — ${String(error)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
```

- [ ] **Step 4: Wire it into the provider**

In `server/providers/doubao.ts`, beside the module-scope `synthesizeConfirmation`:

```ts
const describeFrame = createDescriber({
  apiKey: process.env.DOUBAO_VISION_KEY ?? process.env.DOUBAO_API_KEY,
  model: process.env.DOUBAO_VISION_MODEL,
  onFailure: (reason) => visionLog.warn("scene description failed", { reason })
});
```

Use the credential variable **Task 1 recorded**; if it found that a dedicated key
is required, drop the `?? process.env.DOUBAO_API_KEY` fallback rather than
silently sending a speech key to a vision endpoint.

Add the provider method beside `deviceResult`:

```ts
    async cameraFrame(event) {
      const description = await describeFrame(event.image);
      const line = description ?? "我看不清。";
      sendClient(transcriptEvent(agentDelivery, "agent", line, { final: true, useBrowserSpeech: true }));
      void speaker.speak(line).catch(() => {});
    },
```

The transcript goes out whether or not the description arrived, so a bench
session can read the outcome even when the helmet is silent.

- [ ] **Step 5: Send the frame from the board**

In `rdk/agent/src/main.ts`, supply the dispatcher's `onFrame` so the fetched frame
reaches the relay:

```ts
    onFrame: (commandId, jpeg) =>
      relay.send({ type: "camera.frame", commandId, image: jpeg.toString("base64") }),
```

Match whatever the board already calls to send a client event — check how
`hazard.report` is sent from `main.ts` and use the same path rather than
inventing `relay.send`.

- [ ] **Step 6: Run everything**

```bash
npm test && npm run check
```

Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add server/vision.ts server/providers/doubao.ts rdk/agent/src/main.ts tests/vision.test.ts
git commit -m "feat(vision): describe the frame and say what it saw"
```

---

### Task 6: Ask it on the board

**Files:**

- Modify: `rdk/README.md`

- [ ] **Step 1: Confirm the consent gate refuses first**

With `MAX_VISION_SHARE` unset or `0`, deploy the sidecar and confirm no frame leaves:

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'systemctl restart max-vision && sleep 16'
curl -s -o /dev/null -w "sharing off: http %{http_code}\n" "http://$BOARD:8081/frame/front"
```

Expected: `403`. **If this returns an image, stop** — the consent gate is the one
part of this feature that must not be wrong.

- [ ] **Step 2: Turn it on and check the frame**

```bash
ssh root@$BOARD 'grep -q MAX_VISION_SHARE /etc/max/agent.env || echo "MAX_VISION_SHARE=1" >> /etc/max/agent.env
sed -i "s/^MAX_VISION_SHARE=.*/MAX_VISION_SHARE=1/" /etc/max/agent.env
systemctl restart max-vision && sleep 16'
curl -s --max-time 10 -o /tmp/look.jpg -w "http %{http_code}  bytes %{size_download}\n" "http://$BOARD:8081/frame/front"
python3 -c "
d=open('/tmp/look.jpg','rb').read(); print('jpeg:', d[:3]==b'\xff\xd8\xff', 'bytes:', len(d))
"
```

Expected: `200`, roughly 20–60 KB. Open `/tmp/look.jpg` and confirm it is the
scene the camera is pointed at, downscaled — not a black frame.

- [ ] **Step 3: Deploy the relay**

```bash
./deploy-lightsail.command   # or LIGHTSAIL_ALLOW_NON_MAIN=on ./deploy-lightsail.command for this branch
curl -ks https://3.35.135.136/health
```

Expected: `build.gitCommit` matches what you just deployed.

- [ ] **Step 4: Ask, and check the answer against the frame**

Point the camera at something identifiable. With a live session, say
**"Max 你能看到什么"**.

Expected: "我看看…" immediately, then a description a few seconds later. Then —
and this is the check that matters — pull the frame the board actually sent and
read the description beside it:

```bash
curl -s --max-time 10 -o /tmp/asked.jpg "http://$BOARD:8081/frame/front"
```

A fluent sentence about the wrong scene is the failure mode here and it will not
appear as an error anywhere. If the description does not match, stop and report
rather than recording success.

- [ ] **Step 5: Confirm the failure path is honest**

Turn sharing back off, restart max-vision, and ask again.

Expected: Max says he cannot look — not silence, and not a description.

- [ ] **Step 6: Record the results**

Add to the bench-findings table in `rdk/README.md`, with the measured latency:

```markdown
| Vision describe | **works** — "我看看…" then a description matching the frame | 2026-07-28 |
| Vision round trip | **N.N s** from question to spoken description, 640 px frame | 2026-07-28 |
```

And a short section beside the camera notes explaining `MAX_VISION_SHARE`, that
it defaults to `0`, that no frame leaves the board while it is off, and that a
failed description is spoken as "我看不清" rather than guessed.

- [ ] **Step 7: Turn sharing off and commit**

Leave the board in its default state:

```bash
ssh root@$BOARD 'sed -i "s/^MAX_VISION_SHARE=.*/MAX_VISION_SHARE=0/" /etc/max/agent.env && systemctl restart max-vision'
git add rdk/README.md
git commit -m "docs(vision): record the scene description working on the board"
```

---

## Notes for the implementer

- **Task 1 is a gate.** If no vision credential exists, stop and say so. Two features waiting on credentials is worth reporting, not working around.
- **The consent gate is the one thing that must not be wrong.** `MAX_VISION_SHARE=0` means no image leaves the board. Task 6 Step 1 verifies it before anything else.
- **Never let a failure become a guess.** Every path that cannot produce a real description says "我看不清".
- **Do not cache descriptions.** The speech synthesizer caches by text because a confirmation is always the same sentence; a scene is never the same twice.
- **Do not hand-edit the generated protocol files.** Change the schema and regenerate.
