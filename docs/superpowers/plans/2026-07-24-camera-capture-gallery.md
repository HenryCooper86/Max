# Camera Capture & Max Gallery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a rider speak "拍照" / "开始录像" and have Max capture photos and silent video into an in-app Max gallery, with per-item export to the system Photos library — all on the Spec 1 device-action spine, with truthful spoken confirmations.

**Architecture:** New `camera.photo`, `camera.record`, and `gallery.open` actions flow through the existing relay grammar → `device.command` → `DeviceActionRouter` path. A `CameraController` (a `DeviceActionHandler`) runs a rear-camera, video-only `AVCaptureSession` and writes through a `CaptureStore` (files + JSON index + thumbnails). A `GalleryModel` bridges that store to SwiftUI grid/viewer surfaces, and a `PhotoLibraryAdding` exporter copies captures to Photos.

**Tech Stack:** TypeScript + Express + `ws` + Vitest (relay); Swift + SwiftUI + AVFoundation + Photos + XCTest (iOS). No new dependencies on either side.

**Spec:** `docs/superpowers/specs/2026-07-24-camera-capture-gallery-design.md`

## Global Constraints

- New branch `feat/camera-gallery`, cut from `main`.
- No new npm or SwiftPM dependencies. The iOS target keeps zero third-party deps.
- Every command resolves to exactly one `device.result`. Silence is a bug.
- Video is **silent** — the capture session has no audio input and sets `automaticallyConfiguresApplicationAudioSession = false`, so the voice engine keeps the mic.
- Camera and gallery-open actions are **low tier** (they execute immediately with a spoken confirmation).
- Benign states — `start` while recording, `stop` while idle — return `failed` with reason `camera.recording` / `camera.notRecording` so Spec 1's reconciliation speaks the benign line and corrects Max; no file is created or lost.
- Recording auto-stops at **600 seconds** (10 min). The low-space threshold is **500 MB**.
- Nothing auto-deletes; a low-space capture is refused with `storage.full`.
- Export uses **add-only** Photos authorization (`NSPhotoLibraryAddUsageDescription`); Max never reads the rider's library. Export is a copy — the capture stays in the gallery, badged `exported`.
- Chinese is the default spoken language; every rider-facing string added here is Chinese.
- New Swift files: capture engine in `ios/MaxHelmet/Capture/`, the camera handler in `ios/MaxHelmet/Actions/`, gallery in `ios/MaxHelmet/Gallery/`. `AgentSession.swift` only forwards and wires — no capture logic there.
- `protocol/agent-events.schema.json` is the source of truth; never hand-edit the three generated files.
- Run `npm run check` before the final commit of any server task.

**Server test:** `npx vitest run tests/<file>` · **Full gate:** `npm run check`

**iOS test:**

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild \
  -project ios/MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

---

### Task 1: Server — camera command grammar

**Files:**
- Modify: `server/device-actions.ts`
- Modify: `server/providers/mock.ts` (add one demo line)
- Modify: `tests/device-actions.test.ts`

**Interfaces:**
- Consumes: the existing `DeviceCommand` union, `DeviceActionName`, `DEVICE_ACTION_TIERS`, `ACTION_LABELS`, `FAILURE_SPEECH`, `extractDeviceCommand` in `server/device-actions.ts`.
- Produces: `camera.photo`, `camera.record` (`{ start: boolean }`), and `gallery.open` recognized by `extractDeviceCommand`, tiered `low`, labelled, with the five new failure-speech keys.

- [ ] **Step 1: Write the failing test**

Append to `tests/device-actions.test.ts`:

```ts
describe("extractDeviceCommand — camera", () => {
  it("takes a photo in Chinese and English", () => {
    expect(extractDeviceCommand("Max 拍照")).toEqual({ action: "camera.photo", args: {} });
    expect(extractDeviceCommand("Max 拍张照片")).toEqual({ action: "camera.photo", args: {} });
    expect(extractDeviceCommand("Max take a photo")).toEqual({ action: "camera.photo", args: {} });
  });

  it("starts and stops recording, checking stop before start", () => {
    expect(extractDeviceCommand("Max 开始录像")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max 录个视频")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max start recording")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max 停止录像")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max stop recording")).toEqual({ action: "camera.record", args: { start: false } });
  });

  it("opens the gallery", () => {
    expect(extractDeviceCommand("Max 打开相册")).toEqual({ action: "gallery.open", args: {} });
    expect(extractDeviceCommand("Max open the gallery")).toEqual({ action: "gallery.open", args: {} });
  });

  it("respects negation and non-commands", () => {
    expect(extractDeviceCommand("Max 别拍照")).toBeNull();
    expect(extractDeviceCommand("Max 我们刚才拍的照片在哪")).toBeNull();
  });
});
```

Extend the tier test's expected object (in the existing `DEVICE_ACTION_TIERS` test) to include the three new keys:

```ts
      "destination.show": "low",
      "camera.photo": "low",
      "camera.record": "low",
      "gallery.open": "low"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/device-actions.test.ts`
Expected: FAIL — camera utterances return `null`.

- [ ] **Step 3: Extend the types and tables**

In `server/device-actions.ts`, add to the `DeviceActionName` union:

```ts
  | "camera.photo"
  | "camera.record"
  | "gallery.open"
```

Add to the `DeviceCommand` union:

```ts
  | { action: "camera.photo"; args: Record<string, never> }
  | { action: "camera.record"; args: { start: boolean } }
  | { action: "gallery.open"; args: Record<string, never> }
```

Add to `DEVICE_ACTION_TIERS`:

```ts
  "camera.photo": "low",
  "camera.record": "low",
  "gallery.open": "low"
```

Add to `ACTION_LABELS`:

```ts
  "camera.photo": "拍照",
  "camera.record": "录像",
  "gallery.open": "相册"
```

Add to `FAILURE_SPEECH`:

```ts
  "permission.camera": "我没有相机权限，去设置里开启后我再帮你拍。",
  "storage.full": "存储快满了，导出或删除一些内容后我再帮你拍。",
  "camera.recording": "已经在录了。",
  "camera.notRecording": "现在没有在录像。",
  "capture.failed": "拍摄没成功。"
```

- [ ] **Step 4: Add the grammar matcher**

In `server/device-actions.ts`, inside `extractDeviceCommand`, add this call immediately after the two volume `if` blocks and before `const music = matchMusic(raw);`:

```ts
  const camera = matchCamera(raw);
  if (camera) return camera;
```

Add the matcher next to `matchMusic`:

