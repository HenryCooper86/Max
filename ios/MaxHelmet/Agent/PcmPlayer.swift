import AVFoundation

/// Gapless playback of the 24 kHz PCM16 mono voice frames relayed from Doubao —
/// the iOS counterpart of the playback-cursor scheduling in src/main.tsx and
/// android/.../PcmPlayer.kt. AVAudioPlayerNode schedules buffers back to back; a
/// generation counter implements barge-in by abandoning everything queued.
final class PcmPlayer {

    static let sampleRate = 24_000
    /// Boost agent speech above the raw Doubao level so it is loud enough at the
    /// helmet speaker; a soft limiter (see softLimit) tames peaks afterward.
    /// Mirrors PLAYBACK_GAIN in src/main.tsx and PcmPlayer.kt.
    static let playbackGain: Float = 2.0
    /// Soft-limiter threshold (≈ -3 dBFS, matching the web's DynamicsCompressor and
    /// Android PcmPlayer). Samples below this stay linear; louder peaks compress
    /// smoothly toward full scale instead of hard-clipping.
    static let limitThreshold: Float = 0.7

    /// Current output gain, adjustable by voice ("Max，大声一点"). Read on the
    /// audio render thread and written on the main thread; a naturally-aligned
    /// 32-bit scalar is read and written atomically on every architecture this
    /// app supports, so the render thread takes no lock.
    private var currentGain: Float = PcmPlayer.playbackGain

