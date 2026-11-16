import ImageIO
import SwiftUI
import UIKit

/// The assistant's character: a hummingbird, filmed hovering and cut out of
/// its background, that keeps the lens company.
///
/// A filmed bird cannot act, so its moods are shown by how it flies: it leans
/// in to listen, drifts while the assistant thinks, bobs while it speaks and
/// starts back at a hazard. The footage is an animated image with
/// transparency, decoded by ImageIO, so it never touches the audio session the
/// voice link depends on. With Reduce Motion it is a still frame.
///
/// Footage credit: Character/CREDITS.txt.
enum MascotMood: Equatable {
    case ready, listening, thinking, speaking, alert, asleep
}

/// The mood that goes with what the lens is showing.
func mascotMood(_ mode: VisorMode, hazard: HazardLevel) -> MascotMood {
    if mode != .offline, hazard != .normal { return .alert }
    switch mode {
    case .idle: return .ready
    case .connecting, .thinking: return .thinking
    case .listening: return .listening
    case .speaking: return .speaking
    case .offline: return .asleep
    }
}

/// Where the bird sits for a stage: on the upper right of the lens's rim,
/// sized from the lens so it keeps its place on every screen.
func mascotFrame(in stage: CGSize) -> CGRect {
    let lens = visorLensRect(in: stage)
    let half = lens.width / 2
    let width = min(180, max(72, half * 0.62))
    let height = width * 8 / 11
    return CGRect(
        x: lens.midX + half * 0.74 - width / 2,
        y: lens.midY - half * 0.42 - height / 2,
        width: width,
        height: height
    )
}

struct Mascot: View {
    let mood: MascotMood
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drifting = false

    private var flight: (offset: CGSize, tilt: Double, scale: CGFloat) {
        switch mood {
        case .ready: return (.zero, 0, 1)
        case .listening: return (CGSize(width: -0.10, height: 0.08), 4, 1.06)
        case .thinking: return (CGSize(width: 0.06, height: -0.10), -5, 1)
        case .speaking: return (CGSize(width: -0.04, height: 0.02), 0, 1.04)
        case .alert: return (CGSize(width: 0.12, height: -0.08), -8, 0.94)
        case .asleep: return (CGSize(width: 0, height: 0.08), 0, 0.96)
        }
    }

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            let pose = flight
            MascotFilm(still: reduceMotion || Loc.isRunningTests)
                // A slow drift, so the bird never hangs perfectly still.
                .offset(y: reduceMotion ? 0 : (drifting ? -size.height * 0.05 : size.height * 0.03))
                .scaleEffect(pose.scale)
                .rotationEffect(.degrees(pose.tilt))
                .offset(x: pose.offset.width * size.width, y: pose.offset.height * size.height)
                .opacity(mood == .asleep ? 0.6 : 1)
                .animation(reduceMotion ? nil : .spring(response: 0.55, dampingFraction: 0.62), value: mood)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true)) { drifting = true }
        }
    }
}

/// Plays the animated image into a layer, one frame at a time at the file's
/// own pace. Frames are decoded as they are shown rather than held in memory:
/// the whole loop decoded at once would be tens of megabytes.
private struct MascotFilm: UIViewRepresentable {
    let still: Bool

    func makeUIView(context: Context) -> FilmView {
        let view = FilmView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        view.layer.contentsGravity = .resizeAspect
        view.show(still: still)
        return view
    }

    func updateUIView(_ view: FilmView, context: Context) {
        view.show(still: still)
    }

    static func dismantleUIView(_ view: FilmView, coordinator: ()) {
        view.stop()
    }

    final class FilmView: UIView {
        private static let frameInterval: TimeInterval = 1.0 / 30.0
        private var playing: Bool?
        private var source: CGImageSource?
        private var frameCount = 0
        private var index = 0
        private var timer: Timer?

        func show(still: Bool) {
            guard playing != !still else { return }
            stop()
            playing = !still
            layer.contents = UIImage(named: "hummingbird-still.png")?.cgImage
            guard !still,
                  let url = Bundle.main.url(forResource: "hummingbird", withExtension: "webp"),
                  let source = CGImageSourceCreateWithURL(url as CFURL, nil)
            else { return }
            let count = CGImageSourceGetCount(source)
            guard count > 1 else { return }
            self.source = source
            frameCount = count
            index = 0
            let timer = Timer(timeInterval: Self.frameInterval, repeats: true) { [weak self] _ in
                self?.advance()
            }
            // Common modes, so the bird keeps flying while a list is scrolled.
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
        }

        private func advance() {
            guard let source, window != nil else { return }
            if let image = CGImageSourceCreateImageAtIndex(source, index, nil) {
                layer.contents = image
            }
            index = (index + 1) % frameCount
        }

        func stop() {
            timer?.invalidate()
            timer = nil
            source = nil
            playing = nil
        }
    }
}
