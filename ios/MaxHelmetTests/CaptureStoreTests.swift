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
