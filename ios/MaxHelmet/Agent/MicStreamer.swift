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
    /// The input format `converter` was built for. process() rebuilds the
    /// converter when the tap starts delivering a different format (a mid-ride
    /// route change), so resampling never runs from a stale hardware format.
    private var converterInputFormat: AVAudioFormat?
    private let outputFormat: AVAudioFormat
    /// Accumulates resampled PCM16 bytes until a full 320-sample frame is ready.
    private var pending = Data()
    private var running = false
    #if DEBUG
    var syntheticAudioQARunning: Bool { running }
    #endif
    /// Observes AVAudioEngineConfigurationChange so a mid-session route change
    /// (a Bluetooth helmet connecting, AirPods dropping) reinstalls the tap for
    /// the new hardware format and restarts the engine if the change stopped it.
    private var configObserver: NSObjectProtocol?

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
        converterInputFormat = inputFormat
        pending.removeAll(keepingCapacity: true)

        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.process(buffer)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            // engine.start() failed after the tap was installed. Remove it now:
            // `running` is still false, so stop() would early-return and a retry
            // of start() would install a second tap on the same bus and crash.
            input.removeTap(onBus: 0)
            converter = nil
            converterInputFormat = nil
            pending.removeAll(keepingCapacity: true)
            throw error
        }
        running = true

        // A mid-session route change (a Bluetooth helmet connecting, AirPods
        // dropping) can change the input hardware format and stop the engine.
        // Reinstall the tap for the new format and restart the engine so capture
        // continues instead of resampling from a stale format or going silent.
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self] _ in
            self?.handleConfigurationChange()
        }
    }

    func stop() {
        guard running || engine.isRunning else { return }
        running = false
        if let observer = configObserver {
            NotificationCenter.default.removeObserver(observer)
            configObserver = nil
        }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        converterInputFormat = nil
        pending.removeAll(keepingCapacity: true)
    }

    /// Stops capture without tearing down the shared engine. `stop()`'s
    /// `engine.stop()` halts every node on the engine, including PcmPlayer's —
    /// so a caller that must keep something else rendering through this same
    /// engine (the crash siren, which shares it for echo-cancellation reasons)
    /// uses this instead: the tap comes off (no more frames, same as `stop()`
    /// from the rider's perspective) but the engine — and whatever else is
    /// playing through it — keeps running.
    func pauseCapture() {
        guard running else { return }
        running = false
        if let observer = configObserver {
            NotificationCenter.default.removeObserver(observer)
            configObserver = nil
        }
        engine.inputNode.removeTap(onBus: 0)
        converter = nil
        converterInputFormat = nil
        pending.removeAll(keepingCapacity: true)
    }

    /// Reconfigures capture for a new audio route: reinstall the tap for the
    /// current input format and restart the engine if the change stopped it.
    /// Runs on the main queue (see start()); process() rebuilds the resampler
    /// when it sees the new format, so the converter stays owned by the audio
    /// thread and is never mutated across threads here.
    private func handleConfigurationChange() {
        guard running else { return }
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0 else { return }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.process(buffer)
        }
        if !engine.isRunning {
            engine.prepare()
            try? engine.start()
        }
    }

    // MARK: - resample + frame slicing

    private func process(_ inputBuffer: AVAudioPCMBuffer) {
        guard running else { return }

        // Rebuild the resampler if the input format changed under us — a route
        // change (headset connect/disconnect) shifts the hardware sample rate or
        // channel count, and a converter built for the old format would emit the
        // wrong pitch/speed. Owned solely on this callback thread: no cross-thread
        // converter mutation (the route-change handler only touches the tap/engine).
        if converterInputFormat != inputBuffer.format {
            converter = AVAudioConverter(from: inputBuffer.format, to: outputFormat)
            converterInputFormat = inputBuffer.format
            pending.removeAll(keepingCapacity: true)
        }
        guard let converter else { return }

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
