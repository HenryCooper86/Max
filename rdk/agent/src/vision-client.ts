/**
 * Control-plane client for the Python vision sidecar.
 *
 * The transport is newline-delimited JSON over a unix socket, deliberately
 * bidirectional: requests carry an `id` and get exactly one response with the
 * same `id`, while the sidecar may also push unsolicited messages carrying
 * `event`. That second channel is how a future BPU ADAS loop will report
 * hazards without redrawing this boundary.
 *
 * Preview frames never travel here — the sidecar serves those as MJPEG over
 * local HTTP, straight to the dev HUD, so this socket stays small and readable.
 */

export type VisionStatus = "ok" | "failed" | "denied" | "unsupported";

export type VisionRequest = {
  id: string;
  op: string;
  args: Record<string, unknown>;
};

export type VisionResponse = {
  id: string;
  status: VisionStatus;
  reason?: string;
  detail?: string;
};

export type VisionEvent = {
  event: string;
  [key: string]: unknown;
};

export type VisionClientOptions = {
  send(line: string): void;
  onEvent(event: VisionEvent): void;
  /** Must stay below the relay's DEVICE_RESULT_TIMEOUT_MS (8 s) so we always
   *  answer the relay ourselves rather than letting it time us out. */
  timeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

export type VisionClient = {
  request(op: string, args?: Record<string, unknown>): Promise<VisionResponse>;
  handleChunk(chunk: string): void;
  failAllPending(reason: string): void;
};

export function encodeRequest(request: VisionRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function isVisionResponse(message: VisionResponse | VisionEvent): message is VisionResponse {
  return typeof (message as VisionResponse).id === "string";
}

/**
 * Splits a byte stream into JSON messages. A malformed line is skipped rather
 * than thrown: one bad frame from the sidecar must not take the voice path down.
 */
export function createLineDecoder(): (chunk: string) => (VisionResponse | VisionEvent)[] {
  let buffer = "";
  return (chunk: string): (VisionResponse | VisionEvent)[] => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    const messages: (VisionResponse | VisionEvent)[] = [];
    for (const part of parts) {
      const line = part.trim();
      if (line === "") continue;
      try {
        messages.push(JSON.parse(line) as VisionResponse | VisionEvent);
      } catch {
        // Skip: a corrupt line is not worth dropping the connection over.
      }
    }
    return messages;
  };
}

const DEFAULT_TIMEOUT_MS = 6_000;

export function createVisionClient(options: VisionClientOptions): VisionClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const decode = createLineDecoder();

  type Pending = {
    resolve(response: VisionResponse): void;
    timer: ReturnType<typeof setTimeout>;
  };
  const pending = new Map<string, Pending>();
  let counter = 0;

  function settle(id: string, response: VisionResponse): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimer(entry.timer);
    entry.resolve(response);
  }

  return {
    request(op: string, args: Record<string, unknown> = {}): Promise<VisionResponse> {
      counter += 1;
      const id = `v${counter}`;
      return new Promise<VisionResponse>((resolve) => {
        const timer = setTimer(() => {
          settle(id, { id, status: "failed", reason: "capture.failed" });
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        options.send(encodeRequest({ id, op, args }));
      });
    },

    handleChunk(chunk: string): void {
      for (const message of decode(chunk)) {
        if (isVisionResponse(message)) {
          settle(message.id, message);
        } else {
          options.onEvent(message);
        }
      }
    },

    failAllPending(reason: string): void {
      for (const id of [...pending.keys()]) {
        settle(id, { id, status: "failed", reason });
      }
    }
  };
}
