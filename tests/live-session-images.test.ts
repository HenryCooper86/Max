/* eslint-disable @typescript-eslint/no-explicit-any -- relay events are inspected structurally */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_CAPABILITIES, MAX_IMAGES_PER_SESSION } from "../shared/agent";
import { assistantProfileFrom, setAssistantProfileForTests } from "../server/assistant";
import { createLogger } from "../server/logger";
import type { EngineEvents, EngineImage, VoiceEngine } from "../server/providers/live/engine";
import { createLiveProvider } from "../server/providers/live/session";
import type { ResumeState } from "../server/session-resume";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  setAssistantProfileForTests();
  vi.useRealTimers();
});

class FakeClient {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  json: Array<Record<string, any>> = [];
  send(data: string | Buffer) {
    if (typeof data === "string") this.json.push(JSON.parse(data) as Record<string, any>);
  }
  close() {
    this.readyState = 3;
  }
  ofType(type: string) {
    return this.json.filter((event) => event.type === type);
  }
}

// Distinctive, so a copy anywhere it should not be is easy to find.
const PICTURE: EngineImage = { data: "UElDVFVSRS1CWVRFUw".repeat(8), mimeType: "image/jpeg" };

async function setup(
  options: {
    engine?: Partial<VoiceEngine>;
    config?: Record<string, unknown>;
    endSession?: (reason: string) => void;
    resume?: Pick<ResumeState, "history">;
  } = {}
) {
  const client = new FakeClient();
  let events!: EngineEvents;
  const sent: Array<[EngineImage, string | undefined]> = [];
  const texts: string[] = [];
  const calls = { cancel: 0, respond: 0 };
  const said: string[] = [];
  const saved: ResumeState[] = [];
  const serverEvent = vi.fn();
  const engine: VoiceEngine = {
    responseMode: "manual-capable",
    async connect(_config, engineEvents) {
      events = engineEvents;
    },
    sendAudio() {},
    respond: () => void (calls.respond += 1),
    cancel: () => void (calls.cancel += 1),
    close() {},
    say: (text) => said.push(text),
    sendText: (text) => texts.push(text),
    sendImage: (image, text) => sent.push([image, text]),
    ...options.engine
  };
  const profile = assistantProfileFrom({ name: "Ava", device: "app", ...options.config });
  const provider = createLiveProvider(
    client as never,
    { id: "openai", label: "Test", capabilities: LIVE_CAPABILITIES, createEngine: () => engine },
    createLogger("test"),
    { serverEvent, serverAudio: vi.fn(), ttsFallback: vi.fn() },
    { profile, serverTools: () => [], connectTimeoutMs: 60_000 }
  );
  await provider.start(
    { type: "session.start", sampleRate: 16000, channels: 1, language: "en" },
    {
      sessionId: "sess-1",
      saveResume: (state) => saved.push(state),
      endSession: options.endSession,
      ...(options.resume ? { resume: options.resume as ResumeState } : {})
    }
  );
  await provider.startAudio();
  const playSaid = () => {
    events.onResponseStarted();
    events.onAgentAudio(Buffer.alloc(960));
    events.onResponseDone({ cancelled: false });
  };
  return { client, provider, playSaid, events: () => events, sent, texts, calls, said, saved, serverEvent };
}

