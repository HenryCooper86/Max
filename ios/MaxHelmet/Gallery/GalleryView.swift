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
            // The square must derive from the grid column width, never from the
            // image: sizing the thumbnail directly let a full-resolution photo's
            // intrinsic size blow the tiles up past the screen. Color.clear has
            // no intrinsic size, so the overlaid image fills exactly one cell.
            Color.clear
                .aspectRatio(1, contentMode: .fit)
                .overlay(AsyncThumbnail(url: model.thumbnailURL(for: capture)))
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
        // clipShape bounds only the pixels, not hit-testing — without this, an
        // overlaid image reaching past its tile steals the neighbor's tap.
        .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
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