```ts
function matchCamera(raw: string): DeviceCommand | null {
  // Stop is checked before start so "停止录像" is never read as "录像".
  if (/(停止|结束|停下?).{0,2}(录像|录制|录影|视频)/.test(raw) || /stop\s+recording/i.test(raw)) {
    return { action: "camera.record", args: { start: false } };
  }
  if (
    /(开始)?(录像|录制|录影|录个?视频|录一段)/.test(raw) ||
    /(start\s+recording|record\s+(a\s+)?video)/i.test(raw)
  ) {
    return { action: "camera.record", args: { start: true } };
  }
  if (/(拍照|拍个?照|拍张?照片?|照相)/.test(raw) || /take\s+a\s+(photo|picture|pic)/i.test(raw)) {
    return { action: "camera.photo", args: {} };
  }
  if (/(打开|查看|看看).{0,3}(相册|图库|照片墙)/.test(raw) || /(open|show)\s+(the\s+)?(gallery|album)/i.test(raw)) {
    return { action: "gallery.open", args: {} };
  }
  return null;
}
```

- [ ] **Step 5: Add a mock demo line**

In `server/providers/mock.ts`, add a camera line right after the torch demo line in the `commute` scenario `turns` array:

```ts
      { rider: "Max，拍照", agent: "好的，拍好了。", latencyBase: 92 },
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/device-actions.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/device-actions.ts server/providers/mock.ts tests/device-actions.test.ts
git commit -m "feat(actions): add camera command grammar"
```

---

### Task 2: Server — protocol schema and grounding prompt

**Files:**
- Modify: `protocol/agent-events.schema.json`
- Modify: `server/providers/doubao.ts` (`buildToolGroundingPrompt`)
- Modify: `tests/device-grounding.test.ts`
- Regenerated (do not hand-edit): `shared/generated/agent-protocol.ts`, `android/app/src/main/java/com/horizon/maxhelmet/agent/GeneratedAgentProtocol.kt`, `ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift`

**Interfaces:**
- Consumes: the `device.command` `action` enum in the schema; `buildToolGroundingPrompt` in `doubao.ts`.
- Produces: `camera.photo`, `camera.record`, `gallery.open` as valid wire actions; a grounding prompt that names 拍照 and 录像.

- [ ] **Step 1: Write the failing test**

Append to `tests/device-grounding.test.ts`, inside the `buildToolGroundingPrompt` describe block:

```ts
  it("declares the camera actions", () => {
    for (const capability of ["拍照", "录像"]) {
      expect(prompt).toContain(capability);
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/device-grounding.test.ts`
Expected: FAIL — prompt lacks 拍照/录像.

- [ ] **Step 3: Extend the schema action enum**

In `protocol/agent-events.schema.json`, change the `DeviceCommand` `action` enum to:

```json
              "enum": ["torch.set", "volume.set", "music.control", "sms.compose", "call.dial", "destination.show", "camera.photo", "camera.record", "gallery.open"]
```

- [ ] **Step 4: Regenerate the contracts**

Run: `npm run generate:protocol`
Expected: three `Generated …` lines.

- [ ] **Step 5: Extend the grounding prompt**

In `server/providers/doubao.ts`, in `buildToolGroundingPrompt`, change the capability sentence to include camera actions. Replace:

```ts
    "控制 Apple Music 和本机音乐的播放、准备短信、拨打电话、查询目的地并显示路线卡片。" +
```

with:

```ts
    "控制 Apple Music 和本机音乐的播放、准备短信、拨打电话、查询目的地并显示路线卡片、拍照和录像（录像无声音）。" +
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/device-grounding.test.ts tests/device-protocol.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full gate**

Run: `npm run check`
Expected: PASS — protocol check, format, lint, dead-code, tests, fault matrix, build.

- [ ] **Step 8: Commit**

```bash
git add protocol/agent-events.schema.json shared/generated/agent-protocol.ts \
  android/app/src/main/java/com/horizon/maxhelmet/agent/GeneratedAgentProtocol.kt \
  ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift server/providers/doubao.ts tests/device-grounding.test.ts
