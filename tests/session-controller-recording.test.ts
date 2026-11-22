import { describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "../server/providers/types";
import { AgentSessionController, type SessionRecording } from "../server/session-controller";

// Where a recording listens in a session: the microphone audio the backend is
// given, the assistant's audio on its way to the client, and the events on
// which the client throws away speech it has not played.

async function session(
  recording: SessionRecording,
  state: { open: boolean } = { open: true },
  recordingClient?: "phone"
) {
  const toClient: unknown[] = [];
  const client = {
    get readyState() {
      return state.open ? 1 : 3;
    },
    OPEN: 1,
    send: vi.fn((data: unknown) => toClient.push(data)),
    close: vi.fn()
  } as never;
  let backend!: { send(data: unknown): void };
  const heard: Buffer[] = [];
  const controller = new AgentSessionController(
    client,
    (socket) => {
      backend = socket as unknown as typeof backend;
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
    { deviceRegistrationAuthorized: false, recording, ...(recordingClient ? { recordingClient } : {}) }
  );
  const send = (event: unknown) => controller.handleMessage(Buffer.from(JSON.stringify(event)), false);
  await send({ type: "session.start", sampleRate: 16000, channels: 1 });
  await send({ type: "audio.start" });
  return { controller, backend, heard, toClient };
}

function recorder() {
  const log: Array<[string, number?]> = [];
  const recording: SessionRecording = {
    user: (pcm) => void log.push(["user", pcm.length]),
    agent: (pcm) => void log.push(["agent", pcm.length]),
    agentCleared: () => void log.push(["cleared"])
  };
  return { log, recording };
}

describe("recording in a session", () => {
  it("hears the user's audio, the assistant's audio and each interruption, in order", async () => {
    const { log, recording } = recorder();
    const { controller, backend, heard, toClient } = await session(recording);
    await controller.handleMessage(Buffer.alloc(640, 1), true);
    backend.send(Buffer.alloc(960, 2));
    backend.send(new Uint8Array(480));
    backend.send(JSON.stringify({ type: "status", state: "speaking" }));
    backend.send(JSON.stringify({ type: "transcript", speaker: "agent", text: "Hello", final: true }));
    backend.send(JSON.stringify({ type: "status", state: "hearing" }));
    backend.send(JSON.stringify({ type: "transcript", speaker: "rider", text: "Wait", final: false }));
    expect(log).toEqual([["user", 640], ["agent", 960], ["agent", 480], ["cleared"], ["cleared"]]);
    // Nothing is held back or changed on the way: the backend and the client get what they would without it.
    expect(heard).toHaveLength(1);
    expect(heard[0]!.equals(Buffer.alloc(640, 1))).toBe(true);
    expect(toClient.filter((data) => typeof data !== "string")).toHaveLength(2);
    // The five events above, after the session's own announcement.
    expect(toClient.filter((data) => typeof data === "string")).toHaveLength(6);
    await controller.close();
  });

  it("goes by what a phone call does: speech is dropped only when the caller starts to speak", async () => {
    const { log, recording } = recorder();
    const { controller, backend } = await session(recording, { open: true }, "phone");
    backend.send(Buffer.alloc(960, 2));
    // A late transcript of what the caller said before does not stop the phone playing.
    backend.send(JSON.stringify({ type: "status", state: "asr" }));
    backend.send(JSON.stringify({ type: "transcript", speaker: "rider", text: "Hello", final: true }));
    expect(log).toEqual([["agent", 960]]);
    backend.send(JSON.stringify({ type: "status", state: "hearing" }));
    expect(log).toEqual([["agent", 960], ["cleared"]]);
    await controller.close();
  });

  it("does not record speech sent after the client has gone", async () => {
    const { log, recording } = recorder();
    const state = { open: true };
    const { controller, backend } = await session(recording, state);
    state.open = false;
    backend.send(Buffer.alloc(960));
    expect(log).toEqual([]);
    await controller.close();
  });

  it("never lets a failing recording touch the conversation", async () => {
    const broken: SessionRecording = {
      user: () => {
        throw new Error("disk");
      },
      agent: () => {
        throw new Error("disk");
      },
      agentCleared: () => {
        throw new Error("disk");
      }
    };
    const { controller, backend, heard, toClient } = await session(broken);
    await controller.handleMessage(Buffer.alloc(640), true);
    backend.send(Buffer.alloc(960));
    backend.send(JSON.stringify({ type: "status", state: "hearing" }));
    expect(heard).toHaveLength(1);
    expect(toClient.filter((data) => typeof data !== "string")).toHaveLength(1);
    expect(toClient.at(-1)).toBe(JSON.stringify({ type: "status", state: "hearing" }));
    await controller.close();
  });
});
