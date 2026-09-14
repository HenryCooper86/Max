import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";

/** Synthesize exact, trusted text with the same realtime speaker as MAX.
 * A separate text-only session keeps navigation outside conversational wake-word
 * and fabrication gates. Never falls back to a different system voice. */
export function synthesizeMaxSpeech(options: {
  text: string;
  url: string;
  headers: Record<string, string | undefined>;
  config: unknown;
  pack: (event: number, sessionId?: string, metadata?: unknown) => Buffer;
  parse: (raw: RawData) => { event: number; payload: Buffer; errorCode?: number };
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<Buffer | null> {
  if (options.signal.aborted || !options.text.trim()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const sessionId = randomUUID();
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const socket = new WebSocket(options.url, { headers: options.headers, handshakeTimeout: 5_000 });
    const finish = (pcm: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      socket.close();
      resolve(pcm);
    };
    const abort = () => finish(null);
    const timer = setTimeout(abort, options.timeoutMs ?? 8_000);
    options.signal.addEventListener("abort", abort, { once: true });
    socket.on("open", () => {
      if (!settled) socket.send(options.pack(1));
    });
    socket.on("message", (raw) => {
      if (settled) return;
      try {
        const frame = options.parse(raw);
        if (frame.errorCode !== undefined || [51, 153, 599].includes(frame.event)) return finish(null);
        if (frame.event === 50) socket.send(options.pack(100, sessionId, options.config));
        if (frame.event === 150) {
          // SayHello accepts exact text on a fresh session. ChatTTSText (500)
          // is silently ignored until a conversational turn has completed.
          socket.send(options.pack(300, sessionId, { content: options.text }));
        }
        if (frame.event === 352) {
          bytes += frame.payload.length;
          // Bound memory to 30 seconds of 24 kHz mono PCM16.
          if (bytes > 1_440_000 || frame.payload.length % 2 !== 0) return finish(null);
          chunks.push(frame.payload);
        }
        if (frame.event === 359) finish(bytes ? Buffer.concat(chunks) : null);
      } catch {
        finish(null);
      }
    });
    socket.on("error", abort);
    socket.on("close", abort);
  });
}