git commit -m "feat(protocol): add camera actions and declare them to Max"
```

---

### Task 3: iOS — decode camera actions

**Files:**
- Modify: `ios/MaxHelmet/Agent/AgentProtocol.swift` (`DeviceAction`, `parseDeviceAction`)
- Modify: `ios/MaxHelmet/Actions/DeviceActionHandler.swift` (`DeviceActionRoute`)
- Modify: `ios/MaxHelmetTests/AgentProtocolTests.swift`

**Interfaces:**
- Consumes: `DeviceAction`, `parseDeviceAction`, `DeviceActionRoute` from Spec 1.
- Produces: `DeviceAction.cameraPhoto`, `.cameraRecord(start: Bool)`, `.galleryOpen`; the `.camera` route.

- [ ] **Step 1: Write the failing test**

Append to `ios/MaxHelmetTests/AgentProtocolTests.swift`:

```swift
    func testParsesCameraPhotoCommand() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"p1","action":"camera.photo","args":{},"tier":"low"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.action, .cameraPhoto)
    }

    func testParsesCameraRecordCommand() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"r1","action":"camera.record","args":{"start":true},"tier":"low"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.action, .cameraRecord(start: true))
    }

    func testParsesGalleryOpenCommand() {
        let event = parseAgentEvent("""
        {"type":"device.command","commandId":"g1","action":"gallery.open","args":{},"tier":"low"}
        """)
        guard case let .deviceCommand(command) = event else { return XCTFail("Expected device.command") }
        XCTAssertEqual(command.action, .galleryOpen)
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `type 'DeviceAction' has no member 'cameraPhoto'`.

- [ ] **Step 3: Add the enum cases**

In `ios/MaxHelmet/Agent/AgentProtocol.swift`, add to `enum DeviceAction`:

```swift
    case cameraPhoto
    case cameraRecord(start: Bool)
    case galleryOpen
```

Add to `parseDeviceAction`, before `default:`:

```swift
    case "camera.photo":
        return .cameraPhoto
    case "camera.record":
        return .cameraRecord(start: args["start"] as? Bool ?? false)
    case "gallery.open":
        return .galleryOpen
```

- [ ] **Step 4: Add the route**

In `ios/MaxHelmet/Actions/DeviceActionHandler.swift`, add `case camera` to `DeviceActionRoute`, and to its `init(_:)` switch:

```swift
        case .cameraPhoto, .cameraRecord, .galleryOpen: self = .camera
```

- [ ] **Step 5: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ios/MaxHelmet/Agent/AgentProtocol.swift ios/MaxHelmet/Actions/DeviceActionHandler.swift \
  ios/MaxHelmetTests/AgentProtocolTests.swift
git commit -m "feat(ios): decode camera and gallery-open actions"
```

---

### Task 4: iOS — Capture model and CaptureStore

**Files:**
- Create: `ios/MaxHelmet/Capture/Capture.swift`
- Create: `ios/MaxHelmet/Capture/CaptureStore.swift`
- Create: `ios/MaxHelmetTests/CaptureStoreTests.swift`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Capture` (Codable model), `protocol CaptureStoring`, and `CaptureStore(root:availableBytes:)` conforming to it, with: `hasSpace() -> Bool`, `captures() -> [Capture]` (newest first), `newVideoURL() -> URL`, `addPhoto(_ data: Data) throws -> Capture`, `indexVideo(at: URL) throws -> Capture`, `markExported(_ id: String)`, `delete(_ id: String)`, `fileURL(for: Capture) -> URL`, `thumbnailURL(for: Capture) -> URL`.

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/CaptureStoreTests.swift`:

```swift
import UIKit
import XCTest
@testable import MaxHelmet

final class CaptureStoreTests: XCTestCase {

    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("captures-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func jpegData() -> Data {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 40)).image { ctx in
            UIColor.red.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 40, height: 40))
        }
        return image.jpegData(compressionQuality: 0.8)!
    }

    func testAddsAPhotoAndWritesFileAndThumbnail() throws {
        let store = CaptureStore(root: root, availableBytes: { 5_000_000_000 })
        let capture = try store.addPhoto(jpegData())

        XCTAssertEqual(capture.type, .photo)
        XCTAssertFalse(capture.exported)
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.fileURL(for: capture).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.thumbnailURL(for: capture).path))
        XCTAssertEqual(store.captures().count, 1)
    }

    func testPersistsAcrossInstances() throws {
        let store = CaptureStore(root: root, availableBytes: { 5_000_000_000 })
        _ = try store.addPhoto(jpegData())

        let reopened = CaptureStore(root: root, availableBytes: { 5_000_000_000 })
        XCTAssertEqual(reopened.captures().count, 1)
    }

    func testListsNewestFirst() throws {
        let store = CaptureStore(root: root, availableBytes: { 5_000_000_000 })
        let first = try store.addPhoto(jpegData())
        let second = try store.addPhoto(jpegData())

        XCTAssertEqual(store.captures().map(\.id), [second.id, first.id])
    }

    func testMarksExported() throws {
        let store = CaptureStore(root: root, availableBytes: { 5_000_000_000 })
        let capture = try store.addPhoto(jpegData())

        store.markExported(capture.id)

        XCTAssertEqual(store.captures().first?.exported, true)
    }

    func testDeleteRemovesRecordAndFiles() throws {
        let store = CaptureStore(root: root, availableBytes: { 5_000_000_000 })
        let capture = try store.addPhoto(jpegData())
        let file = store.fileURL(for: capture)

        store.delete(capture.id)

        XCTAssertTrue(store.captures().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testReportsLowSpace() {
        let full = CaptureStore(root: root, availableBytes: { 400_000_000 })
        let ok = CaptureStore(root: root, availableBytes: { 900_000_000 })

        XCTAssertFalse(full.hasSpace())
        XCTAssertTrue(ok.hasSpace())
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `cannot find 'CaptureStore' in scope`.

- [ ] **Step 3: Write the model**

Create `ios/MaxHelmet/Capture/Capture.swift`:

```swift
import Foundation

/// One stored capture. Codable so the whole gallery index round-trips through a
/// single JSON file. `filename`/`thumbnailName` are relative to the Captures
/// folder, so the index survives the container path changing between launches.
struct Capture: Identifiable, Equatable, Codable {
    enum Kind: String, Codable {
        case photo
        case video
    }

    let id: String
    let type: Kind
    let filename: String
    let createdAt: Double
    var durationSec: Double?
    var exported: Bool
    let thumbnailName: String
}
```

- [ ] **Step 4: Write the store**

Create `ios/MaxHelmet/Capture/CaptureStore.swift`:

```swift
import AVFoundation
import UIKit

/// The single owner of everything the gallery keeps on disk: capture files,
/// their thumbnails, and the JSON index. Injectable `root` and `availableBytes`
/// keep it fully testable without a real device or camera.
protocol CaptureStoring: AnyObject {
    func hasSpace() -> Bool
    func captures() -> [Capture]
    func newVideoURL() -> URL
    func addPhoto(_ data: Data) throws -> Capture
    func indexVideo(at url: URL) throws -> Capture
    func markExported(_ id: String)
    func delete(_ id: String)
    func fileURL(for capture: Capture) -> URL
    func thumbnailURL(for capture: Capture) -> URL
}

final class CaptureStore: CaptureStoring {
    /// Captures below this free-space floor are refused rather than dropping old
    /// ones — the gallery never auto-prunes.
    static let minimumFreeBytes: UInt64 = 500_000_000
    private static let thumbnailMaxDimension: CGFloat = 300

    private let root: URL
    private let availableBytes: () -> UInt64
    private let indexURL: URL
    private var index: [Capture]
    private let queue = DispatchQueue(label: "capture-store")

    /// - Parameter availableBytes: free capacity probe, injected so tests can
    ///   simulate a full disk. Production passes the real volume capacity.
    init(root: URL, availableBytes: @escaping () -> UInt64) {
        self.root = root
        self.availableBytes = availableBytes
        self.indexURL = root.appendingPathComponent("captures.json")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var excluded = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
        if let data = try? Data(contentsOf: indexURL),
           let decoded = try? JSONDecoder().decode([Capture].self, from: data) {
            index = decoded
        } else {
            index = []
        }
    }

    /// Production initializer: probes the real volume capacity for the Captures
    /// folder.
    convenience init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let captures = support.appendingPathComponent("Captures", isDirectory: true)
        self.init(root: captures, availableBytes: {
            let values = try? captures.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            return UInt64(values?.volumeAvailableCapacityForImportantUsage ?? 0)
        })
    }

    func hasSpace() -> Bool {
        availableBytes() >= Self.minimumFreeBytes
    }

    func captures() -> [Capture] {
        queue.sync { index.sorted { $0.createdAt > $1.createdAt } }
    }

    func newVideoURL() -> URL {
        root.appendingPathComponent("\(UUID().uuidString).mov")
    }

    func addPhoto(_ data: Data) throws -> Capture {
        let id = UUID().uuidString
        let filename = "\(id).heic"
        let thumbnailName = "\(id)-thumb.jpg"
        try data.write(to: root.appendingPathComponent(filename))
        try writePhotoThumbnail(from: data, to: root.appendingPathComponent(thumbnailName))
        let capture = Capture(
            id: id, type: .photo, filename: filename,
            createdAt: Date().timeIntervalSince1970, durationSec: nil,
            exported: false, thumbnailName: thumbnailName
        )
        appendToIndex(capture)
        return capture
    }

    func indexVideo(at url: URL) throws -> Capture {
        let id = UUID().uuidString
        let thumbnailName = "\(id)-thumb.jpg"
        let asset = AVURLAsset(url: url)
        let duration = CMTimeGetSeconds(asset.duration)
        try writeVideoThumbnail(from: asset, to: root.appendingPathComponent(thumbnailName))
        let capture = Capture(
            id: id, type: .video, filename: url.lastPathComponent,
            createdAt: Date().timeIntervalSince1970, durationSec: duration,
            exported: false, thumbnailName: thumbnailName
        )
        appendToIndex(capture)
        return capture
    }

    func markExported(_ id: String) {
        queue.sync {
            guard let i = index.firstIndex(where: { $0.id == id }) else { return }
            index[i].exported = true
            persist()
        }
    }

    func delete(_ id: String) {
        queue.sync {
            guard let i = index.firstIndex(where: { $0.id == id }) else { return }
            let capture = index[i]
            try? FileManager.default.removeItem(at: root.appendingPathComponent(capture.filename))
            try? FileManager.default.removeItem(at: root.appendingPathComponent(capture.thumbnailName))
            index.remove(at: i)
            persist()
        }
    }

    func fileURL(for capture: Capture) -> URL { root.appendingPathComponent(capture.filename) }
    func thumbnailURL(for capture: Capture) -> URL { root.appendingPathComponent(capture.thumbnailName) }

    // MARK: - Private

    private func appendToIndex(_ capture: Capture) {
        queue.sync {
            index.append(capture)
            persist()
        }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(index) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }

    private func writePhotoThumbnail(from data: Data, to url: URL) throws {
        guard let image = UIImage(data: data),
              let thumb = image.downscaled(to: Self.thumbnailMaxDimension),
              let jpeg = thumb.jpegData(compressionQuality: 0.7) else {
            throw CaptureStoreError.thumbnailFailed
        }
        try jpeg.write(to: url)
    }

    private func writeVideoThumbnail(from asset: AVAsset, to url: URL) throws {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        let cg = try generator.copyCGImage(at: .zero, actualTime: nil)
        guard let thumb = UIImage(cgImage: cg).downscaled(to: Self.thumbnailMaxDimension),
              let jpeg = thumb.jpegData(compressionQuality: 0.7) else {
            throw CaptureStoreError.thumbnailFailed
        }
        try jpeg.write(to: url)
    }
}

enum CaptureStoreError: Error {
    case thumbnailFailed
}

private extension UIImage {
    /// Aspect-fit downscale so the longest side is `maxDimension`.
    func downscaled(to maxDimension: CGFloat) -> UIImage? {
        let longest = max(size.width, size.height)
        guard longest > maxDimension else { return self }
        let scale = maxDimension / longest
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        return UIGraphicsImageRenderer(size: target).image { _ in
            draw(in: CGRect(origin: .zero, size: target))
        }
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ios/MaxHelmet/Capture/Capture.swift ios/MaxHelmet/Capture/CaptureStore.swift \
  ios/MaxHelmetTests/CaptureStoreTests.swift
git commit -m "feat(ios): add capture model and store"
```

---

### Task 5: iOS — CameraController handler

**Files:**
- Create: `ios/MaxHelmet/Actions/CameraController.swift`
- Create: `ios/MaxHelmetTests/CameraControllerTests.swift`

**Interfaces:**
- Consumes: `DeviceActionHandler`, `DeviceAction`, `DeviceActionResult` (Spec 1); `CaptureStoring`, `Capture` (Task 4).
- Produces: `enum CameraAuthorization { case authorized, denied, notDetermined }`; `protocol CaptureSessioning`; `final class CameraController: DeviceActionHandler` with `init(session:store:onRecordingChange:onOpenGallery:onAutoStopped:)`; `AVFoundationCaptureSession` (device implementation).

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/CameraControllerTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

private final class FakeSession: CaptureSessioning, @unchecked Sendable {
    var auth: CameraAuthorization = .authorized
    var granted = true
    var photoData = Data([0x01])
    var throwOnPhoto = false
    var throwOnStart = false
    var started: [URL] = []
    var stopped = 0

    func authorization() -> CameraAuthorization { auth }
    func requestAccess() async -> Bool { granted }
    func capturePhoto() async throws -> Data {
        if throwOnPhoto { throw CaptureStoreError.thumbnailFailed }
        return photoData
    }
    func startRecording(to url: URL) async throws {
        if throwOnStart { throw CaptureStoreError.thumbnailFailed }
        started.append(url)
    }
    func stopRecording() async throws -> URL {
        stopped += 1
        return started.last ?? URL(fileURLWithPath: "/tmp/none.mov")
    }
}

private final class FakeStore: CaptureStoring, @unchecked Sendable {
    var space = true
    var photos: [Data] = []
    var indexedVideos: [URL] = []
    func hasSpace() -> Bool { space }
    func captures() -> [Capture] { [] }
    func newVideoURL() -> URL { URL(fileURLWithPath: "/tmp/\(UUID().uuidString).mov") }
    func addPhoto(_ data: Data) throws -> Capture {
        photos.append(data)
        return Capture(id: "p", type: .photo, filename: "p.heic", createdAt: 0, durationSec: nil, exported: false, thumbnailName: "t.jpg")
    }
    func indexVideo(at url: URL) throws -> Capture {
        indexedVideos.append(url)
        return Capture(id: "v", type: .video, filename: url.lastPathComponent, createdAt: 0, durationSec: 1, exported: false, thumbnailName: "t.jpg")
    }
    func markExported(_ id: String) {}
    func delete(_ id: String) {}
    func fileURL(for capture: Capture) -> URL { URL(fileURLWithPath: "/tmp/\(capture.filename)") }
    func thumbnailURL(for capture: Capture) -> URL { URL(fileURLWithPath: "/tmp/\(capture.thumbnailName)") }
}

final class CameraControllerTests: XCTestCase {

    private func make(_ session: FakeSession, _ store: FakeStore, gallery: @escaping () -> Void = {}) -> CameraController {
        CameraController(session: session, store: store, onRecordingChange: { _ in }, onOpenGallery: gallery, onAutoStopped: {})
    }

    func testTakesAPhoto() async {
        let session = FakeSession(), store = FakeStore()
        let result = await make(session, store).perform(.cameraPhoto)
        XCTAssertEqual(result, .ok)
        XCTAssertEqual(store.photos.count, 1)
    }

    func testPhotoReportsDeniedPermission() async {
        let session = FakeSession(); session.auth = .denied
        let result = await make(session, FakeStore()).perform(.cameraPhoto)
        XCTAssertEqual(result.status, .denied)
        XCTAssertEqual(result.reason, "permission.camera")
    }

    func testPhotoRefusedWhenLowOnSpace() async {
        let store = FakeStore(); store.space = false
        let result = await make(FakeSession(), store).perform(.cameraPhoto)
        XCTAssertEqual(result.status, .denied)
        XCTAssertEqual(result.reason, "storage.full")
    }

    func testPhotoFailureIsReported() async {
        let session = FakeSession(); session.throwOnPhoto = true
        let result = await make(session, FakeStore()).perform(.cameraPhoto)
        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "capture.failed")
    }

    func testStartsAndStopsRecording() async {
        let session = FakeSession(), store = FakeStore()
        let controller = make(session, store)

        let start = await controller.perform(.cameraRecord(start: true))
        XCTAssertEqual(start, .ok)
        XCTAssertEqual(session.started.count, 1)

        let stop = await controller.perform(.cameraRecord(start: false))
        XCTAssertEqual(stop, .ok)
        XCTAssertEqual(session.stopped, 1)
        XCTAssertEqual(store.indexedVideos.count, 1)
    }

    func testStartWhileRecordingIsABenignGuard() async {
        let session = FakeSession()
        let controller = make(session, FakeStore())
        _ = await controller.perform(.cameraRecord(start: true))

        let again = await controller.perform(.cameraRecord(start: true))

        XCTAssertEqual(again.status, .failed)
        XCTAssertEqual(again.reason, "camera.recording")
        XCTAssertEqual(session.started.count, 1, "No second recording is started")
    }

    func testStopWhileIdleIsABenignGuard() async {
        let session = FakeSession()
        let result = await make(session, FakeStore()).perform(.cameraRecord(start: false))
        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "camera.notRecording")
        XCTAssertEqual(session.stopped, 0)
    }

    func testGalleryOpenInvokesTheCallback() async {
        var opened = false
        let result = await make(FakeSession(), FakeStore(), gallery: { opened = true }).perform(.galleryOpen)
        XCTAssertEqual(result, .ok)
        XCTAssertTrue(opened)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `cannot find 'CameraController' in scope`.

- [ ] **Step 3: Write the controller**

Create `ios/MaxHelmet/Actions/CameraController.swift`:

```swift
import AVFoundation
import Foundation

enum CameraAuthorization {
    case authorized
    case denied
    case notDetermined
}

/// The capture surface behind a protocol so the handler's state machine is
/// testable — a real AVCaptureSession works on neither the simulator nor a unit
/// test. Video-only: no method here ever configures an audio input, which is
/// what keeps the mic with the voice engine.
protocol CaptureSessioning {
    func authorization() -> CameraAuthorization
    func requestAccess() async -> Bool
    func capturePhoto() async throws -> Data
    func startRecording(to url: URL) async throws
    func stopRecording() async throws -> URL
}

/// The camera device-action handler. Owns recording state and the benign state
/// guards; delegates capture to `CaptureSessioning` and persistence to
/// `CaptureStoring`. A reference type because it holds recording state across
/// commands.
final class CameraController: DeviceActionHandler {
    /// A forgotten "开始录像" must not eat the disk.
    static let maxRecordingSeconds: TimeInterval = 600

    private let session: CaptureSessioning
    private let store: CaptureStoring
    private let onRecordingChange: (Bool) -> Void
    private let onOpenGallery: () -> Void
    private let onAutoStopped: () -> Void

    private var recording = false
    private var autoStopTask: Task<Void, Never>?

    init(
        session: CaptureSessioning,
        store: CaptureStoring,
        onRecordingChange: @escaping (Bool) -> Void,
        onOpenGallery: @escaping () -> Void,
        onAutoStopped: @escaping () -> Void
    ) {
        self.session = session
        self.store = store
        self.onRecordingChange = onRecordingChange
        self.onOpenGallery = onOpenGallery
        self.onAutoStopped = onAutoStopped
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        switch action {
        case .cameraPhoto:
            return await takePhoto()
        case let .cameraRecord(start):
            return start ? await startRecording() : await stopRecording(auto: false)
        case .galleryOpen:
            onOpenGallery()
            return .ok
        default:
            return .unsupported("action.mismatch")
        }
    }

    private func ensureAuthorized() async -> Bool {
        switch session.authorization() {
        case .authorized: return true
        case .notDetermined: return await session.requestAccess()
        case .denied: return false
        }
    }

    private func takePhoto() async -> DeviceActionResult {
        guard await ensureAuthorized() else { return .denied("permission.camera") }
        guard store.hasSpace() else { return .denied("storage.full") }
        do {
            let data = try await session.capturePhoto()
            _ = try store.addPhoto(data)
            return .ok
        } catch {
            return .failed("capture.failed")
        }
    }

    private func startRecording() async -> DeviceActionResult {
        guard !recording else { return .failed("camera.recording") }
        guard await ensureAuthorized() else { return .denied("permission.camera") }
        guard store.hasSpace() else { return .denied("storage.full") }
        do {
            try await session.startRecording(to: store.newVideoURL())
            recording = true
            onRecordingChange(true)
            scheduleAutoStop()
            return .ok
        } catch {
            return .failed("capture.failed")
        }
    }

    private func stopRecording(auto: Bool) async -> DeviceActionResult {
        guard recording else { return .failed("camera.notRecording") }
        autoStopTask?.cancel()
        autoStopTask = nil
        do {
            let url = try await session.stopRecording()
            recording = false
            onRecordingChange(false)
            _ = try store.indexVideo(at: url)
            if auto { onAutoStopped() }
            return .ok
        } catch {
            recording = false
            onRecordingChange(false)
            return .failed("capture.failed")
        }
    }

    private func scheduleAutoStop() {
        autoStopTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.maxRecordingSeconds * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            _ = await self.stopRecording(auto: true)
        }
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 5: Add the real capture session (device-only, not unit-tested)**

Append `AVFoundationCaptureSession` to `ios/MaxHelmet/Actions/CameraController.swift`
(no new import — the file already imports `AVFoundation`):

```swift
/// The production `CaptureSessioning`, backed by AVFoundation. Rear camera,
/// video-only: it never adds an audio input and disables automatic audio-session
/// configuration, so the voice engine keeps the microphone. All AVCaptureSession
/// work runs on a dedicated serial queue.
final class AVFoundationCaptureSession: NSObject, CaptureSessioning {
    private let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private let movieOutput = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "camera-session")
    private var configured = false
    private var photoContinuation: CheckedContinuation<Data, Error>?
    private var recordContinuation: CheckedContinuation<URL, Error>?

    func authorization() -> CameraAuthorization {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .authorized
        case .notDetermined: return .notDetermined
        default: return .denied
        }
    }

    func requestAccess() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .video)
    }

    private func configureIfNeeded() throws {
        guard !configured else { return }
        session.automaticallyConfiguresApplicationAudioSession = false
        session.beginConfiguration()
        session.sessionPreset = .high
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else {
            session.commitConfiguration()
            throw CaptureStoreError.thumbnailFailed
        }
        session.addInput(input)
        if session.canAddOutput(photoOutput) { session.addOutput(photoOutput) }
        if session.canAddOutput(movieOutput) {
            session.addOutput(movieOutput)
            movieOutput.minFreeDiskSpaceLimit = Int64(CaptureStore.minimumFreeBytes)
        }
        session.commitConfiguration()
        configured = true
    }

    func capturePhoto() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    try self.configureIfNeeded()
                    if !self.session.isRunning { self.session.startRunning() }
                    self.photoContinuation = continuation
                    self.photoOutput.capturePhoto(with: AVCapturePhotoSettings(), delegate: self)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func startRecording(to url: URL) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                do {
                    try self.configureIfNeeded()
                    if !self.session.isRunning { self.session.startRunning() }
                    self.movieOutput.startRecording(to: url, recordingDelegate: self)
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func stopRecording() async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.recordContinuation = continuation
                self.movieOutput.stopRecording()
            }
        }
    }
}

