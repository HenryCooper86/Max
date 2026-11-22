import CoreMotion
import ImageIO
import SwiftUI
import UIKit

/// The assistant's character: a hummingbird, filmed hovering and cut out of
/// its background, that keeps the lens company.
///
/// A filmed bird cannot act, so its moods are shown by how it flies: it leans
/// in to listen, drifts while the assistant thinks, bobs while it speaks and
/// starts back at a hazard. The wearer can move it too: it drifts the way the
/// phone is tipped and flies to a finger on the screen. The footage is an animated image with
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

// MARK: - tilt and touch

/// One step of the tilt filter, shared by the tests and the motion handler.
///
/// The bird drifts the way the phone is tipped, like something floating, and
/// comes back when the phone is held still in its new position: the resting
/// posture is tracked slowly (`baseline`) and only the change from it moves
/// the bird. The output is smoothed and limited so a shaking phone, on a
/// moving bike for one, makes the bird sway rather than jitter.
struct MascotTilt: Equatable {
    /// Slowly-following resting gravity, in g.
    var baseline: CGVector?
    /// Where the bird is drawn, in bird widths (x) and heights (y).
    var offset: CGSize = .zero

    static let limit = CGSize(width: 0.7, height: 0.5)

    mutating func step(gravityX: Double, gravityY: Double, dt: Double) {
        let gravity = CGVector(dx: gravityX, dy: gravityY)
        var rest = baseline ?? gravity
        let follow = min(1, dt / 2.5)
        rest.dx += (gravity.dx - rest.dx) * follow
        rest.dy += (gravity.dy - rest.dy) * follow
        baseline = rest
        // Tip the right edge down and the bird slides right; tip the top away
        // and it slides up the screen.
        let wantedX = max(-Self.limit.width, min(Self.limit.width, (gravity.dx - rest.dx) * 2.2))
        let wantedY = max(-Self.limit.height, min(Self.limit.height, -(gravity.dy - rest.dy) * 2.2))
        let ease = min(1, dt / 0.25)
        offset.width += (wantedX - offset.width) * ease
        offset.height += (wantedY - offset.height) * ease
    }
}

/// What the wearer is doing to the bird: where a finger is on the screen and
/// how the phone is tipped. One instance, because there is one bird.
final class MascotPilot: ObservableObject {
    static let shared = MascotPilot()

    /// The finger on the screen, in global coordinates, while it is down.
    @Published var finger: CGPoint?
    /// The drift from tipping the phone.
    @Published private(set) var tilt = MascotTilt()

    private let motion = CMMotionManager()
    private var watchers = 0

    func startTilt() {
        watchers += 1
        guard watchers == 1, motion.isDeviceMotionAvailable else { return }
        let interval = 1.0 / 30.0
        motion.deviceMotionUpdateInterval = interval
        tilt = MascotTilt()
        motion.startDeviceMotionUpdates(to: .main) { [weak self] sample, _ in
            guard let self, let gravity = sample?.gravity else { return }
            self.tilt.step(gravityX: gravity.x, gravityY: gravity.y, dt: interval)
        }
    }

    func stopTilt() {
        watchers = max(0, watchers - 1)
        guard watchers == 0 else { return }
        motion.stopDeviceMotionUpdates()
        tilt = MascotTilt()
    }
}

extension View {
    /// Lets the bird see touches anywhere on this view without taking them:
    /// buttons, the lens and scrolling all keep working.
    func mascotFollowsTouches() -> some View {
        simultaneousGesture(
            DragGesture(minimumDistance: 0, coordinateSpace: .global)
                .onChanged { MascotPilot.shared.finger = $0.location }
                .onEnded { _ in MascotPilot.shared.finger = nil }
        )
    }
}

struct Mascot: View {
    let mood: MascotMood
    /// Off when the phone is sideways: the tilt axes are the portrait ones.
    var tiltEnabled = true
    /// Critical heat: the animated film stops along with the visor.
    var animationsPaused = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject private var pilot = MascotPilot.shared
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
            let home = proxy.frame(in: .global)
            let pose = flight
            // A finger wins: the bird flies to it and hovers just above, beak
            // towards it. Otherwise it keeps its mood's pose, nudged by tilt.
            let finger = reduceMotion ? nil : pilot.finger
            let facingLeft = finger.map { $0.x < home.midX } ?? false
            let offset: CGSize = finger.map {
                CGSize(
                    width: $0.x - home.midX + (facingLeft ? 0.2 : -0.2) * size.width,
                    height: $0.y - home.midY - size.height * 0.75
                )
            } ?? CGSize(
                width: (pose.offset.width + pilot.tilt.offset.width) * size.width,
                height: (pose.offset.height + pilot.tilt.offset.height) * size.height
            )
            MascotFilm(still: reduceMotion || animationsPaused || Loc.isRunningTests)
                // A slow drift, so the bird never hangs perfectly still.
                .offset(y: reduceMotion ? 0 : (drifting ? -size.height * 0.05 : size.height * 0.03))
                .scaleEffect(x: facingLeft ? -pose.scale : pose.scale, y: pose.scale)
                .rotationEffect(.degrees(finger == nil ? pose.tilt : 0))
                .offset(offset)
                .opacity(mood == .asleep && finger == nil ? 0.6 : 1)
                .animation(reduceMotion ? nil : .spring(response: 0.55, dampingFraction: 0.62), value: mood)
                .animation(reduceMotion ? nil : .spring(response: 0.42, dampingFraction: 0.7), value: finger)
        }
        // Decoration: VoiceOver skips it and touches fall through to the visor.
        .allowsHitTesting(mascotAccessibilityContract.hitTestable)
        .accessibilityHidden(mascotAccessibilityContract.hidden)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true)) { drifting = true }
            if tiltEnabled, !Loc.isRunningTests { pilot.startTilt() }
        }
        .onDisappear {
            if tiltEnabled, !reduceMotion, !Loc.isRunningTests { pilot.stopTilt() }
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
