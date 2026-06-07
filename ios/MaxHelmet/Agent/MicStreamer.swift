import AVFoundation

/// Captures mic audio as 16 kHz PCM16 mono and emits 320-sample (20 ms) frames —
/// the iOS counterpart of public/pcm-worklet.js and android/.../MicStreamer.kt.
/// AVAudioEngine taps the input node at its hardware format; an AVAudioConverter
/// resamples to 16 kHz PCM16 mono, and a ring buffer slices exact 320-sample frames.
final class MicStreamer {

    static let sampleRate = 16_000
    static let frameSamples = 320        // 20 ms, matches the worklet frame size
    static let frameBytes = frameSamples * 2

    private let onFrame: (Data) -> Void
    private let onLevel: (Float) -> Void

    /// Shared with PcmPlayer so iOS's voice-processing I/O unit can use the
    /// playback as its echo-cancellation reference — see start().
    private let engine: AVAudioEngine
    private var converter: AVAudioConverter?
    private let outputFormat: AVAudioFormat
    /// Accumulates resampled PCM16 bytes until a full 320-sample frame is ready.
    private var pending = Data()
    private var running = false

    init(engine: AVAudioEngine,
         onFrame: @escaping (Data) -> Void,
         onLevel: @escaping (Float) -> Void) {
        self.engine = engine
        self.onFrame = onFrame
        self.onLevel = onLevel
        // 16 kHz, mono, signed 16-bit, interleaved — the wire format the relay expects.
        self.outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Double(MicStreamer.sampleRate),
            channels: 1,
            interleaved: true
        )!
    }

    /// Starts capture. The caller must already hold microphone permission and have
    /// configured the shared AVAudioSession (see AudioRouter).
    func start() throws {
        guard !running else { return }

        // Enable Apple's acoustic echo cancellation before the engine starts.
        // This switches both I/O nodes to the voice-processing unit, which
        // subtracts whatever PcmPlayer renders through the shared engine from the
        // mic signal — without it the built-in speaker echoes into the mic and
        // the agent replies to itself. AirPods masked this by isolating the path.
        // Must be done while the engine is stopped; best-effort per route.
        if !engine.isRunning {
            try? engine.inputNode.setVoiceProcessingEnabled(true)
        }

        let input = engine.inputNode
        let inputFormat = input.inputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else {
            throw NSError(domain: "MicStreamer", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "microphone unavailable"])
        }
        converter = AVAudioConverter(from: inputFormat, to: outputFormat)
        pending.removeAll(keepingCapacity: true)

        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.process(buffer)
        }

        engine.prepare()
        try engine.start()
        running = true
    }

    func stop() {
        guard running || engine.isRunning else { return }
        running = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        pending.removeAll(keepingCapacity: true)
    }

    // MARK: - resample + frame slicing

    private func process(_ inputBuffer: AVAudioPCMBuffer) {
        guard running, let converter else { return }

        // Estimate the output capacity from the sample-rate ratio.
        let ratio = outputFormat.sampleRate / inputBuffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(inputBuffer.frameLength) * ratio + 1024)
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }

        var supplied = false
        var error: NSError?
        converter.convert(to: outBuffer, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return inputBuffer
        }
        if error != nil || outBuffer.frameLength == 0 { return }

        guard let channel = outBuffer.int16ChannelData else { return }
        let count = Int(outBuffer.frameLength)
        channel[0].withMemoryRebound(to: UInt8.self, capacity: count * 2) { bytes in
            pending.append(bytes, count: count * 2)
        }

        // Emit every complete 320-sample frame.
        while pending.count >= MicStreamer.frameBytes {
            let frame = pending.prefix(MicStreamer.frameBytes)
            let frameData = Data(frame)
            pending.removeFirst(MicStreamer.frameBytes)
            onLevel(frameRMS(frameData))
            onFrame(frameData)
        }
    }

    /// RMS of a PCM16 frame normalized to 0..1; drives the HUD voice visualizer.
    private func frameRMS(_ frame: Data) -> Float {
        var sum = 0.0
        let sampleCount = frame.count / 2
        frame.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for i in 0..<sampleCount {
                let s = Double(Int16(littleEndian: samples[i]))
                sum += s * s
            }
        }
        guard sampleCount > 0 else { return 0 }
        let rms = (sum / Double(sampleCount)).squareRoot() / Double(Int16.max)
        return Float(min(max(rms * 4, 0), 1))
    }
}
