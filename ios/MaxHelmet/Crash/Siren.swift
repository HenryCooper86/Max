import Foundation

/// Loopable two-tone siren rendered as 24 kHz PCM16 mono — the same format
/// PcmPlayer speaks, so the siren goes through the shared voice engine and
/// echo cancellation keeps working.
enum SirenSource {
    static let sampleRate = 24_000.0
    static let highHz = 950.0
    static let lowHz = 700.0
    static let toneS = 0.5

    static func makePcm(durationS: Double = 2.0) -> Data {
        let total = Int(durationS * sampleRate)
        var data = Data(capacity: total * 2)
        for i in 0..<total {
            let t = Double(i) / sampleRate
            let hz = Int(t / toneS) % 2 == 0 ? highHz : lowHz
            let value = Int16(0.85 * Double(Int16.max) * sin(2 * .pi * hz * t))
            withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
        }
        return data
    }
}

/// Owns the repeat loop; the injected closures do the actual audio I/O so
/// tests never touch AVAudioEngine.
final class SirenPlayer {
    private let play: (Data) -> Void
    private let stopPlayback: () -> Void
    private var timer: Timer?
    private let pcm = SirenSource.makePcm()
    private(set) var running = false

    init(play: @escaping (Data) -> Void, stop: @escaping () -> Void) {
        self.play = play
        self.stopPlayback = stop
    }

    func start() {
        guard !running else { return }
        running = true
        play(pcm)
        timer = Timer.scheduledTimer(withTimeInterval: 1.9, repeats: true) { [weak self] _ in
            guard let self, self.running else { return }
            self.play(self.pcm)
        }
    }

    func stop() {
        guard running else { return }
        running = false
        timer?.invalidate()
        timer = nil
        stopPlayback()
    }
}