describe("live session pictures", () => {
  it("with words, is a typed turn with the picture attached", async () => {
    const { client, provider, sent, texts } = await setup();
    await provider.imageInput!(PICTURE, "what is this?");
    expect(sent).toEqual([[PICTURE, "what is this?"]]);
    expect(texts).toEqual([]);
    const rider = client.json.filter((event) => event.type === "transcript" && event.speaker === "rider").at(-1)!;
    expect(rider).toMatchObject({ text: "what is this?", final: true });
    expect(client.ofType("status").at(-1)).toMatchObject({ state: "thinking" });
    expect(client.ofType("error")).toEqual([]);
    await provider.close();
  });

  it("with words, interrupts a reply in progress like a typed turn does", async () => {
    const { provider, events, calls, sent } = await setup();
    events().onSpeechStarted();
    events().onRiderTranscript("tell me a story", true);
    events().onResponseStarted();
    await provider.imageInput!(PICTURE, "look at this instead");
    expect(calls.cancel).toBe(1);
    expect(sent).toEqual([[PICTURE, "look at this instead"]]);
    await provider.close();
  });

  it("without words, joins the conversation silently", async () => {
    const { client, provider, sent, texts, calls, events } = await setup();
    const before = client.json.length;
    await provider.imageInput!(PICTURE);
    expect(sent).toEqual([[PICTURE, undefined]]);
    expect(texts).toEqual([]);
    expect(calls).toEqual({ cancel: 0, respond: 0 });
    // Nothing is shown as a transcript and the assistant does not start thinking.
    expect(client.json.slice(before).filter((event) => event.type === "transcript" || event.type === "status")).toEqual(
      []
    );
    // The next spoken turn goes on as usual.
    events().onSpeechStarted();
    events().onRiderTranscript("what colour is it?", true);
    expect(client.json.filter((event) => event.type === "transcript" && event.speaker === "rider")).toHaveLength(1);
    await provider.close();
  });

  it("without words, does not interrupt a reply in progress", async () => {
    const { client, provider, events, calls } = await setup();
    events().onSpeechStarted();
    events().onRiderTranscript("tell me a story", true);
    events().onResponseStarted();
    events().onAgentText("Once upon a time");
    events().onAgentAudio(Buffer.alloc(960));
    const before = client.json.length;
    await provider.imageInput!(PICTURE);
    expect(calls.cancel).toBe(0);
    expect(client.json.slice(before).filter((event) => event.type === "status")).toEqual([]);
    events().onResponseDone({ cancelled: false });
    await provider.close();
  });

  it("without words, counts as the user being there and restarts the silence clock", async () => {
    const { provider, events, said } = await setup({
      config: { conversation: { idleReminderSeconds: 10, maxIdleReminders: 2, idleReminders: ["Still with me?"] } }
    });
    events().onSpeechStarted();
    events().onRiderTranscript("hello", true);
    events().onResponseStarted();
    events().onAgentAudio(Buffer.alloc(960));
    events().onResponseDone({ cancelled: false });
    await vi.advanceTimersByTimeAsync(9_000);
    await provider.imageInput!(PICTURE);
    // Nine seconds after the picture is still inside the new silence.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(said).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(said).toEqual(["Still with me?"]);
    await provider.close();
  });

  it("says so, and does nothing else, when the engine cannot take pictures", async () => {
    const { client, provider, texts, calls } = await setup({ engine: { sendImage: undefined } });
    const before = client.json.length;
    await provider.imageInput!(PICTURE, "what is this?");
    await provider.imageInput!(PICTURE);
    expect(client.json.slice(before).map((event) => event.type)).toEqual(["error", "error"]);
    expect(client.ofType("error")[0]!.message).toContain("does not take pictures");
    expect(texts).toEqual([]);
    expect(calls).toEqual({ cancel: 0, respond: 0 });
    await provider.close();
  });

  it("sends nothing after close", async () => {
    const { client, provider, sent } = await setup();
    await provider.close();
    const before = client.json.length;
    await provider.imageInput!(PICTURE, "late");
    expect(sent).toEqual([]);
    expect(client.json).toHaveLength(before);
  });
});

