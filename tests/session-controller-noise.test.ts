import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadNoiseSuppression } from "../server/noise-suppression";
import type { AgentProvider } from "../server/providers/types";
import { AgentSessionController, type AgentSessionHooks } from "../server/session-controller";

// Where the relay's noise suppression sits in a session: between the client's
// microphone audio and whatever backend the session runs on.

async function session(hooks: AgentSessionHooks) {
  const heard: Buffer[] = [];
  const client = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never;
  const controller = new AgentSessionController(
    client,
    (socket) => {
      const provider: AgentProvider = {
        start: async () => {
          socket.send(JSON.stringify({ type: "session.started", provider: "x", mode: "live", capabilities: {} }));
        },
        startAudio: async () => undefined,
        sendAudio: async (pcm) => {
          heard.push(Buffer.from(pcm));
        },
        stopAudio: async () => undefined,
        close: async () => undefined
      };
      return provider;
    },
    undefined,
    "127.0.0.1",
    undefined,
    undefined,
    hooks
  );
  const send = (event: unknown) => controller.handleMessage(Buffer.from(JSON.stringify(event)), false);
  await send({ type: "session.start", sampleRate: 16000, channels: 1 });
  await send({ type: "audio.start" });
  return { controller, heard };
}

/** 20 ms of loud, steady noise at 16 kHz. */
function noiseFrame(seed: number): Buffer {
  const frame = Buffer.alloc(640);
  let state = seed;
  for (let i = 0; i < 320; i += 1) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    frame.writeInt16LE(Math.round((state / 0x7fffffff - 0.5) * 8000), i * 2);
  }
  return frame;
}

const level = (frames: Buffer[]) => {
  const all = Buffer.concat(frames);
  let sum = 0;
  for (let i = 0; i < all.length; i += 2) sum += all.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (all.length / 2));
};

describe("noise suppression in a session", () => {
  beforeAll(async () => {
    expect(await loadNoiseSuppression()).toBe(true);
  });

  it("passes the microphone through untouched when it is not asked for", async () => {
    const { controller, heard } = await session({ deviceRegistrationAuthorized: false });
    const frame = noiseFrame(1);
    await controller.handleMessage(frame, true);
    expect(heard).toHaveLength(1);
    expect(heard[0]!.equals(frame)).toBe(true);
    await controller.close();
  });

  it("cleans the microphone before the backend hears it, frame for frame", async () => {
    const { controller, heard } = await session({ deviceRegistrationAuthorized: false, noiseSuppression: true });
    const sent: Buffer[] = [];
    for (let i = 0; i < 150; i += 1) {
      const frame = noiseFrame(i + 1);
      sent.push(frame);
      await controller.handleMessage(frame, true);
    }
    // The backend still gets one frame for each one sent, of the same size.
    expect(heard).toHaveLength(150);
    expect(heard.every((frame) => frame.length === 640)).toBe(true);
    // After the first second, the steady noise is all but gone.
    expect(level(heard.slice(50))).toBeLessThan(level(sent.slice(50)) / 10);
    await controller.close();
  });

  it("sends nothing on for a piece too short to clean, and catches up with the next", async () => {
    const { controller, heard } = await session({ deviceRegistrationAuthorized: false, noiseSuppression: true });
    await controller.handleMessage(Buffer.alloc(100), true);
    expect(heard).toHaveLength(0);
    await controller.handleMessage(Buffer.alloc(540), true);
    expect(heard.map((frame) => frame.length)).toEqual([640]);
    await controller.close();
  });
});
