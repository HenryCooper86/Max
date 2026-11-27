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

    /// Nonisolated so a non-`@MainActor` owner (MainViewModel) can build it in a
    /// stored/lazy property. It only captures the two collaborators — both
    /// `Sendable`, so these references may cross to the main actor — and all
    /// mutation of the published state stays main-actor-isolated.
    nonisolated init(store: CaptureStoring, exporter: PhotoLibraryAdding) {
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
            exportError = L("gallery.exportError")
        }
    }

    func delete(_ capture: Capture) {
        store.delete(capture.id)
        refresh()
    }

    func fileURL(for capture: Capture) -> URL { store.fileURL(for: capture) }
    func thumbnailURL(for capture: Capture) -> URL { store.thumbnailURL(for: capture) }
}
