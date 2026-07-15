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
    this.readPos = 0;
    this.pending = new Float32Array(0);
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
    for (let i = 0; i < channel.length; i += 1) sumSquares += channel[i] * channel[i];
    const rms = Math.sqrt(sumSquares / channel.length);
    this.qualityBlocks += 1;
    if (rms < 0.005) this.silentBlocks += 1;
    if (channel.some((sample) => Math.abs(sample) >= 0.98)) this.clippedBlocks += 1;
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

    // Append this render quantum to the pending input buffer.
    const merged = new Float32Array(this.pending.length + channel.length);
    merged.set(this.pending);
    merged.set(channel, this.pending.length);
    this.pending = merged;

    // Downsample with a box-average filter: each 16 kHz output sample is the
    // mean of the input samples its step spans. Averaging low-passes the signal
    // before decimation, so energy above 8 kHz (sibilants) no longer aliases
    // back into the band — plain point sampling (keeping every Nth sample) folds
    // it in and blurs ASR. `readPos` tracks a fractional position in `pending`;
    // we only emit once a full `ratio`-wide window is available.
    while (this.readPos + this.ratio <= this.pending.length) {
      const end = this.readPos + this.ratio;
      let sum = 0;
      let count = 0;
      for (let i = Math.floor(this.readPos); i < end; i += 1) {
        sum += this.pending[i];
        count += 1;
      }
      const sample = Math.max(-1, Math.min(1, count > 0 ? sum / count : 0));
      this.frame[this.frameFill] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.frameFill += 1;
      this.readPos = end;

      if (this.frameFill === FRAME_SAMPLES) {
        const out = this.frame.slice(0);
        this.port.postMessage({ type: "frame", pcm: out.buffer }, [out.buffer]);
        this.frameFill = 0;
      }
    }

    // Drop the consumed whole samples, keep the fractional remainder.
    const consumed = Math.floor(this.readPos);
    if (consumed > 0) {
      this.pending = this.pending.slice(consumed);
      this.readPos -= consumed;
    }

    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
