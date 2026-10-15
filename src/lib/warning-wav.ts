/** Decode only our bundled mono 24 kHz PCM16 WAV format. Platform media
 * decoders can normalize/resample PCM differently; match the provider's exact
 * signed-16 → float conversion so safety clips preserve their original samples. */
export function decodeWarningWav(context: AudioContext, bytes: ArrayBuffer, expectedSamples: number): AudioBuffer {
  const invalid = () => new Error("Invalid safety warning WAV");
  if (bytes.byteLength < 12 || !Number.isSafeInteger(expectedSamples) || expectedSamples <= 0) throw invalid();
  const view = new DataView(bytes);
  const tag = (at: number) => String.fromCharCode(...new Uint8Array(bytes, at, 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.byteLength) throw invalid();
  let format = false;
  let dataAt: number | undefined;
  let dataLength = 0;
  for (let at = 12; at < bytes.byteLength;) {
    if (at + 8 > bytes.byteLength) throw invalid();
    const kind = tag(at);
    const length = view.getUint32(at + 4, true);
    const start = at + 8;
    const end = start + length;
    const next = end + (length % 2);
    if (next > bytes.byteLength) throw invalid();
    if (kind === "fmt ") {
      if (
        format ||
        length < 16 ||
        view.getUint16(start, true) !== 1 ||
        view.getUint16(start + 2, true) !== 1 ||
        view.getUint32(start + 4, true) !== 24000 ||
        view.getUint32(start + 8, true) !== 48000 ||
        view.getUint16(start + 12, true) !== 2 ||
        view.getUint16(start + 14, true) !== 16
      )
        throw invalid();
      format = true;
    } else if (kind === "data") {
      if (dataAt !== undefined) throw invalid();
      dataAt = start;
      dataLength = length;
    }
    at = next;
  }
  if (!format || dataAt === undefined || dataLength !== expectedSamples * 2 || context.state === "closed")
    throw invalid();
  const buffer = context.createBuffer(1, expectedSamples, 24000);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < expectedSamples; index += 1)
    channel[index] = view.getInt16(dataAt + index * 2, true) / 32768;
  return buffer;
}
