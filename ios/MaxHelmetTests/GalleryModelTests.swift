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
    func indexVideo(at url: URL) async throws -> Capture { fatalError() }
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
