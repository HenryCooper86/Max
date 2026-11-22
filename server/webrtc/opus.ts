/**
 * Opus for the WebRTC transport, on the WebAssembly build of libopus that the
 * `opusscript` package carries.
 *
 * Only the package's compiled module is used. Its JavaScript wrapper places
 * its buffers at twice the address it allocated and keeps views of the heap
 * that go stale when the heap grows, so it breaks once a few dozen codecs
 * exist at the same time. Here every codec shares one set of buffers (a call
 * is synchronous, so two never overlap) and the heap is looked up on each
 * call.
 *
 * The compiled module takes and returns PCM in an odd form: one byte of PCM16
 * in each 16-bit slot. That is its interface, not a choice made here.
 */

/** The longest frame libopus handles: 60 ms at 48 kHz. */
const MAX_FRAME_SAMPLES = 2880;
const MAX_PCM_BYTES = MAX_FRAME_SAMPLES * 2;
/** The largest Opus packet: three frames of 1276 bytes. */
export const MAX_OPUS_PACKET_BYTES = 1276 * 3;
/** OPUS_APPLICATION_VOIP: tuned for speech. */
const APPLICATION_VOIP = 2048;

type Handler = {
  _encode(input: number, bytes: number, output: number, frameSamples: number): number;
  _decode(input: number, bytes: number, output: number): number;
  _encoder_ctl(request: number, value: number): number;
};

type Native = {
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
  _malloc(bytes: number): number;
  OpusScriptHandler: {
    new (rate: number, channels: number, application: number): Handler;
    destroy_handler(handler: Handler): void;
  };
};

/** An Opus encoder and decoder for one direction of one call, mono. */
export type OpusCodec = {
  /** One frame of PCM16 in, one Opus packet out. The packet is the caller's own copy. */
  encode(pcm: Buffer, frameSamples: number): Buffer;
  /** One Opus packet in, PCM16 at this codec's rate out. The audio is the caller's own copy. */
  decode(packet: Buffer): Buffer;
  /** A libopus encoder request, such as turning on in-band error correction. */
  encoderCTL(request: number, value: number): void;
  delete(): void;
};

export type OpusFactory = (rate: number) => OpusCodec;

const ERRORS: Record<string, string> = {
  "-1": "bad argument",
  "-2": "buffer too small",
  "-3": "internal error",
  "-4": "invalid packet",
  "-5": "unimplemented",
  "-6": "invalid state",
  "-7": "out of memory"
};

/** Loads libopus and returns a maker of codecs. Rejects when the package is not installed. */
export async function loadOpus(): Promise<OpusFactory> {
  const imported = await import("opusscript/build/opusscript_native_wasm.js");
  const native = imported.default() as Native;
  // Allocated once and never freed: every codec of this process uses them.
  const pcmIn = native._malloc(MAX_PCM_BYTES * 2);
  const pcmOut = native._malloc(MAX_PCM_BYTES * 2);
  const opusIn = native._malloc(MAX_OPUS_PACKET_BYTES);
  const opusOut = native._malloc(MAX_OPUS_PACKET_BYTES);
  if (!pcmIn || !pcmOut || !opusIn || !opusOut) throw new Error("libopus could not allocate its buffers");

  return (rate) => {
    let handler: Handler | undefined = new native.OpusScriptHandler(rate, 1, APPLICATION_VOIP);
    const live = (): Handler => {
      if (!handler) throw new Error("the codec was deleted");
      return handler;
    };
    return {
      encode(pcm, frameSamples) {
        if (pcm.length !== frameSamples * 2 || pcm.length > MAX_PCM_BYTES) throw new Error("not one frame of PCM16");
        const current = live();
        const slots = native.HEAPU16;
        const base = pcmIn >> 1;
        for (let i = 0; i < pcm.length; i += 1) slots[base + i] = pcm[i] as number;
        const length = current._encode(pcmIn, pcm.length, opusOut, frameSamples);
        if (length < 0) throw new Error(`Opus encode: ${ERRORS[String(length)] ?? length}`);
        // The heap may have moved during the call: read the packet from where it is now.
        return Buffer.from(native.HEAPU8.subarray(opusOut, opusOut + length));
      },
      decode(packet) {
        if (packet.length === 0 || packet.length > MAX_OPUS_PACKET_BYTES) throw new Error("not an Opus packet");
        const current = live();
        native.HEAPU8.set(packet, opusIn);
        const samples = current._decode(opusIn, packet.length, pcmOut);
        if (samples < 0) throw new Error(`Opus decode: ${ERRORS[String(samples)] ?? samples}`);
        const bytes = Math.min(samples * 2, MAX_PCM_BYTES);
        const pcm = Buffer.allocUnsafe(bytes);
        const slots = native.HEAPU16;
        const base = pcmOut >> 1;
        for (let i = 0; i < bytes; i += 1) pcm[i] = slots[base + i] as number;
        return pcm;
      },
      encoderCTL(request, value) {
        const result = live()._encoder_ctl(request, value);
        if (result < 0) throw new Error(`Opus encoder request ${request}: ${ERRORS[String(result)] ?? result}`);
      },
      delete() {
        if (!handler) return;
        native.OpusScriptHandler.destroy_handler(handler);
        handler = undefined;
      }
    };
  };
}