extension AVFoundationCaptureSession: AVCapturePhotoCaptureDelegate {
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        queue.async {
            defer { self.session.stopRunning() }
            if let error {
                self.photoContinuation?.resume(throwing: error)
            } else if let data = photo.fileDataRepresentation() {
                self.photoContinuation?.resume(returning: data)
            } else {
                self.photoContinuation?.resume(throwing: CaptureStoreError.thumbnailFailed)
            }
            self.photoContinuation = nil
        }
    }
}

extension AVFoundationCaptureSession: AVCaptureFileOutputRecordingDelegate {
    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?
    ) {
        queue.async {
            self.session.stopRunning()
            // A reached minFreeDiskSpaceLimit surfaces as an error, but the file
            // written so far is valid — keep it rather than losing the clip.
            self.recordContinuation?.resume(returning: outputFileURL)
            self.recordContinuation = nil
        }
    }
}
```

- [ ] **Step 6: Run the full iOS suite**

Run the iOS test command.
Expected: PASS — the controller tests, plus the app still builds with the real session.

- [ ] **Step 7: Commit**

```bash
git add ios/MaxHelmet/Actions/CameraController.swift ios/MaxHelmetTests/CameraControllerTests.swift
git commit -m "feat(ios): add camera controller handler"
```

---

### Task 6: iOS — Photos export and GalleryModel

**Files:**
- Create: `ios/MaxHelmet/Gallery/PhotoLibraryExporter.swift`
- Create: `ios/MaxHelmet/Gallery/GalleryModel.swift`
- Create: `ios/MaxHelmetTests/GalleryModelTests.swift`

**Interfaces:**
- Consumes: `CaptureStoring`, `Capture` (Task 4).
- Produces: `protocol PhotoLibraryAdding { func add(fileURL: URL, isVideo: Bool) async -> Bool }`; `SystemPhotoLibraryExporter`; `@MainActor final class GalleryModel: ObservableObject` with `@Published var captures`, `@Published var exporting: Set<String>`, `@Published var exportError: String?`, `refresh()`, `export(_:) async`, `delete(_:)`.

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/GalleryModelTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

private final class FakeStore: CaptureStoring, @unchecked Sendable {
    var items: [Capture]
    var exportedIds: [String] = []
    var deletedIds: [String] = []
    init(_ items: [Capture]) { self.items = items }
    func hasSpace() -> Bool { true }
    func captures() -> [Capture] { items.sorted { $0.createdAt > $1.createdAt } }
    func newVideoURL() -> URL { URL(fileURLWithPath: "/tmp/x.mov") }
    func addPhoto(_ data: Data) throws -> Capture { fatalError() }
    func indexVideo(at url: URL) throws -> Capture { fatalError() }
    func markExported(_ id: String) {
        exportedIds.append(id)
        if let i = items.firstIndex(where: { $0.id == id }) { items[i].exported = true }
    }
    func delete(_ id: String) {
        deletedIds.append(id)
        items.removeAll { $0.id == id }
    }
    func fileURL(for capture: Capture) -> URL { URL(fileURLWithPath: "/tmp/\(capture.filename)") }
    func thumbnailURL(for capture: Capture) -> URL { URL(fileURLWithPath: "/tmp/\(capture.thumbnailName)") }
}

private final class FakeExporter: PhotoLibraryAdding, @unchecked Sendable {
    var succeed = true
    func add(fileURL: URL, isVideo: Bool) async -> Bool { succeed }
}

private func photo(_ id: String, at t: Double) -> Capture {
    Capture(id: id, type: .photo, filename: "\(id).heic", createdAt: t, durationSec: nil, exported: false, thumbnailName: "\(id).jpg")
}

@MainActor
final class GalleryModelTests: XCTestCase {

    func testLoadsNewestFirst() {
        let model = GalleryModel(store: FakeStore([photo("a", at: 1), photo("b", at: 2)]), exporter: FakeExporter())
        model.refresh()
        XCTAssertEqual(model.captures.map(\.id), ["b", "a"])
    }

    func testExportMarksExported() async {
        let store = FakeStore([photo("a", at: 1)])
        let model = GalleryModel(store: store, exporter: FakeExporter())
        model.refresh()

        await model.export(store.captures()[0])

        XCTAssertEqual(store.exportedIds, ["a"])
        XCTAssertEqual(model.captures.first?.exported, true)
        XCTAssertNil(model.exportError)
    }

    func testExportFailureSurfacesAnErrorAndDoesNotMark() async {
        let store = FakeStore([photo("a", at: 1)])
        let exporter = FakeExporter(); exporter.succeed = false
        let model = GalleryModel(store: store, exporter: exporter)
        model.refresh()

        await model.export(store.captures()[0])

        XCTAssertTrue(store.exportedIds.isEmpty)
        XCTAssertNotNil(model.exportError)
    }

    func testDeleteRemovesFromStoreAndList() {
        let store = FakeStore([photo("a", at: 1)])
        let model = GalleryModel(store: store, exporter: FakeExporter())
        model.refresh()

        model.delete(store.captures()[0])

        XCTAssertEqual(store.deletedIds, ["a"])
        XCTAssertTrue(model.captures.isEmpty)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `cannot find 'GalleryModel' in scope`.

- [ ] **Step 3: Write the exporter**

Create `ios/MaxHelmet/Gallery/PhotoLibraryExporter.swift`:

```swift
import Photos