    /// Shared with MicStreamer so the agent voice renders through the same engine
    /// that performs echo cancellation — see prepare() and MicStreamer.start().
    /// Replaced only by rebind(to:) after a media-services reset.
    private var engine: AVAudioEngine
    private var playerNode = AVAudioPlayerNode()
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
    #if DEBUG
    private var qaScheduledBytes = 0
    private var qaPlayedBackBytes = 0
    private var qaPendingBytes = 0
    private var qaInterruptedAudio = 0
    private var qaDiscardedBytes = 0
    var syntheticAudioQASnapshot: (scheduledBytes: Int, playedBackBytes: Int, interruptedAudio: Int, pendingBytes: Int, discardedBytes: Int, playerArmed: Bool, nodePlaying: Bool) {
        queue.sync { (qaScheduledBytes, qaPlayedBackBytes, qaInterruptedAudio, qaPendingBytes, qaDiscardedBytes, playing, playerNode.isPlaying) }
    }
    #endif
    /// PCM that arrived before the shared engine was running — typically the
    /// agent's opening words while the mic-permission dialog is still up
    /// (MicStreamer.start() only runs once permission is granted). Bounded;
    /// oldest chunks drop first. Drained by flushPending()/the next play().
    private var pendingChunks: [Data] = []
    /// ~5 s of 24 kHz mono PCM16 in relay-sized chunks.
    private static let maxPendingChunks = 256

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
            guard let self else { return }
            guard self.attached, self.engine.isRunning else {
                // The engine isn't up yet (mic permission still pending): hold
                // the audio instead of dropping it, so the agent's greeting
                // plays once the engine starts.
                if self.pendingChunks.count >= Self.maxPendingChunks {
                    self.pendingChunks.removeFirst()
                }
                self.pendingChunks.append(pcm)
                return
            }
            self.drainPendingLocked()
            self.schedule(pcm)
        }
    }

    /// Schedules any audio buffered before the engine was running. Called by
    /// AgentSession right after MicStreamer starts the shared engine.
    func flushPending() {
        queue.async { [weak self] in
            guard let self, self.attached, self.engine.isRunning else { return }
            self.drainPendingLocked()
        }
    }

    /// Must run on `queue` with the engine running.
    private func drainPendingLocked() {
        guard !pendingChunks.isEmpty else { return }
        let chunks = pendingChunks
        pendingChunks.removeAll()
        for chunk in chunks { schedule(chunk) }
    }

    /// Must run on `queue` with the engine running.
    private func schedule(_ pcm: Data) {
        // An interruption or route change stops the engine, and the node with
        // it, while `playing` still says armed; re-arm whenever the node is
        // not actually playing, or the next utterance is queued into silence.
        if !playing || !playerNode.isPlaying {
            playerNode.play()   // arm the node now that the engine runs
            playing = true
        }
        guard let buffer = makeFloatBuffer(from: pcm) else { return }
        // stopPlayback() (barge-in) flushes the node, so any buffer scheduled
        // before it is discarded — the generation counter mirrors the Android
        // logic and guards against late callbacks if a completion handler is added.
        #if DEBUG
        let sourceGeneration = generation
        qaScheduledBytes += pcm.count
        qaPendingBytes += pcm.count
        playerNode.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            self?.queue.async { [weak self] in
                guard let self, sourceGeneration == self.generation else { return }
                self.qaPlayedBackBytes += pcm.count
                self.qaPendingBytes = max(0, self.qaPendingBytes - pcm.count)
            }
        }
        #else
        playerNode.scheduleBuffer(buffer, completionHandler: nil)
        #endif
    }

    /// Barge-in: drop queued audio and cut the current utterance immediately.
    func stopPlayback() {
        queue.sync {
            #if DEBUG
            if qaPendingBytes > 0 {
                qaInterruptedAudio += 1
                // Whole scheduled buffers abandoned by interruption, including
                // the uncompleted remainder of a partly played buffer.
                qaDiscardedBytes += qaPendingBytes
            }
            qaPendingBytes = 0
            #endif
            generation += 1
            pendingChunks.removeAll()   // buffered audio belongs to the cut utterance
            guard playing else { return }
            playerNode.stop()
            // An interruption or a route change leaves the engine stopped, and
            // a node must not be started on a stopped engine; schedule()
            // re-arms it once the engine runs again.
            guard attached, engine.isRunning else {
                playing = false
                return
            }
            playerNode.play()   // re-arm for the next utterance
        }
    }

    func release() {
        queue.sync {
            generation += 1
            pendingChunks.removeAll()
            guard playing else { return }
            playerNode.stop()   // MicStreamer.stop() stops the shared engine
            playing = false
        }
    }

    /// Moves playback onto a new engine after a media-services reset, when the
    /// old engine and every node attached to it are dead. A node can belong to
    /// one engine only, so a fresh one is created; the caller then runs
    /// prepare() and starts the engine as on a first start.
    func rebind(to newEngine: AVAudioEngine) {
        queue.sync {
            generation += 1
            pendingChunks.removeAll()
            #if DEBUG
            qaPendingBytes = 0
            #endif
            engine = newEngine
            playerNode = AVAudioPlayerNode()
            attached = false
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

        // Apply the playback boost, then soft-limit so loud peaks compress
        // smoothly toward ±1 instead of hard-clipping (matches Android / web).
        if let samples = outBuffer.floatChannelData {
            let gain = currentGain
            for i in 0..<Int(outBuffer.frameLength) {
                samples[0][i] = softLimit(samples[0][i] * gain)
            }
        }
        return outBuffer
    }

    /// Soft-knee limiter: linear up to `limitThreshold`, then the overshoot is
    /// compressed exponentially toward ±1, so the signal never hard-clips.
    private func softLimit(_ x: Float) -> Float {
        let magnitude = abs(x)
        if magnitude <= PcmPlayer.limitThreshold { return x }
        let headroom = 1 - PcmPlayer.limitThreshold
        let compressed = PcmPlayer.limitThreshold + headroom * (1 - exp(-(magnitude - PcmPlayer.limitThreshold) / headroom))
        return x < 0 ? -compressed : compressed
    }
}

extension PcmPlayer: PlaybackGain {
    var level: Float { currentGain }

    func setLevel(_ newLevel: Float) {
        currentGain = newLevel
    }
}
