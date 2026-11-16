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
                Label(L("music.qq"), systemImage: "music.note").visorFont(.subhead, .semibold)
                Spacer()
                Button { model.stopPlayback(dismiss: true) } label: {
                    Image(systemName: "xmark").frame(width: 44, height: 44)
                }.accessibilityLabel(L("music.closePanel"))
            }
            Text(L("music.qqNote", ("name", Visor.assistantName)))
                .visorFont(.caption).foregroundStyle(Visor.textSecondary)
            Link(L("music.openQQ"), destination: URL(string: "https://y.qq.com/")!)
                .frame(minHeight: 44)
            Button(L("music.useLocal")) { Task { await model.chooseLocalMusic() } }
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
                    .accessibilityLabel(L("music.stopClose"))
                    .accessibilityIdentifier("closeMusicPlayback")
                }
                if !model.artist.isEmpty {
                    Text(model.artist).visorFont(.caption).foregroundStyle(Visor.textSecondary)
                }
                if let message = model.message {
                    Text(message).visorFont(.caption).foregroundStyle(Visor.warn)
                }
                HStack(spacing: 8) {
                    control(L("music.prev"), symbol: "backward.end.fill", action: .previous)
                    control(model.isPlaying ? L("music.pause") : L("music.play"),
                            symbol: model.isPlaying ? "pause.fill" : "play.fill",
                            action: model.isPlaying ? .pause : .play)
                    control(L("music.next"), symbol: "forward.end.fill", action: .next)
                    Spacer(minLength: 0)
                    Button(L("music.choose")) { Task { await model.chooseMusic() } }
                        .visorFont(.caption)
                        .frame(minHeight: 44)
                }
                .disabled(model.busy)
                Button(L("music.useQQ")) { model.useQQMusic() }.visorFont(.caption).foregroundStyle(Visor.textSecondary).frame(minHeight: 44)
                if model.busy { ProgressView(L("music.preparingLong")).visorFont(.caption) }
            }
    }

    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Button { Task { await model.chooseMusic() } } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(model.title).visorFont(.subhead, .semibold).lineLimit(2)
                        Text(model.busy ? L("music.preparing") : (model.artist.isEmpty ? L("music.choose") : model.artist))
                            .visorFont(.caption).foregroundStyle(Visor.textSecondary).lineLimit(1)
                    }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }.buttonStyle(.plain).disabled(model.busy)
                Button { model.stopPlayback(dismiss: true) } label: {
                    Image(systemName: "xmark").frame(width: 44, height: 44)
                }.buttonStyle(.plain).accessibilityLabel(L("music.stopClose"))
            }
            HStack(spacing: 12) {
                control(L("music.prev"), symbol: "backward.end.fill", action: .previous).disabled(model.busy)
                control(model.isPlaying ? L("music.pause") : L("music.play"),
                        symbol: model.isPlaying ? "pause.fill" : "play.fill",
                        action: model.isPlaying ? .pause : .play).disabled(model.busy && !model.isPlaying)
                control(L("music.next"), symbol: "forward.end.fill", action: .next).disabled(model.busy)
            }.frame(maxWidth: .infinity)
            if let message = model.message {
                Text(message).visorFont(.caption).foregroundStyle(Visor.warn).lineLimit(2)
            }
            Button(L("music.useQQ")) { model.useQQMusic() }.visorFont(.caption).foregroundStyle(Visor.textSecondary).frame(minHeight: 44)
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
        picker.prompt = L("music.pickerPrompt")
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
