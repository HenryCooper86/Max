import AVFoundation

/// Gapless playback of the 24 kHz PCM16 mono voice frames relayed from Doubao —
/// the iOS counterpart of the playback-cursor scheduling in src/main.tsx and
/// android/.../PcmPlayer.kt. AVAudioPlayerNode schedules buffers back to back; a
/// generation counter implements barge-in by abandoning everything queued.
final class PcmPlayer {

    static let sampleRate = 24_000

    private let engine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private let inputFormat: AVAudioFormat   // 24 kHz PCM16 mono (the wire format)
    private let mixFormat: AVAudioFormat     // 24 kHz float32 mono (engine-friendly)
    private var converter: AVAudioConverter?

    private let queue = DispatchQueue(label: "pcm-player")
    private var running = false
    /// Bumped by barge-in so scheduled completions for the old utterance are ignored.
    private var generation = 0

    init() {
        inputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Double(PcmPlayer.sampleRate),
            channels: 1,
            interleaved: true
        )!
        mixFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(PcmPlayer.sampleRate),
            channels: 1,
            interleaved: false
        )!
        converter = AVAudioConverter(from: inputFormat, to: mixFormat)
    }

    func start() {
        queue.sync {
            guard !running else { return }
            engine.attach(playerNode)
            engine.connect(playerNode, to: engine.mainMixerNode, format: mixFormat)
            engine.prepare()
            do {
                try engine.start()
                playerNode.play()
                running = true
            } catch {
                running = false
            }
        }
    }

    /// Queues a 24 kHz PCM16 buffer. Called from the WebSocket reader.
    func play(_ pcm: Data) {
        if !running { start() }
        queue.async { [weak self] in
            guard let self, self.running else { return }
            guard let buffer = self.makeFloatBuffer(from: pcm) else { return }
            // stopPlayback() (barge-in) flushes the node, so any buffer scheduled
            // before it is discarded — the generation counter mirrors the Android
            // logic and guards against late callbacks if a completion handler is added.
            self.playerNode.scheduleBuffer(buffer, completionHandler: nil)
        }
    }

    /// Barge-in: drop queued audio and cut the current utterance immediately.
    func stopPlayback() {
        queue.sync {
            generation += 1
            guard running else { return }
            playerNode.stop()
            playerNode.play()   // re-arm for the next utterance
        }
    }

    func release() {
        queue.sync {
            generation += 1
            guard running else { return }
            playerNode.stop()
            engine.stop()
            running = false
        }
    }

    // MARK: - PCM16 → float32 conversion

    private func makeFloatBuffer(from pcm: Data) -> AVAudioPCMBuffer? {
        let sampleCount = pcm.count / 2
        guard sampleCount > 0,
              let inBuffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(sampleCount)),
              let channel = inBuffer.int16ChannelData else { return nil }
        inBuffer.frameLength = AVAudioFrameCount(sampleCount)
        pcm.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: Int16.self)
            for i in 0..<sampleCount {
                channel[0][i] = Int16(littleEndian: src[i])
            }
        }

        guard let converter,
              let outBuffer = AVAudioPCMBuffer(pcmFormat: mixFormat, frameCapacity: AVAudioFrameCount(sampleCount)) else {
            return nil
        }
        var supplied = false
        var error: NSError?
        converter.convert(to: outBuffer, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return inBuffer
        }
        return error == nil ? outBuffer : nil
    }
}
