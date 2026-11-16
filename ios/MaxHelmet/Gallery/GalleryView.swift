import SwiftUI
import UIKit

/// The capture gallery grid. Newest-first thumbnails; tap one for the viewer.
struct GalleryView: View {
    @ObservedObject var model: GalleryModel
    let onClose: () -> Void

    @State private var selected: Capture?

    private let columns = [GridItem(.adaptive(minimum: 104), spacing: Visor.Space.s1)]

    var body: some View {
        NavigationStack {
            Group {
                if model.captures.isEmpty {
                    emptyState
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: Visor.Space.s1) {
                            ForEach(model.captures) { capture in
                                Button { selected = capture } label: { cell(capture) }
                                    .buttonStyle(.plain)
                            }
                        }
                        .padding(Visor.Space.s1)
                    }
                }
            }
            .background(Visor.bg.ignoresSafeArea())
            .navigationTitle(L("gallery.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Visor.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L("common.done"), action: onClose)
                        .visorFont(.subhead, .semibold)
                        .frame(minHeight: Visor.hit)
                }
            }
            .sheet(item: $selected) { capture in
                CaptureViewer(capture: capture, model: model)
            }
            .alert(L("gallery.exportFailed"), isPresented: Binding(
                get: { model.exportError != nil },
                set: { if !$0 { model.exportError = nil } }
            )) {
                Button(L("common.ok"), role: .cancel) {}
            } message: {
                Text(model.exportError ?? "")
            }
        }
        .tint(Visor.accent)
        .presentationBackground(Visor.bg)
        .presentationCornerRadius(Visor.Radius.sheet)
        .onAppear { model.refresh() }
    }

    private func cell(_ capture: Capture) -> some View {
        ZStack(alignment: .bottomLeading) {
            // The square must derive from the grid column width, never from the
            // image: sizing the thumbnail directly let a full-resolution photo's
            // intrinsic size blow the tiles up past the screen. Color.clear has
            // no intrinsic size, so the overlaid image fills exactly one cell.
            Color.clear
                .aspectRatio(1, contentMode: .fit)
                .overlay(AsyncThumbnail(url: model.thumbnailURL(for: capture)))
                .clipShape(RoundedRectangle(cornerRadius: Visor.Radius.control, style: .continuous))

            HStack(spacing: 4) {
                if capture.type == .video {
                    Image(systemName: "play.circle.fill")
                    if let d = capture.durationSec {
                        Text("\(Int(d))s")
                    }
                }
                if capture.exported {
                    Text(L("gallery.exported"))
                        .foregroundStyle(Visor.ok)
                }
            }
            .visorFont(.caption, .semibold, mono: true)
            .foregroundStyle(Visor.text)
            // Legible over any photo in every template, light or dark.
            .padding(.horizontal, capture.type == .video || capture.exported ? 6 : 0)
            .padding(.vertical, capture.type == .video || capture.exported ? 2 : 0)
            .background(capture.type == .video || capture.exported ? Visor.bg.opacity(0.85) : Color.clear, in: Capsule())
            .padding(Visor.Space.s2 - 2)
        }
        // clipShape bounds only the pixels, not hit-testing — without this, an
        // overlaid image reaching past its tile steals the neighbor's tap.
        .contentShape(RoundedRectangle(cornerRadius: Visor.Radius.control, style: .continuous))
    }

    private var emptyState: some View {
        VStack(spacing: Visor.Space.s2) {
            Image(systemName: "photo.on.rectangle.angled").font(.system(size: 32, weight: .light))
            Text(L("gallery.empty")).visorFont(.subhead)
        }
        .foregroundStyle(Visor.textTertiary)
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
                Visor.surface2
            }
        }
        .task(id: url) {
            let loaded = await Task.detached { UIImage(contentsOfFile: url.path) }.value
            image = loaded
        }
    }
}