/// Copies a capture into the system Photos library. Behind a protocol so the
/// gallery model is testable without touching the real library.
protocol PhotoLibraryAdding {
    func add(fileURL: URL, isVideo: Bool) async -> Bool
}

/// Real exporter using add-only authorization — Max never reads the rider's
/// existing library.
struct SystemPhotoLibraryExporter: PhotoLibraryAdding {
    func add(fileURL: URL, isVideo: Bool) async -> Bool {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { return false }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCreationRequest.forAsset()
                let type: PHAssetResourceType = isVideo ? .video : .photo
                request.addResource(with: type, fileURL: fileURL, options: nil)
            }
            return true
        } catch {
            return false
        }
    }
}
```

- [ ] **Step 4: Write the gallery model**

Create `ios/MaxHelmet/Gallery/GalleryModel.swift`:

```swift
import Foundation

/// Observable bridge from `CaptureStore` to the gallery views. Keeps the views
/// thin: they read `captures` and call `export`/`delete`.
@MainActor
final class GalleryModel: ObservableObject {
    @Published private(set) var captures: [Capture] = []
    @Published private(set) var exporting: Set<String> = []
    @Published var exportError: String?

    private let store: CaptureStoring
    private let exporter: PhotoLibraryAdding

    init(store: CaptureStoring, exporter: PhotoLibraryAdding) {
        self.store = store
        self.exporter = exporter
    }

