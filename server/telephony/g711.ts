/**
 * G.711 companding and the two sample-rate conversions a phone call needs.
 * Phone networks carry 8 kHz μ-law (or A-law); the relay's clients speak PCM16
 * at 16 kHz in and 24 kHz out. Everything here is pure or holds only the small
 * amount of state a streaming filter needs, so a call can be fed in chunks of
 * any size and produce exactly what one big buffer would.
 */

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function clamp16(value: number): number {
  return value > 32767 ? 32767 : value < -32768 ? -32768 : value;
}

/** μ-law byte → linear sample. Built once; 256 entries beat per-sample maths. */
const MULAW_DECODE = new Int16Array(256);
const ALAW_DECODE = new Int16Array(256);
for (let code = 0; code < 256; code += 1) {
  const m = ~code & 0xff;
  const mantissa = m & 0x0f;
  const exponent = (m >> 4) & 0x07;
  const magnitude = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  MULAW_DECODE[code] = m & 0x80 ? -magnitude : magnitude;

  const a = code ^ 0x55;
  const segment = (a & 0x70) >> 4;
  let t = (a & 0x0f) << 4;
  if (segment === 0) t += 8;
  else {
    t += 0x108;
    t <<= segment - 1;
  }
  ALAW_DECODE[code] = a & 0x80 ? t : -t;
}

function mulawByte(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  let magnitude = sign ? -sample : sample;
  if (magnitude > MULAW_CLIP) magnitude = MULAW_CLIP;
  magnitude += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function alawByte(sample: number): number {
  let mask = 0xd5;
  let value = sample;
  if (value < 0) {
    mask = 0x55;
    value = -value - 1;
  }
  const a = Math.min(value, 32767) >> 3;
  let segment = 0;
  while (segment < 7 && a >= 0x20 << segment) segment += 1;
  const mantissa = segment < 2 ? (a >> 1) & 0x0f : (a >> segment) & 0x0f;
  return ((segment << 4) | mantissa) ^ mask;
}

function decodeWith(table: Int16Array, bytes: Buffer): Buffer {
  const out = Buffer.allocUnsafe(bytes.length * 2);
  for (let index = 0; index < bytes.length; index += 1) out.writeInt16LE(table[bytes[index] ?? 0] ?? 0, index * 2);
  return out;
}

function encodeWith(encode: (sample: number) => number, pcm16: Buffer): Buffer {
  const samples = Math.floor(pcm16.length / 2);
  const out = Buffer.allocUnsafe(samples);
  for (let index = 0; index < samples; index += 1) out[index] = encode(pcm16.readInt16LE(index * 2));
  return out;
}

/** G.711 μ-law bytes → PCM16 LE at the same rate. */
export function mulawDecode(mulaw: Buffer): Buffer {
  return decodeWith(MULAW_DECODE, mulaw);
}

/** PCM16 LE → G.711 μ-law bytes. An odd trailing byte is ignored. */
export function mulawEncode(pcm16: Buffer): Buffer {
  return encodeWith(mulawByte, pcm16);
}

/** G.711 A-law bytes → PCM16 LE at the same rate. */
export function alawDecode(alaw: Buffer): Buffer {
  return decodeWith(ALAW_DECODE, alaw);
}

/** PCM16 LE → G.711 A-law bytes. An odd trailing byte is ignored. */
export function alawEncode(pcm16: Buffer): Buffer {
  return encodeWith(alawByte, pcm16);
}

/** Joins a carried stray byte to the front of a chunk and returns whole samples plus the new stray byte. */
function withCarry(carry: Buffer, chunk: Buffer): { whole: Buffer; carry: Buffer } {
  const all = carry.length ? Buffer.concat([carry, chunk]) : chunk;
  const even = all.length - (all.length % 2);
  return { whole: all.subarray(0, even), carry: Buffer.from(all.subarray(even)) };
}

/**
 * 8 kHz → 16 kHz PCM16 by linear interpolation. Each input sample yields the
 * midpoint to the previous sample, then itself, so N samples in give 2N out and
 * the join between chunks is as smooth as a join inside one. Telephone speech
 * has no energy above 3.4 kHz, so the images linear interpolation leaves are
 * faint and sit where the codec already discards them.
 */
export class Upsampler8to16 {
  private previous = 0;
  private carry: Buffer = Buffer.alloc(0);

  process(pcm8k: Buffer): Buffer {
    const { whole, carry } = withCarry(this.carry, pcm8k);
    this.carry = carry;
    const samples = whole.length / 2;
    const out = Buffer.allocUnsafe(samples * 4);
    let previous = this.previous;
    for (let index = 0; index < samples; index += 1) {
      const current = whole.readInt16LE(index * 2);
      out.writeInt16LE(clamp16(Math.round((previous + current) / 2)), index * 4);
      out.writeInt16LE(current, index * 4 + 2);
      previous = current;
    }
    this.previous = previous;
    return out;
  }

  reset(): void {
    this.previous = 0;
    this.carry = Buffer.alloc(0);
  }
}

const DECIMATE_TAPS = 47;
const DECIMATE_CUTOFF_HZ = 3400;
const DECIMATE_INPUT_HZ = 24_000;

/** Blackman-windowed sinc, normalised to unity gain at DC. */
const DECIMATE_FIR: Float64Array = (() => {
  const taps = new Float64Array(DECIMATE_TAPS);
  const fc = DECIMATE_CUTOFF_HZ / DECIMATE_INPUT_HZ;
  const mid = (DECIMATE_TAPS - 1) / 2;
  let sum = 0;
  for (let n = 0; n < DECIMATE_TAPS; n += 1) {
    const x = n - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * n) / (DECIMATE_TAPS - 1)) +
      0.08 * Math.cos((4 * Math.PI * n) / (DECIMATE_TAPS - 1));
    const tapValue = sinc * w;
    taps[n] = tapValue;
    sum += tapValue;
  }
  for (let n = 0; n < DECIMATE_TAPS; n += 1) taps[n] = (taps[n] ?? 0) / sum;
  return taps;
})();

/**
 * 24 kHz → 8 kHz PCM16. Keeping every third sample folds everything above 4 kHz
 * back into the speech band, so the signal is low-passed below ~3.4 kHz first.
 * The filter history and the position within each group of three persist across
 * calls, so chunk boundaries cannot be heard or change the output.
 */
export class Downsampler24to8 {
  private history = new Float64Array(DECIMATE_TAPS - 1);
  private count = 0;
  private carry: Buffer = Buffer.alloc(0);

  process(pcm24k: Buffer): Buffer {
    const { whole, carry } = withCarry(this.carry, pcm24k);
    this.carry = carry;
    const samples = whole.length / 2;
    const lead = DECIMATE_TAPS - 1;
    const window = new Float64Array(lead + samples);
    window.set(this.history);
    for (let index = 0; index < samples; index += 1) window[lead + index] = whole.readInt16LE(index * 2);
    const out: number[] = [];
    for (let index = 0; index < samples; index += 1) {
      if ((this.count + index) % 3 !== 2) continue;
      let acc = 0;
      for (let tap = 0; tap < DECIMATE_TAPS; tap += 1)
        acc += (DECIMATE_FIR[tap] ?? 0) * (window[lead + index - tap] ?? 0);
      out.push(clamp16(Math.round(acc)));
    }
    this.count = (this.count + samples) % 3;
    this.history = window.slice(samples);
    const buffer = Buffer.allocUnsafe(out.length * 2);
    out.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
    return buffer;
  }

  reset(): void {
    this.history = new Float64Array(DECIMATE_TAPS - 1);
    this.count = 0;
    this.carry = Buffer.alloc(0);
  }
}