describe("live session picture limits", () => {
  it("refuses a picture less than a second after the last one", async () => {
    const { client, provider, sent } = await setup();
    await provider.imageInput!(PICTURE);
    await vi.advanceTimersByTimeAsync(999);
    await provider.imageInput!(PICTURE);
    expect(sent).toHaveLength(1);
    expect(client.ofType("error")).toHaveLength(1);
    expect(client.ofType("error")[0]!.message).toMatch(/one per second/);
    // The refused one did not restart the wait.
    await vi.advanceTimersByTimeAsync(1);
    await provider.imageInput!(PICTURE);
    expect(sent).toHaveLength(2);
    await provider.close();
  });

  it("holds a picture with words to the same pace", async () => {
    const { provider, sent, client } = await setup();
    await provider.imageInput!(PICTURE);
    await provider.imageInput!(PICTURE, "and this one?");
    expect(sent).toHaveLength(1);
    expect(client.ofType("error")).toHaveLength(1);
    // No typed turn was started by the refused picture.
    expect(client.json.some((event) => event.type === "transcript" && event.speaker === "rider")).toBe(false);
    await provider.close();
  });

  it(`stops at ${MAX_IMAGES_PER_SESSION} pictures in a session`, async () => {
    const { client, provider, sent } = await setup();
    for (let count = 0; count < MAX_IMAGES_PER_SESSION; count += 1) {
      await provider.imageInput!(PICTURE);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(sent).toHaveLength(MAX_IMAGES_PER_SESSION);
    expect(client.ofType("error")).toEqual([]);
    await provider.imageInput!(PICTURE, "one more");
    expect(sent).toHaveLength(MAX_IMAGES_PER_SESSION);
    expect(client.ofType("error")).toHaveLength(1);
    expect(client.ofType("error")[0]!.message).toContain(String(MAX_IMAGES_PER_SESSION));
    await provider.close();
  });
});

describe("live session keeps pictures out of records", () => {
  it("puts only a marker in the remembered history, never the picture", async () => {
    const { provider, saved, events, client, serverEvent } = await setup();
    await provider.imageInput!(PICTURE, "what is this?");
    await vi.advanceTimersByTimeAsync(1_000);
    await provider.imageInput!(PICTURE);
    events().onResponseStarted();
    events().onAgentText("A cat.");
    events().onAgentAudio(Buffer.alloc(960));
    events().onResponseDone({ cancelled: false });

    expect(saved.at(-1)!.history).toEqual([
      { speaker: "user", text: "[the user showed a picture] what is this?" },
      { speaker: "user", text: "[the user showed a picture]" },
      { speaker: "agent", text: "A cat." }
    ]);
    const everything = JSON.stringify([saved, client.json, serverEvent.mock.calls]);
    expect(everything).not.toContain(PICTURE.data);
    expect(everything).not.toContain(PICTURE.data.slice(0, 24));
    await provider.close();
  });
});

describe("a silent picture is not the user answering", () => {
  it("does not undo a goodbye the assistant already decided on", async () => {
    const ended: string[] = [];
    const { provider, events } = await setup({
      config: { conversation: { endSession: true } },
      endSession: (reason) => ended.push(reason)
    });
    events().onSpeechStarted();
    events().onRiderTranscript("bye", true);
    events().onResponseStarted();
    events().onToolCall!({ callId: "c1", name: "end_session", arguments: "{}" });
    await vi.advanceTimersByTimeAsync(0);
    await provider.imageInput!(PICTURE);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(ended).toEqual(["agent"]);
    await provider.close();
  });

  it("does not reset the count of unanswered check-ins", async () => {
    const { provider, events, said, playSaid } = await setup({
      config: { conversation: { idleReminderSeconds: 10, maxIdleReminders: 1, idleReminders: ["Still with me?"] } }
    });
    events().onSpeechStarted();
    events().onRiderTranscript("hello", true);
    playSaid();
    await vi.advanceTimersByTimeAsync(10_500);
    expect(said).toEqual(["Still with me?"]);
    playSaid();
    await provider.imageInput!(PICTURE);
    // The clock restarted, but the one check-in is still unanswered: next is the goodbye.
    await vi.advanceTimersByTimeAsync(10_500);
    expect(said).toHaveLength(2);
    expect(said[1]).toMatch(/goodbye/i);
    await provider.close();
  });
});

describe("a silent picture's note keeps history in the order the model saw", () => {
  it("waits for a user turn that is still open, then follows that turn", async () => {
    const { provider, events, saved } = await setup();
    events().onSpeechStarted();
    await provider.imageInput!(PICTURE);
    expect(saved).toEqual([]);
    events().onRiderTranscript("what colour is it?", true);
    expect(saved.at(-1)!.history).toEqual([
      { speaker: "user", text: "what colour is it?" },
      { speaker: "user", text: "[the user showed a picture]" }
    ]);
    await provider.close();
  });

  it("waits for a reply in progress, then follows the reply", async () => {
    const { provider, events, saved } = await setup();
    events().onSpeechStarted();
    events().onRiderTranscript("tell me a story", true);
    events().onResponseStarted();
    events().onAgentText("Once upon a time");
    events().onAgentAudio(Buffer.alloc(960));
    await provider.imageInput!(PICTURE);
    expect(saved.at(-1)!.history).toEqual([{ speaker: "user", text: "tell me a story" }]);
    events().onResponseDone({ cancelled: false });
    expect(saved.at(-1)!.history).toEqual([
      { speaker: "user", text: "tell me a story" },
      { speaker: "agent", text: "Once upon a time" },
      { speaker: "user", text: "[the user showed a picture]" }
    ]);
    await provider.close();
  });
});

describe("live session video", () => {
  const frame = (name: string): EngineImage => ({ data: `RlJBTUUt${name}`.repeat(6), mimeType: "image/jpeg" });

  async function video(config?: Record<string, unknown>, resume?: Pick<ResumeState, "history">) {
    const frames: Array<EngineImage | undefined> = [];
    const session = await setup({ engine: { sendVideoFrame: (image) => void frames.push(image) }, config, resume });
    return { ...session, frames };
  }

  it("gives the model each frame, and starts nothing", async () => {
    const { client, provider, frames, sent, texts, calls } = await video();
    const before = client.json.length;
    expect(await provider.videoFrame!(frame("A"))).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await provider.videoFrame!(frame("B"));
    expect(frames).toEqual([frame("A"), frame("B")]);
    // Not a picture shown, not a turn, not an interruption.
    expect(sent).toEqual([]);
    expect(texts).toEqual([]);
    expect(calls).toEqual({ cancel: 0, respond: 0 });
    expect(client.json.slice(before).filter((event) => event.type !== "session.resume")).toEqual([]);
    await provider.close();
  });

  it("drops frames that come faster than two a second, without an error", async () => {
    const { client, provider, frames } = await video();
    await provider.videoFrame!(frame("A"));
    await vi.advanceTimersByTimeAsync(200);
    await provider.videoFrame!(frame("B"));
    await vi.advanceTimersByTimeAsync(299);
    await provider.videoFrame!(frame("C"));
    await vi.advanceTimersByTimeAsync(1);
    await provider.videoFrame!(frame("D"));
    expect(frames).toEqual([frame("A"), frame("D")]);
    expect(client.ofType("error")).toEqual([]);
    await provider.close();
  });

  it("is not limited to fifty, as pictures are", async () => {
    const { client, provider, frames } = await video();
    for (let index = 0; index < MAX_IMAGES_PER_SESSION + 10; index += 1) {
      await provider.videoFrame!(frame(String(index)));
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(frames).toHaveLength(MAX_IMAGES_PER_SESSION + 10);
    expect(client.ofType("error")).toEqual([]);
    // And it does not use up the pictures.
    await provider.imageInput!(PICTURE);
    expect(client.ofType("error")).toEqual([]);
    await provider.close();
  });

  it("forgets the frame when the video stops, and when the frames stop coming", async () => {
    const { provider, frames } = await video();
    await provider.videoFrame!(frame("A"));
    await provider.videoStop!();
    expect(frames).toEqual([frame("A"), undefined]);
    // Stopped twice: said once.
    await provider.videoStop!();
    expect(frames).toHaveLength(2);
    // A client that went quiet without saying so.
    await provider.videoFrame!(frame("B"));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(frames).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toEqual([frame("A"), undefined, frame("B"), undefined]);
    // A frame keeps it alive.
    await provider.videoFrame!(frame("C"));
    await vi.advanceTimersByTimeAsync(6_000);
    await provider.videoFrame!(frame("D"));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(frames.at(-1)).toEqual(frame("D"));
    await provider.close();
  });

  it("writes into the history when the video went on and off, and never a frame", async () => {
    const { client, provider, events, saved, serverEvent } = await video();
    await provider.videoFrame!(frame("A"));
    await vi.advanceTimersByTimeAsync(1_000);
    await provider.videoFrame!(frame("B"));
    events().onSpeechStarted();
    events().onRiderTranscript("what am I holding?", true);
    events().onResponseStarted();
    events().onAgentText("A red cup.");
    events().onAgentAudio(Buffer.alloc(960));
    // While the assistant answers: written after the answer, in the order the model saw it.
    await provider.videoStop!();
    events().onResponseDone({ cancelled: false });
    expect(saved.at(-1)!.history).toEqual([
      {
        speaker: "user",
        text: "[the user turned on live video: you see what their camera or screen shows along with what they say]"
      },
      { speaker: "user", text: "what am I holding?" },
      { speaker: "agent", text: "A red cup." },
      { speaker: "user", text: "[the user turned the live video off]" }
    ]);
    const everything = JSON.stringify([saved, client.json, serverEvent.mock.calls]);
    expect(everything).not.toContain(frame("A").data.slice(0, 24));
    await provider.close();
  });

  it("does not fill the history when frames stop for a while and come back with nothing said", async () => {
    const { provider, saved } = await video();
    const on = {
      speaker: "user",
      text: "[the user turned on live video: you see what their camera or screen shows along with what they say]"
    };
    const off = { speaker: "user", text: "[the user turned the live video off]" };
    await provider.videoFrame!(frame("A"));
    // A tab in the background: no frame for a long while.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(saved.at(-1)!.history).toEqual([on, off]);
    for (let round = 0; round < 3; round += 1) {
      await provider.videoFrame!(frame(`B${round}`));
      expect(saved.at(-1)!.history).toEqual([on]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(saved.at(-1)!.history).toEqual([on, off]);
    }
    await provider.close();
  });

  it("goes on in a resumed conversation without saying again that the video is on", async () => {
    const on = {
      speaker: "user" as const,
      text: "[the user turned on live video: you see what their camera or screen shows along with what they say]"
    };
    const history = [
      on,
      { speaker: "user" as const, text: "what is this?" },
      { speaker: "agent" as const, text: "A cup." }
    ];
    const first = await video({}, { history });
    for (let second = 0; second < 3; second += 1) {
      await first.provider.videoFrame!(frame(`A${second}`));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(first.frames).toHaveLength(3);
    // Nothing new to say, so nothing was written.
    expect(first.saved).toEqual([]);
    await first.provider.close();

    // The connection came back and the video did not: after a while the conversation is told.
    const second = await video({}, { history });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(second.saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(second.saved.at(-1)!.history).toEqual([
      ...history,
      { speaker: "user", text: "[the user turned the live video off]" }
    ]);
    await second.provider.close();
  });

  it("does not keep a silent conversation alive", async () => {
    const { provider, events, said, frames } = await video({
      conversation: { idleReminderSeconds: 10, maxIdleReminders: 2, idleReminders: ["Still with me?"] }
    });
    events().onSpeechStarted();
    events().onRiderTranscript("hello", true);
    events().onResponseStarted();
    events().onAgentAudio(Buffer.alloc(960));
    events().onResponseDone({ cancelled: false });
    // A camera left on, a frame a second, and nobody saying anything.
    for (let second = 0; second < 9; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await provider.videoFrame!(frame(String(second)));
    }
    expect(said).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(said).toEqual(["Still with me?"]);
    expect(frames).toHaveLength(9);
    await provider.close();
  });

  it("is refused by a backend that cannot see, and waits while one is still connecting", async () => {
    const { provider, client } = await setup();
    expect(await provider.videoFrame!(frame("A"))).toBe(false);
    expect(client.ofType("error")).toEqual([]);
    await provider.close();
    // Closed: nothing more, and no claim about what the backend can do.
    expect(await provider.videoFrame!(frame("B"))).toBeUndefined();
  });
});