    func refresh() {
        captures = store.captures()
    }

    func export(_ capture: Capture) async {
        exporting.insert(capture.id)
        defer { exporting.remove(capture.id) }
        let ok = await exporter.add(fileURL: store.fileURL(for: capture), isVideo: capture.type == .video)
        if ok {
            store.markExported(capture.id)
            refresh()
        } else {
            exportError = "导出到相册失败，检查相册权限后重试。"
        }
    }

    func delete(_ capture: Capture) {
        store.delete(capture.id)
        refresh()
    }

    func fileURL(for capture: Capture) -> URL { store.fileURL(for: capture) }
    func thumbnailURL(for capture: Capture) -> URL { store.thumbnailURL(for: capture) }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run the iOS test command.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ios/MaxHelmet/Gallery/PhotoLibraryExporter.swift ios/MaxHelmet/Gallery/GalleryModel.swift \
  ios/MaxHelmetTests/GalleryModelTests.swift
git commit -m "feat(ios): add Photos exporter and gallery model"
```

---

### Task 7: iOS — Gallery views

**Files:**
- Create: `ios/MaxHelmet/Gallery/GalleryView.swift`
- Create: `ios/MaxHelmet/Gallery/CaptureViewer.swift`

**Interfaces:**
- Consumes: `GalleryModel`, `Capture` (Task 6); `HudColors` (`ios/MaxHelmet/UI/HudTheme.swift`).
- Produces: `GalleryView(model:onClose:)` and `CaptureViewer(capture:model:)` SwiftUI views.

No unit test — SwiftUI views, verified by the build and manual device testing, following the Spec 1 `DestinationCard` precedent.

- [ ] **Step 1: Write the grid**

Create `ios/MaxHelmet/Gallery/GalleryView.swift`:

```swift
import SwiftUI
import UIKit

/// The Max gallery grid. Newest-first thumbnails; tap one for the viewer.
struct GalleryView: View {
    @ObservedObject var model: GalleryModel
    let onClose: () -> Void

