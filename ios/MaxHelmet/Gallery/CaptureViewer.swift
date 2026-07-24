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
