// AudioWorklet processor for helmet mic capture. Runs on the audio thread,
// so it does not glitch when the main thread (React/WebSocket) is busy.
//
// It downsamples mono mic audio to 16 kHz, emits 20 ms (320-sample) PCM16
// frames over the message port, and reports a smoothed RMS level for the
// HUD visualizer. `sampleRate` is a global provided by AudioWorkletGlobalScope.

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms at 16 kHz
const LEVEL_REPORT_EVERY = 16; // ~43 ms between visualizer updates

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.sourceWindowRemaining = this.ratio;
    this.resampleSum = 0;
    this.resampleWeight = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.frameFill = 0;
    this.level = 0;
    this.levelCounter = 0;
    this.qualityBlocks = 0;
    this.clippedBlocks = 0;
    this.silentBlocks = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    // Smoothed RMS level for the visor visualizer.
    let sumSquares = 0;
    let clipped = false;
    for (let i = 0; i < channel.length; i += 1) {
      sumSquares += channel[i] * channel[i];
      if (Math.abs(channel[i]) >= 0.98) clipped = true;
    }
    const rms = Math.sqrt(sumSquares / channel.length);
    this.qualityBlocks += 1;
    if (rms < 0.005) this.silentBlocks += 1;
    if (clipped) this.clippedBlocks += 1;
    this.level = this.level * 0.68 + Math.min(1, rms * 8) * 0.32;
    this.levelCounter += 1;
    if (this.levelCounter >= LEVEL_REPORT_EVERY) {
      this.levelCounter = 0;
      this.port.postMessage({
        type: "level",
        value: this.level,
        clippingPct: Math.round((this.clippedBlocks / Math.max(1, this.qualityBlocks)) * 1000) / 10,
        silencePct: Math.round((this.silentBlocks / Math.max(1, this.qualityBlocks)) * 1000) / 10
      });
      this.qualityBlocks = 0;
      this.clippedBlocks = 0;
      this.silentBlocks = 0;
    }

    // Streaming box-average resampler. Each input sample contributes its
    // fractional width to one or two output windows, so 44.1 kHz and 48 kHz
    // both downsample correctly without allocating/copying a pending array on
    // every 128-sample render quantum.
    for (let index = 0; index < channel.length; index += 1) {
      let inputRemaining = 1;
      while (inputRemaining > 0) {
        const weight = Math.min(inputRemaining, this.sourceWindowRemaining);
        this.resampleSum += channel[index] * weight;
        this.resampleWeight += weight;
        inputRemaining -= weight;
        this.sourceWindowRemaining -= weight;

        if (this.sourceWindowRemaining <= 1e-9) {
          const averaged = this.resampleWeight > 0 ? this.resampleSum / this.resampleWeight : 0;
          const sample = Math.max(-1, Math.min(1, averaged));
          this.frame[this.frameFill] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
          this.frameFill += 1;
          this.sourceWindowRemaining = this.ratio;
          this.resampleSum = 0;
          this.resampleWeight = 0;

          if (this.frameFill === FRAME_SAMPLES) {
            const out = this.frame;
            this.port.postMessage({ type: "frame", pcm: out.buffer }, [out.buffer]);
            this.frame = new Int16Array(FRAME_SAMPLES);
            this.frameFill = 0;
          }
        }
      }
    }

    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