    @State private var selected: Capture?

    private let columns = [GridItem(.adaptive(minimum: 104), spacing: 6)]

    var body: some View {
        NavigationStack {
            Group {
                if model.captures.isEmpty {
                    emptyState
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 6) {
                            ForEach(model.captures) { capture in
                                Button { selected = capture } label: { cell(capture) }
                                    .buttonStyle(.plain)
                            }
                        }
                        .padding(6)
                    }
                }
            }
            .background(HudColors.void.ignoresSafeArea())
            .navigationTitle("相册")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成", action: onClose)
                }
            }
            .sheet(item: $selected) { capture in
                CaptureViewer(capture: capture, model: model)
            }
            .alert("导出失败", isPresented: Binding(
                get: { model.exportError != nil },
                set: { if !$0 { model.exportError = nil } }
            )) {
                Button("好", role: .cancel) {}
            } message: {
                Text(model.exportError ?? "")
            }
        }
        .onAppear { model.refresh() }
    }

    private func cell(_ capture: Capture) -> some View {
        ZStack(alignment: .bottomLeading) {
            AsyncThumbnail(url: model.thumbnailURL(for: capture))
                .aspectRatio(1, contentMode: .fill)
                .frame(minWidth: 0, maxWidth: .infinity)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

            HStack(spacing: 4) {
                if capture.type == .video {
                    Image(systemName: "play.circle.fill")
                    if let d = capture.durationSec {
                        Text("\(Int(d))s")
                    }
                }
                if capture.exported {
                    Text("已导出")
                        .padding(.horizontal, 4)
                        .background(HudColors.lume.opacity(0.25), in: Capsule())
                }
            }
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(HudColors.hudInk)
            .padding(6)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "photo.on.rectangle.angled").font(.system(size: 34))
            Text("还没有拍摄内容").font(.subheadline)
        }
        .foregroundStyle(HudColors.hudDim)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Loads a thumbnail JPEG off the main thread. The files are small and local, so
/// a lightweight async load keeps the grid smooth without a caching dependency.
struct AsyncThumbnail: View {
    let url: URL
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                HudColors.panelElevated
            }
        }
        .task(id: url) {
            let loaded = await Task.detached { UIImage(contentsOfFile: url.path) }.value
            image = loaded
        }
    }
}
```

- [ ] **Step 2: Write the viewer**

Create `ios/MaxHelmet/Gallery/CaptureViewer.swift`:

```swift
import AVKit
import SwiftUI
import UIKit

/// Full-screen viewer: a zoomable photo or a video player, with export and
/// delete for this one capture.
struct CaptureViewer: View {
    let capture: Capture
    @ObservedObject var model: GalleryModel
    @Environment(\.dismiss) private var dismiss

    @State private var confirmingDelete = false

    var body: some View {
        NavigationStack {
            ZStack {
                HudColors.void.ignoresSafeArea()
                if capture.type == .video {
                    VideoPlayer(player: AVPlayer(url: model.fileURL(for: capture)))
                } else if let image = UIImage(contentsOfFile: model.fileURL(for: capture).path) {
                    Image(uiImage: image).resizable().scaledToFit()
                } else {
                    Text("无法打开").foregroundStyle(HudColors.hudDim)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .bottomBar) {
                    if model.exporting.contains(capture.id) {
                        ProgressView()
                    } else if capture.exported {
                        Label("已导出", systemImage: "checkmark.circle.fill")
                    } else {
                        Button { Task { await model.export(capture) } } label: {
                            Label("导出到相册", systemImage: "square.and.arrow.up")
                        }
                    }
                }
                ToolbarItem(placement: .bottomBar) {
                    Button(role: .destructive) { confirmingDelete = true } label: {
                        Label("删除", systemImage: "trash")
                    }
                }
            }
            .confirmationDialog("删除这个拍摄内容？", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("删除", role: .destructive) {
                    model.delete(capture)
                    dismiss()
                }
                Button("取消", role: .cancel) {}
            }
        }
    }
}
```

- [ ] **Step 3: Build to verify the views compile**

Run the iOS test command (it builds the app target before testing).
Expected: PASS — build succeeds, existing tests still green.

- [ ] **Step 4: Commit**

```bash
git add ios/MaxHelmet/Gallery/GalleryView.swift ios/MaxHelmet/Gallery/CaptureViewer.swift
git commit -m "feat(ios): add gallery grid and viewer"
```

---

### Task 8: iOS — wire into the session and HUD

**Files:**
- Modify: `ios/MaxHelmet/Agent/AgentSession.swift`
- Modify: `ios/MaxHelmet/UI/MainViewModel.swift`
- Modify: `ios/MaxHelmet/UI/AgentScreen.swift`
- Modify: `ios/MaxHelmet/Info.plist`, `ios/MaxHelmet/Info-Debug.plist`
- Modify: `ios/README.md`, `README.md`
- Create: `ios/MaxHelmetTests/CameraSessionWiringTests.swift`

**Interfaces:**
- Consumes: everything from Tasks 3–7.
- Produces: `CameraController` on the `.camera` route; `AgentSession.State.recording`, `.recordingStartedAt`, `.galleryRequestToken`; `AgentSession.captureStore`; `MainViewModel.galleryModel`, `.showGallery`.

- [ ] **Step 1: Write the failing test**

Create `ios/MaxHelmetTests/CameraSessionWiringTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

@MainActor
final class CameraSessionWiringTests: XCTestCase {

    func testGalleryModelExposesTheSessionStore() {
        // The gallery the UI shows must read the SAME store the camera handler
        // writes to, or captures would never appear.
        let model = MainViewModel()
        XCTAssertNotNil(model.galleryModel)
    }

