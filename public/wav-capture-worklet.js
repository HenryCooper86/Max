// AudioWorklet processor for recording voice-cloning references. Unlike
// pcm-worklet.js (which box-averages the live mic down to 16 kHz), this passes
// the first channel through at the AudioContext's own rate and leaves any
// resampling to the speech server. Samples go to the main thread in blocks.

const BLOCK_SAMPLES = 4096;

class WavCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK_SAMPLES);
    this.fill = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.block[this.fill] = channel[i];
      this.fill += 1;
      if (this.fill === BLOCK_SAMPLES) {
        const out = this.block;
        this.port.postMessage({ type: "samples", samples: out }, [out.buffer]);
        this.block = new Float32Array(BLOCK_SAMPLES);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor("wav-capture", WavCaptureProcessor);
