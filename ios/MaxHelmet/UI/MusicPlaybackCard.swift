import MediaPlayer
import SwiftUI

struct MusicPlaybackCard: View {
    @ObservedObject var model: MusicPlaybackModel
    var presentsPicker = true
    var compact = false

    var body: some View {
        if model.visible {
            Group {
                if model.prefersQQMusic { qqContent } else if compact { compactContent } else { fullContent }
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(Visor.Space.s3)
            .foregroundStyle(Visor.text)
            .tint(Visor.accent)
            .background(Visor.surface1, in: RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous)
                    .strokeBorder(Visor.line, lineWidth: Visor.hairline)
            )
            .accessibilityIdentifier("musicPlaybackCard")
            .sheet(isPresented: Binding(
                get: { presentsPicker && model.showingPicker },
                set: { if presentsPicker { model.showingPicker = $0 } }
            )) {
                MusicLibraryPicker { collection in
                    model.showingPicker = false
                    if let collection { Task { await model.select(collection) } }
                }
            }
        }
    }

    private var qqContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("QQ 音乐", systemImage: "music.note").visorFont(.subhead, .semibold)
                Spacer()
                Button { model.stopPlayback(dismiss: true) } label: {
                    Image(systemName: "xmark").frame(width: 44, height: 44)
                }.accessibilityLabel("关闭音乐面板")
            }
            Text("请在 QQ 音乐中播放和切歌。\(Visor.assistantName) 暂不能控制 QQ 音乐；关闭此面板不会停止 QQ 音乐。")
                .visorFont(.caption).foregroundStyle(Visor.textSecondary)
            Link("打开 QQ 音乐官网", destination: URL(string: "https://y.qq.com/")!)
                .frame(minHeight: 44)
            Button("改用 Apple Music / 本机音乐") { Task { await model.chooseLocalMusic() } }
                .visorFont(.caption).foregroundStyle(Visor.textSecondary).frame(minHeight: 44)
        }
    }

    private var fullContent: some View {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    Label(model.title, systemImage: "music.note")
                        .visorFont(.subhead, .semibold)
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    Button { model.stopPlayback(dismiss: true) } label: {
                        Image(systemName: "xmark").frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("停止并关闭音乐")
                    .accessibilityIdentifier("closeMusicPlayback")
                }
                if !model.artist.isEmpty {
                    Text(model.artist).visorFont(.caption).foregroundStyle(Visor.textSecondary)
                }
                if let message = model.message {
                    Text(message).visorFont(.caption).foregroundStyle(Visor.warn)
                }
                HStack(spacing: 8) {
                    control("上一首", symbol: "backward.end.fill", action: .previous)
                    control(model.isPlaying ? "暂停" : "播放",
                            symbol: model.isPlaying ? "pause.fill" : "play.fill",
                            action: model.isPlaying ? .pause : .play)
                    control("下一首", symbol: "forward.end.fill", action: .next)
                    Spacer(minLength: 0)
                    Button("选择音乐") { Task { await model.chooseMusic() } }
                        .visorFont(.caption)
                        .frame(minHeight: 44)
                }
                .disabled(model.busy)
                Button("改用 QQ 音乐") { model.useQQMusic() }.visorFont(.caption).foregroundStyle(Visor.textSecondary).frame(minHeight: 44)
                if model.busy { ProgressView("正在准备音乐…").visorFont(.caption) }
            }
    }

    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Button { Task { await model.chooseMusic() } } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(model.title).visorFont(.subhead, .semibold).lineLimit(2)
                        Text(model.busy ? "正在准备…" : (model.artist.isEmpty ? "选择音乐" : model.artist))
                            .visorFont(.caption).foregroundStyle(Visor.textSecondary).lineLimit(1)
                    }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }.buttonStyle(.plain).disabled(model.busy)
                Button { model.stopPlayback(dismiss: true) } label: {
                    Image(systemName: "xmark").frame(width: 44, height: 44)
                }.buttonStyle(.plain).accessibilityLabel("停止并关闭音乐")
            }
            HStack(spacing: 12) {
                control("上一首", symbol: "backward.end.fill", action: .previous).disabled(model.busy)
                control(model.isPlaying ? "暂停" : "播放",
                        symbol: model.isPlaying ? "pause.fill" : "play.fill",
                        action: model.isPlaying ? .pause : .play).disabled(model.busy && !model.isPlaying)
                control("下一首", symbol: "forward.end.fill", action: .next).disabled(model.busy)
            }.frame(maxWidth: .infinity)
            if let message = model.message {
                Text(message).visorFont(.caption).foregroundStyle(Visor.warn).lineLimit(2)
            }
            Button("改用 QQ 音乐") { model.useQQMusic() }.visorFont(.caption).foregroundStyle(Visor.textSecondary).frame(minHeight: 44)
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
