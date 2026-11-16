import Foundation

// The live voice display's styles and the spectrum that drives them. A port of
// src/lib/visualizer.ts: one signal, five looks. The spectrum is synthesised
// from the session state and the microphone level (no FFT, no audio taps), so
// every style animates in every state.

enum VoiceVisualizer: String, CaseIterable, Identifiable, Equatable {
    case wave, bars, mirror, dots, ring

    var id: String { rawValue }
    static let `default`: VoiceVisualizer = .wave

    /// Name in the active language ("波形" / "Wave").
    var label: String { L("viz." + rawValue) }
    var labelZh: String { L("viz." + rawValue, in: .zh) }
    var labelEn: String { L("viz." + rawValue, in: .en) }

    /// Validates a wire string; anything but the five ids is nil.
    static func parse(_ value: Any?) -> VoiceVisualizer? {
        guard let s = value as? String else { return nil }
        return VoiceVisualizer(rawValue: s)
    }

    /// Default -> relay `assistant.visualizer` -> the wearer's own choice,
    /// which is ignored when the owner pinned the look.
    static func resolve(relay: String?, viewer: String?, templateSwitching: Bool?) -> VoiceVisualizer {
        if templateSwitching != false, let v = parse(viewer) { return v }
        return parse(relay) ?? .default
    }
}

/// What the lens shows; mirrors the web's SpectrumMode.
enum SpectrumMode: Equatable {
    case idle, connecting, ready, listening, thinking, speaking, offline
}

enum Spectrum {
    /// Bars across the lens.
    static let bins = 24

    private static func bump(_ x: Double, _ center: Double, _ width: Double) -> Double {
        exp(-pow(x - center, 2) / (2 * width * width))
    }

    private static func voiceEnvelope(_ x: Double) -> Double {
        0.12 + 0.62 * bump(x, 0.16, 0.1) + 0.46 * bump(x, 0.38, 0.12) + 0.28 * bump(x, 0.62, 0.1)
    }

    private static func wobble(_ index: Int, _ t: Double, _ speed: Double) -> Double {
        let rate = speed * (0.7 + Double((index * 37) % 11) / 10)
        let phase = (Double(index) * 2.399).truncatingRemainder(dividingBy: Double.pi * 2)
        return 0.5 + 0.25 * sin(t * rate + phase) + 0.25 * sin(t * rate * 1.73 + phase * 2.1)
    }

    private static func clamp01(_ v: Double) -> Double { v.isNaN ? 0 : min(1, max(0, v)) }

    /// A plausible spectrum (every value 0...1) for `mode` at time `t` seconds.
    /// `level` is the live microphone level and scales the listening state.
    static func synthesize(mode: SpectrumMode, level: Double, t: Double, bins n: Int = Spectrum.bins) -> [Double] {
        let voice = clamp01(level.isFinite ? level : 0)
        let time = t.isFinite ? t : 0
        return (0..<n).map { i in
            let x = n > 1 ? Double(i) / Double(n - 1) : 0
            let value: Double
            switch mode {
            case .speaking:
                let syllable = 0.55 + 0.45 * abs(sin(time * 5.3 + sin(time * 1.7)))
                value = voiceEnvelope(x) * (0.5 + 0.5 * wobble(i, time, 7)) * syllable
            case .listening:
                let amplitude = 0.1 + min(1, voice * 2.4) * 0.85
                value = voiceEnvelope(x) * amplitude * (0.55 + 0.45 * wobble(i, time, 6))
            case .connecting:
                let center = (time * 0.65).truncatingRemainder(dividingBy: 1.3) - 0.15
                value = 0.05 + 0.55 * bump(x, center, 0.07)
            case .thinking:
                value = 0.04 + 0.2 * bump(x, 0.5 + 0.32 * sin(time * 1.4), 0.12)
            case .ready:
                value = 0.05 + 0.1 * voiceEnvelope(x) * wobble(i, time, 1.6)
            case .idle:
                value = 0.03 + 0.07 * voiceEnvelope(x) * wobble(i, time, 0.8)
            case .offline:
                value = 0.02
            }
            return clamp01(value)
        }
    }

    /// Peak caps jump up with the signal and fall back slowly. `dt` in seconds.
    static func updatePeaks(_ peaks: inout [Double], values: [Double], dt: Double, fallPerSecond: Double = 0.55) {
        let fall = max(0, dt) * fallPerSecond
        for i in peaks.indices {
            let v = i < values.count ? values[i] : 0
            peaks[i] = max(v, peaks[i] - fall)
        }
    }

    /// Ease displayed values toward the target: rise fast, fall soft.
    static func smooth(_ display: inout [Double], toward target: [Double], dt: Double) {
        let rise = 1 - exp(-dt * 30)
        let fall = 1 - exp(-dt * 9)
        for i in display.indices {
            let next = i < target.count ? target[i] : 0
            display[i] += (next - display[i]) * (next > display[i] ? rise : fall)
        }
    }
}

/// Mutable per-view animation state for the spectrum styles (a reference type
/// so the Canvas draw closure can advance it).
final class SpectrumState {
    var display = [Double](repeating: 0, count: Spectrum.bins)
    var peaks = [Double](repeating: 0, count: Spectrum.bins)
    var lastTime: Double?

    func advance(mode: SpectrumMode, level: Double, t: Double) {
        let dt = lastTime.map { min(0.1, max(0, t - $0)) } ?? 1.0 / 60
        lastTime = t
        let target = Spectrum.synthesize(mode: mode, level: level, t: t)
        Spectrum.smooth(&display, toward: target, dt: dt)
        Spectrum.updatePeaks(&peaks, values: display, dt: dt)
    }
}