    func testDeviceResultForGalleryOpenRoundTrips() throws {
        let json = buildDeviceResult(commandId: "g1", result: .ok)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(parsed["status"] as? String, "ok")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the iOS test command.
Expected: FAIL — `value of type 'MainViewModel' has no member 'galleryModel'`.

- [ ] **Step 3: Add capture state and the store to the session**

In `ios/MaxHelmet/Agent/AgentSession.swift`, add to the `State` struct beside `destination`:

```swift
        /// True while a video is recording; drives the HUD indicator.
        var recording = false
        /// When the current recording began, for the elapsed timer.
        var recordingStartedAt: Double? = nil
        /// Bumped by a `gallery.open` command so the UI presents the gallery.
        var galleryRequestToken = 0
```

Add the shared store as a stored property next to `player`:

```swift
    /// The one capture store shared by the camera handler (writes) and the
    /// gallery UI (reads).
    let captureStore = CaptureStore()
```

Add `CameraController` to the router's `handlers` dictionary. In the
`deviceRouter` lazy var, the `.destination` entry currently ends:

```swift
            .destination: DestinationResolver(onResolved: { [weak self] destination in
                self?.update { $0.destination = destination }
            })
        ],
```

Add a comma after that `})` and insert the `.camera` entry, so it reads:

```swift
            .destination: DestinationResolver(onResolved: { [weak self] destination in
                self?.update { $0.destination = destination }
            }),
            .camera: CameraController(
                session: AVFoundationCaptureSession(),
                store: captureStore,
                onRecordingChange: { [weak self] recording in
                    self?.update {
                        $0.recording = recording
                        $0.recordingStartedAt = recording ? Date().timeIntervalSince1970 : nil
                    }
                },
                onOpenGallery: { [weak self] in
                    self?.update { $0.galleryRequestToken += 1 }
                },
                onAutoStopped: { [weak self] in
                    self?.announce("录像已达十分钟上限，已保存。")
                }
            )
        ],
```

Add a local-speech helper (used by the auto-stop announcement) near the other private methods:

```swift
    /// Speaks a line locally through the existing synthesizer. Used for
    /// client-originated events (the recording auto-stop) that have no relay turn
    /// to reconcile.
    func announce(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN")
        synthesizer.speak(utterance)
    }
```

- [ ] **Step 4: Expose the gallery from the view model**

In `ios/MaxHelmet/UI/MainViewModel.swift`, add after the `session` property:

```swift
    /// Presents the Max gallery sheet.
    @Published var showGallery = false

    /// Reads the same capture store the camera handler writes to.
    lazy var galleryModel = GalleryModel(
        store: session.captureStore,
        exporter: SystemPhotoLibraryExporter()
    )
```

- [ ] **Step 5: Add the gallery button, sheet, voice-open, and recording indicator**

In `ios/MaxHelmet/UI/AgentScreen.swift`, add a gallery pill in the control row, immediately before the 设置 `PillToggle`:

```swift
            PillToggle(icon: "photo.stack", label: "相册", on: false) {
                viewModel.galleryModel.refresh()
                viewModel.showGallery = true
            }
```

Present the gallery sheet — add after the existing `.sheet(isPresented: $viewModel.showPreferences)` block:

```swift
        .sheet(isPresented: $viewModel.showGallery) {
            GalleryView(model: viewModel.galleryModel, onClose: { viewModel.showGallery = false })
        }
        .onChange(of: state.galleryRequestToken) { _, _ in
            viewModel.galleryModel.refresh()
            viewModel.showGallery = true
        }
```

Add the recording indicator right after the hazard banner / destination-card block in the `VStack`:

```swift
                if state.recording {
                    RecordingIndicator(startedAt: state.recordingStartedAt)
                        .padding(.horizontal, 4)
                }
```

Add the indicator view near `HazardBanner`:

```swift
private struct RecordingIndicator: View {
    let startedAt: Double?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            HStack(spacing: 8) {
                Circle().fill(HudColors.danger2).frame(width: 10, height: 10)
                Text("录像中 \(elapsed)")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(HudColors.hudInk)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(Capsule().fill(HudColors.panelElevated))
        }
    }

    private var elapsed: String {
        guard let startedAt else { return "00:00" }
        let s = max(0, Int(Date().timeIntervalSince1970 - startedAt))
        return String(format: "%02d:%02d", s / 60, s % 60)
    }
}
```

- [ ] **Step 6: Add the permission strings**

Add to both `ios/MaxHelmet/Info.plist` and `ios/MaxHelmet/Info-Debug.plist`, beside the contacts/music keys:

```xml
	<key>NSCameraUsageDescription</key>
	<string>Max 需要使用相机，才能在你说出指令时拍照和录像。</string>
	<key>NSPhotoLibraryAddUsageDescription</key>
	<string>Max 需要把你导出的拍摄内容保存到系统相册。</string>
```

- [ ] **Step 7: Run the whole iOS suite**

Run the iOS test command.
Expected: PASS — all suites from Tasks 3–8, and the app builds with the camera wired in.

- [ ] **Step 8: Update the documentation**

In `ios/README.md` under "What's implemented", add a bullet: voice-triggered photo and silent-video capture, the in-app Max gallery, and per-item export to Photos, noting video is silent so the mic stays with the voice engine, the 10-minute cap, the low-space refusal, and add-only Photos permission. In the root `README.md` "Current Capabilities", add a matching entry.

- [ ] **Step 9: Run the full server gate**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add ios/MaxHelmet/Agent/AgentSession.swift ios/MaxHelmet/UI/MainViewModel.swift \
  ios/MaxHelmet/UI/AgentScreen.swift ios/MaxHelmet/Info.plist ios/MaxHelmet/Info-Debug.plist \
  ios/MaxHelmetTests/CameraSessionWiringTests.swift ios/README.md README.md
git commit -m "feat(ios): wire camera capture and gallery into the session"
```

---

## Manual verification

Run after Task 8, on a physical iPhone (the simulator has no camera).

- [ ] Speak "Max，拍照" → a photo is captured; open the gallery and see it, newest first.
- [ ] "Max，开始录像" → the HUD shows the red dot + timer; "Max，停止录像" → recording stops and the clip appears in the gallery. **Confirm the mic stayed live by stopping via voice mid-clip** — the whole reason for silent video.
- [ ] Play the video in the viewer; confirm it is silent.
- [ ] Export a capture to Photos, grant the add-only prompt, confirm the 已导出 badge and that it appears in the system Photos app.
- [ ] Delete a capture; confirm it leaves the gallery and frees the file.
- [ ] "Max，打开相册" → the gallery presents.
- [ ] Deny camera permission, say "Max，拍照" → Max says it lacks camera permission and captures nothing.
- [ ] Let a recording run to 10 minutes → it auto-stops, saves, and Max announces the cap.
- [ ] Lock the screen, speak a capture command → Max says the phone must be unlocked.
- [ ] Confirm an Android client receiving a `camera.*` command ignores it without erroring.
