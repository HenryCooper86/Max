import MediaPlayer
import SwiftUI

struct MusicPlaybackCard: View {
    @ObservedObject var model: MusicPlaybackModel

    var body: some View {
        if model.visible {
            VStack(alignment: .leading, spacing: 8) {
                Label(model.title, systemImage: "music.note")
                    .font(.headline)
                    .lineLimit(2)
                if !model.artist.isEmpty {
                    Text(model.artist).font(.caption).foregroundStyle(.secondary)
                }
                if let message = model.message {
                    Text(message).font(.caption).foregroundStyle(HudColors.amber)
                }
                HStack(spacing: 8) {
                    control("上一首", symbol: "backward.end.fill", action: .previous)
                    control(model.isPlaying ? "暂停" : "播放",
                            symbol: model.isPlaying ? "pause.fill" : "play.fill",
                            action: model.isPlaying ? .pause : .play)
                    control("下一首", symbol: "forward.end.fill", action: .next)
                    Spacer(minLength: 0)
                    Button("选择音乐") { Task { await model.chooseMusic() } }
                        .font(.caption)
                        .frame(minHeight: 44)
                }
                .disabled(model.busy)
                if model.busy { ProgressView("正在准备音乐…").font(.caption) }
            }
            .padding(12)
            .foregroundStyle(.white)
            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
            .accessibilityIdentifier("musicPlaybackCard")
            .sheet(isPresented: $model.showingPicker) {
                MusicLibraryPicker { collection in
                    model.showingPicker = false
                    if let collection { Task { await model.select(collection) } }
                }
            }
        }
    }

    private func control(_ label: String, symbol: String, action: MusicControl) -> some View {
        Button { Task { _ = await model.perform(action) } } label: {
            Image(systemName: symbol).frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

private struct MusicLibraryPicker: UIViewControllerRepresentable {
    let completion: (MPMediaItemCollection?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }

    func makeUIViewController(context: Context) -> MPMediaPickerController {
        let picker = MPMediaPickerController(mediaTypes: .music)
        picker.allowsPickingMultipleItems = true
        picker.showsCloudItems = true
        picker.prompt = "选择多首歌曲或歌单，以便切换上一首和下一首"
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: MPMediaPickerController, context: Context) {}

    final class Coordinator: NSObject, MPMediaPickerControllerDelegate {
        let completion: (MPMediaItemCollection?) -> Void
        init(completion: @escaping (MPMediaItemCollection?) -> Void) { self.completion = completion }
        func mediaPicker(_ mediaPicker: MPMediaPickerController,
                         didPickMediaItems mediaItemCollection: MPMediaItemCollection) {
            completion(mediaItemCollection)
        }
        func mediaPickerDidCancel(_ mediaPicker: MPMediaPickerController) { completion(nil) }
    }
}
