import AVFoundation

/// Gapless playback of the 24 kHz PCM16 mono voice frames relayed from Doubao —
/// the iOS counterpart of the playback-cursor scheduling in src/main.tsx and
/// android/.../PcmPlayer.kt. AVAudioPlayerNode schedules buffers back to back; a
/// generation counter implements barge-in by abandoning everything queued.
final class PcmPlayer {

    static let sampleRate = 24_000
    /// Boost agent speech above the raw Doubao level so it is loud enough at the
    /// helmet speaker; samples are clamped after the boost so peaks don't clip.
    /// Mirrors PLAYBACK_GAIN in src/main.tsx and PcmPlayer.kt.
    static let playbackGain: Float = 2.0

    /// Shared with MicStreamer so the agent voice renders through the same engine
    /// that performs echo cancellation — see prepare() and MicStreamer.start().
    private let engine: AVAudioEngine
    private let playerNode = AVAudioPlayerNode()
    private let inputFormat: AVAudioFormat   // 24 kHz PCM16 mono (the wire format)
    private let mixFormat: AVAudioFormat     // 24 kHz float32 mono (engine-friendly)
    private var converter: AVAudioConverter?

    private let queue = DispatchQueue(label: "pcm-player")
    /// The playback node is attached to the shared engine exactly once.
    private var attached = false
    /// True once playerNode.play() has armed the node for scheduling.
    private var playing = false
    /// Bumped by barge-in so scheduled completions for the old utterance are ignored.
    private var generation = 0

    init(engine: AVAudioEngine) {
        self.engine = engine
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

    /// Attaches the playback node to the shared engine. Must run while the engine
    /// is stopped, before MicStreamer starts it, so the agent voice renders
    /// through the echo-cancelling output. MicStreamer owns the engine's start/stop.
    func prepare() {
        queue.sync {
            guard !attached else { return }
            engine.attach(playerNode)
            engine.connect(playerNode, to: engine.mainMixerNode, format: mixFormat)
            attached = true
        }
    }

    /// Queues a 24 kHz PCM16 buffer. Called from the WebSocket reader.
    func play(_ pcm: Data) {
        queue.async { [weak self] in
            guard let self, self.attached, self.engine.isRunning else { return }
            if !self.playing {
                self.playerNode.play()   // arm the node now that the engine runs
                self.playing = true
            }
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
            guard playing else { return }
            playerNode.stop()
            playerNode.play()   // re-arm for the next utterance
        }
    }

    func release() {
        queue.sync {
            generation += 1
            guard playing else { return }
            playerNode.stop()   // MicStreamer.stop() stops the shared engine
            playing = false
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
        guard error == nil else { return nil }

        // Apply the playback boost and clamp to [-1, 1] so loud peaks don't wrap.
        if let samples = outBuffer.floatChannelData {
            let gain = PcmPlayer.playbackGain
            for i in 0..<Int(outBuffer.frameLength) {
                samples[0][i] = max(-1.0, min(1.0, samples[0][i] * gain))
            }
        }
        return outBuffer
    }
}
