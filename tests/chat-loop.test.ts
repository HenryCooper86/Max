/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies and recorded events are inspected structurally */
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../server/logger";
import { createChatLoop, type ChatLoop, type Speaker } from "../server/providers/live/chat-loop";
import type { EngineEvents } from "../server/providers/live/engine";

const log = createLogger({ level: "silent" } as never);

const sseOf = (chunks: unknown[]) =>
  new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200
  });
const text = (content: string) => ({ choices: [{ delta: { content } }] });
const toolPiece = (piece: Record<string, unknown>) => ({ choices: [{ delta: { tool_calls: [piece] } }] });

function setup(
  replies: Array<() => Response>,
  speakerParts: Partial<Speaker> = {},
  stageParts: { reasoningEffort?: string } = {}
) {
  const chats: any[] = [];
  const seen: string[] = [];
  const deltas: string[] = [];
  const sentences: string[] = [];
  const toolCalls: string[] = [];
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
    chats.push(JSON.parse(init!.body as string));
    return replies[chats.length - 1]!();
  });
  const events = {
    onResponseStarted: () => seen.push("start"),
    onAgentText: (delta: string) => seen.push(`text:${delta}`),
    onResponseDone: ({ cancelled }: { cancelled: boolean }) => seen.push(`done:${cancelled}`),
    onError: (message: string) => seen.push(`error:${message}`),
    onToolCall: (call: { callId: string }) => toolCalls.push(call.callId)
  } as unknown as EngineEvents;
  const loop: ChatLoop = createChatLoop({
    log,
    request: request as never,
    label: "test",
    stage: () => ({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "m", ...stageParts }),
    events: () => events,
    tools: () => [{ name: "lookup", description: "d", parameters: { type: "object", properties: {} } } as never],
    instructions: () => "Be brief.",
    closed: () => false,
    newSpeaker: () => ({
      delta: (piece) => deltas.push(piece),
      sentence: (sentence) => sentences.push(sentence),
      finish: async () => undefined,
      ...speakerParts
    })
  });
  return { loop, chats, seen, deltas, sentences, toolCalls, request };
}

describe("chat loop", () => {
  it("delivers raw deltas and finished sentences in order", async () => {
    const { loop, seen, deltas, sentences, chats } = setup([
      () => sseOf([text("Hi th"), text("ere. How"), text(" are you")])
    ]);
    await loop.reply("hello");
    expect(deltas).toEqual(["Hi th", "ere. How", " are you"]);
    // The unfinished tail is flushed when the stream ends.
    expect(sentences).toEqual(["Hi there.", "How are you"]);
    expect(seen).toEqual(["start", "text:Hi th", "text:ere. How", "text: are you", "done:false"]);
    expect(chats[0].messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hello" }
    ]);
  });

  it("sends reasoning_effort only for a stage that sets it", async () => {
    const plain = setup([() => sseOf([text("Hi.")])]);
    await plain.loop.reply("x");
    expect(plain.chats[0]).not.toHaveProperty("reasoning_effort");

    const local = setup([() => sseOf([text("Hi.")])], {}, { reasoningEffort: "none" });
    await local.loop.reply("x");
    expect(local.chats[0].reasoning_effort).toBe("none");
  });

  it("answers without reasoning_effort when the server refuses it, and stops sending it", async () => {
    const refused = () =>
      new Response(JSON.stringify({ error: { message: '"m" does not support thinking' } }), { status: 400 });
    const { loop, chats, sentences, seen } = setup(
      [refused, () => sseOf([text("First.")]), () => sseOf([text("Second.")])],
      {},
      { reasoningEffort: "low" }
    );
    await loop.reply("one");
    await loop.reply("two");
    expect(chats.map((chat) => chat.reasoning_effort)).toEqual(["low", undefined, undefined]);
    expect(sentences).toEqual(["First.", "Second."]);
    expect(seen.some((entry) => entry.startsWith("error:"))).toBe(false);
  });

  it("does not retry a 400 that has nothing to do with reasoning", async () => {
    const { loop, chats, seen } = setup(
      [() => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 400 })],
      {},
      { reasoningEffort: "none" }
    );
    await loop.reply("x");
    expect(chats).toHaveLength(1);
    expect(seen.some((entry) => entry.startsWith("error:"))).toBe(true);
  });

  it("does not split sentences for a speaker that only wants deltas", async () => {
    const { loop, deltas } = setup([() => sseOf([text("One. Two.")])], { sentence: undefined });
    await loop.reply("x");
    expect(deltas).toEqual(["One. Two."]);
  });

  it("runs a tool round and keeps the tool chatter out of history", async () => {
    const { loop, chats, toolCalls, sentences, seen } = setup([
      () =>
        sseOf([
          toolPiece({ index: 0, id: "c1", function: { name: "lookup", arguments: '{"a":' } }),
          toolPiece({ index: 0, function: { arguments: "1}" } })
        ]),
      () => sseOf([text("Found it.")]),
      () => sseOf([text("Sure.")])
    ]);
    const done = loop.reply("find");
    await vi.waitFor(() => expect(toolCalls).toEqual(["c1"]));
    loop.sendToolResult("c1", "result");
    await done;
    expect(chats[1].messages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"a":1}' } }]
      },
      { role: "tool", tool_call_id: "c1", content: "result" }
    ]);
    expect(sentences).toEqual(["Found it."]);
    expect(seen.at(-1)).toBe("done:false");
    await loop.reply("again");
    expect(chats[2].messages.map((message: any) => message.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("asks again, once, when the model promises a lookup and calls nothing", async () => {
    const { loop, chats, toolCalls, sentences } = setup([
      () => sseOf([text("Let me check that for you.")]),
      () => sseOf([toolPiece({ index: 0, id: "c1", function: { name: "lookup", arguments: "{}" } })]),
      () => sseOf([text("It ships in four days.")]),
      () => sseOf([text("Sure.")])
    ]);
    const done = loop.reply("how long is shipping");
    await vi.waitFor(() => expect(toolCalls).toEqual(["c1"]));
    expect(chats[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: "Let me check that for you." },
      { role: "user", content: expect.stringContaining("Call the tool now") }
    ]);
    loop.sendToolResult("c1", "4 days");
    await done;
    expect(sentences).toEqual(["Let me check that for you.", "It ships in four days."]);
    // The nudge is the relay's own: history keeps what was said, in one piece.
    await loop.reply("thanks");
    expect(chats[3].messages.slice(1, 3)).toEqual([
      { role: "user", content: "how long is shipping" },
      { role: "assistant", content: "Let me check that for you. It ships in four days." }
    ]);
  });

  it("does not ask twice, and leaves ordinary answers and questions alone", async () => {
    const stalled = setup([() => sseOf([text("Let me check.")]), () => sseOf([text("One moment.")])]);
    await stalled.loop.reply("hours?");
    expect(stalled.chats).toHaveLength(2);

    const answers = [
      "We open at nine.",
      "Sure, let me check. Which order number is it?",
      "我们九点开门。",
      // Answers that only sound like promises.
      "I can confirm your appointment is at 3pm tomorrow.",
      "I can see why that is confusing. The fee is 5 dollars.",
      "Hold on to your receipt until the refund arrives.",
      "I will get you the refund within five days.",
      // A promise followed by the answer itself is finished.
      "Let me check. We open at nine.",
      "Let me confirm: your total is 3.5 dollars."
    ];
    for (const answer of answers) {
      const plain = setup([() => sseOf([text(answer)])]);
      await plain.loop.reply("hours?");
      expect(plain.chats).toHaveLength(1);
    }
    const promises = [
      "我帮您查一下。",
      "One moment.",
      "Hold on, please.",
      "I'll look that up.",
      "Sure! Let me pull up your order.",
      "That is 3.5 dollars. Let me check the stock.",
      "I'm going to transfer you now"
    ];
    for (const promise of promises) {
      const again = setup([() => sseOf([text(promise)]), () => sseOf([text("Done.")])]);
      await again.loop.reply("hours?");
      expect(again.chats).toHaveLength(2);
    }
  });

  it("stops deltas once the reply is stopped mid-stream", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const encoder = new TextEncoder();
    const line = (content: string) => encoder.encode(`data: ${JSON.stringify(text(content))}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(line("first. "));
        await gate;
        controller.enqueue(line("second. "));
        controller.close();
      }
    });
    const { loop, deltas, sentences, seen } = setup([() => new Response(stream, { status: 200 })]);
    const done = loop.reply("go");
    await vi.waitFor(() => expect(deltas).toEqual(["first. "]));
    expect(loop.replying).toBe(true);
    loop.stop();
    loop.endReply(true);
    release();
    await done;
    expect(deltas).toEqual(["first. "]);
    // Sentences are not gated: a stale speaker checks `current()` itself.
    expect(sentences[0]).toBe("first.");
    expect(seen.filter((entry) => entry.startsWith("done"))).toEqual(["done:true"]);
    expect(seen.some((entry) => entry.startsWith("error"))).toBe(false);
  });

  it("keeps only the latest 16 history messages, context included", async () => {
    const { loop, chats } = setup(Array.from({ length: 10 }, () => () => sseOf([text("ok")])));
    loop.addContext("note");
    for (let turn = 0; turn < 9; turn += 1) await loop.reply(`q${turn}`);
    await loop.reply("last");
    const messages = chats[9].messages;
    // System prompt, then the 16 retained messages, then the new user turn.
    expect(messages).toHaveLength(1 + 16 + 1);
    expect(messages[1]).toEqual({ role: "user", content: "q1" });
    expect(messages.some((message: any) => message.content === "note")).toBe(false);
  });

  it("says an exact line without calling the model, and reports a speaker failure with the text kept", async () => {
    const said: string[] = [];
    const { loop, request, seen } = setup([], { say: (line) => said.push(line) });
    await loop.reply(undefined, "Turn left.");
    expect(said).toEqual(["Turn left."]);
    expect(request).not.toHaveBeenCalled();
    expect(seen).toEqual(["start", "done:false"]);

    const failing = setup([() => sseOf([text("Hello.")])], {
      finish: () => Promise.reject(new Error("speech down"))
    });
    await failing.loop.reply("hi");
    expect(failing.seen).toEqual(["start", "text:Hello.", "error:speech down", "done:false"]);
  });

  it("abandons the speaker before ending a reply the model failed, and waits for it", async () => {
    let releaseAbandon!: () => void;
    const order: string[] = [];
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(text("Part. "))}\n\n`));
        setTimeout(() => controller.error(new Error("model dropped")), 10);
      }
    });
    const { loop, seen } = setup([() => new Response(failing, { status: 200 })], {
      abandon: () => {
        order.push(`abandon:${seen.at(-1)}`);
        return new Promise<void>((resolve) => (releaseAbandon = resolve));
      }
    });
    const done = loop.reply("go");
    await vi.waitFor(() => expect(order).toEqual(["abandon:error:model dropped"]));
    // Still open while the speaker finishes what it already said.
    expect(seen.some((entry) => entry.startsWith("done"))).toBe(false);
    releaseAbandon();
    await done;
    expect(seen.at(-1)).toBe("done:false");
  });
});

describe("chat loop with speech held for the session", () => {
  /** A session that reads every piece before it is spoken, and answers when the test says. */
  function setupHeld(replies: Array<() => Response>, speaker?: (sentences: string[], deltas: string[]) => Speaker) {
    const chats: any[] = [];
    const seen: string[] = [];
    const sentences: string[] = [];
    const deltas: string[] = [];
    const asked: string[] = [];
    const answers: Array<(allowed: boolean) => void> = [];
    let failing = false;
    const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
      chats.push(JSON.parse(init!.body as string));
      return replies[chats.length - 1]!();
    });
    const events = {
      onResponseStarted: () => seen.push("start"),
      onAgentText: (delta: string) => seen.push(`text:${delta}`),
      onResponseDone: ({ cancelled }: { cancelled: boolean }) => seen.push(`done:${cancelled}`),
      onError: (message: string) => seen.push(`error:${message}`),
      holdsSpeech: () => true,
      holdSpeech: (piece: string) => {
        asked.push(piece);
        if (failing) return Promise.reject(new Error("the judge is away"));
        return new Promise<boolean>((resolve) =>
          answers.push((allowed) => {
            // As the session does: it stops the reply and tells the model, then says no.
            if (!allowed) {
              loop.addContext("Your last answer broke a rule.");
              loop.stop();
            }
            resolve(allowed);
          })
        );
      }
    } as unknown as EngineEvents;
    const loop: ChatLoop = createChatLoop({
      log,
      request: request as never,
      label: "test",
      stage: () => ({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "m" }),
      events: () => events,
      tools: () => [],
      instructions: () => "Be brief.",
      closed: () => false,
      newSpeaker: () =>
        speaker?.(sentences, deltas) ?? {
          sentence: (sentence) => sentences.push(sentence),
          finish: async () => undefined
        }
    });
    const answer = async (allowed: boolean) => {
      await vi.waitFor(() => expect(answers.length).toBeGreaterThan(0));
      answers.shift()!(allowed);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    };
    return { loop, chats, seen, sentences, deltas, asked, answer, failReading: () => (failing = true) };
  }

  it("speaks and shows nothing until the session has read it, sentence by sentence", async () => {
    const h = setupHeld([() => sseOf([text("Hi th"), text("ere. How are"), text(" you? Fine.")])]);
    const done = h.loop.reply("hello");
    await vi.waitFor(() => expect(h.asked).toEqual(["Hi there."]));
    // The model has written everything, and nobody has heard or seen a word.
    expect(h.sentences).toEqual([]);
    expect(h.seen).toEqual(["start"]);
    await h.answer(true);
    expect(h.sentences).toEqual(["Hi there."]);
    // What came in during the first reading is read together, with what was said before it.
    expect(h.asked).toEqual(["Hi there.", "Hi there. How are you? Fine."]);
    await h.answer(true);
    await done;
    expect(h.sentences).toEqual(["Hi there.", "How are you?", "Fine."]);
    expect(h.seen).toEqual(["start", "text:Hi there.", "text: How are you?", "text: Fine.", "done:false"]);
    // The next turn carries what was said.
    void h.loop.reply("and you?");
    await vi.waitFor(() => expect(h.chats).toHaveLength(2));
    expect(h.chats[1].messages.slice(1, 3)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hi there. How are you? Fine." }
    ]);
  });

  it("stops at the piece the session refuses, and remembers only what was said", async () => {
    const h = setupHeld([
      () => sseOf([text("Sure. "), text("Take two of your neighbour's pills. "), text("Then rest.")]),
      () => sseOf([text("Ok.")])
    ]);
    const done = h.loop.reply("my head hurts");
    await h.answer(true);
    expect(h.sentences).toEqual(["Sure."]);
    await h.answer(false);
    await done;
    expect(h.sentences).toEqual(["Sure."]);
    expect(h.seen).toEqual(["start", "text:Sure."]);
    void h.loop.reply("ok");
    await vi.waitFor(() => expect(h.chats).toHaveLength(2));
    // The question and what was said of the answer, then the session's note: not what was held back.
    expect(h.chats[1].messages.slice(1)).toEqual([
      { role: "user", content: "my head hurts" },
      { role: "assistant", content: "Sure." },
      { role: "system", content: "Your last answer broke a rule." },
      { role: "user", content: "ok" }
    ]);
    expect(JSON.stringify(h.chats[1])).not.toContain("neighbour");
  });

  it("gives a speaker that takes deltas the text it may say", async () => {
    const h = setupHeld([() => sseOf([text("One. Two.")])], (_sentences, deltas) => ({
      delta: (piece) => deltas.push(piece),
      finish: async () => undefined
    }));
    const done = h.loop.reply("count");
    await h.answer(true);
    await h.answer(true);
    await done;
    expect(h.deltas.join("")).toBe("One. Two.");
    expect(h.asked.at(-1)).toBe("One. Two.");
  });

  it("joins sentences of a script without spaces as they were written", async () => {
    const h = setupHeld([() => sseOf([text("你好。今天天气很好。")])]);
    const done = h.loop.reply("你好");
    await h.answer(true);
    await h.answer(true);
    await done;
    expect(h.seen.filter((item) => item.startsWith("text:")).join("")).toBe("text:你好。text:今天天气很好。");
  });

  it("drops what was being read when the user speaks over it", async () => {
    const h = setupHeld([() => sseOf([text("A long answer. And more.")]), () => sseOf([text("Yes.")])]);
    void h.loop.reply("tell me");
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    h.loop.stop();
    await h.answer(true);
    expect(h.sentences).toEqual([]);
    expect(h.seen).toEqual(["start"]);
  });

  it("says the text when the session's reading fails", async () => {
    const h = setupHeld([() => sseOf([text("Hello.")])]);
    h.failReading();
    await h.loop.reply("hi");
    expect(h.asked).toEqual(["Hello."]);
    expect(h.sentences).toEqual(["Hello."]);
    expect(h.seen).toEqual(["start", "text:Hello.", "done:false"]);
  });
});

describe("chat loop pictures", () => {
  const pic = (name: string) => ({ data: name, mimeType: "image/jpeg" });
  const imagePart = (name: string) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${name}` } });
  const OLD = { type: "text", text: "[a picture the user showed earlier]" };
  const refused = () =>
    new Response('{"error":{"message":"model does not support multimodal requests"}}', { status: 400 });

  it("attaches a waiting picture to the next turn that has words, and nothing before", async () => {
    const { loop, chats } = setup([() => sseOf([text("Hi.")]), () => sseOf([text("Red.")])]);
    loop.addImage(pic("A"));
    // A line the relay says itself is not a user turn: no request, picture still waiting.
    await loop.reply(undefined, "Welcome.");
    expect(chats).toHaveLength(0);
    await loop.reply("what colour?");
    expect(chats[0].messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "what colour?" }, imagePart("A")]
    });
    // Used once: the next turn carries none of its own.
    await loop.reply("and now?");
    expect(chats[1].messages.at(-1)).toEqual({ role: "user", content: "and now?" });
  });

  it("holds only the two latest waiting pictures", async () => {
    const { loop, chats } = setup([() => sseOf([text("Ok.")])]);
    for (const name of ["A", "B", "C"]) loop.addImage(pic(name));
    await loop.reply("look");
    expect(chats[0].messages.at(-1).content).toEqual([{ type: "text", text: "look" }, imagePart("B"), imagePart("C")]);
  });

  it("resends at most the two most recent pictures and notes the older ones", async () => {
    const { loop, chats } = setup([1, 2, 3, 4].map(() => () => sseOf([text("Ok.")])));
    for (const [name, words] of [
      ["A", "one"],
      ["B", "two"],
      ["C", "three"],
      ["D", "four"]
    ] as const) {
      loop.addImage(pic(name));
      await loop.reply(words);
    }
    const userContents = (index: number) =>
      chats[index].messages.filter((message: any) => message.role === "user").map((message: any) => message.content);
    expect(userContents(2)).toEqual([
      [{ type: "text", text: "one" }, OLD],
      [{ type: "text", text: "two" }, imagePart("B")],
      [{ type: "text", text: "three" }, imagePart("C")]
    ]);
    expect(userContents(3)).toEqual([
      [{ type: "text", text: "one" }, OLD],
      [{ type: "text", text: "two" }, OLD],
      [{ type: "text", text: "three" }, imagePart("C")],
      [{ type: "text", text: "four" }, imagePart("D")]
    ]);
  });

  it("drops the pictures when a request that carried one fails, so later turns still work", async () => {
    const { loop, chats, seen } = setup([() => sseOf([text("Fine.")]), refused, () => sseOf([text("Four.")])]);
    loop.addImage(pic("A"));
    await loop.reply("first");
    loop.addImage(pic("B"));
    await loop.reply("what colour?");
    expect(seen.some((entry) => entry.startsWith("error:"))).toBe(true);

    await loop.reply("what is 2+2?");
    expect(JSON.stringify(chats[2].messages)).not.toContain("image_url");
    expect(chats[2].messages.map((message: any) => message.content)).toEqual([
      "Be brief.",
      [{ type: "text", text: "first" }, OLD],
      "Fine.",
      "what is 2+2?"
    ]);
  });

  it("keeps text history when a request without pictures fails", async () => {
    const { loop, chats } = setup([
      () => sseOf([text("Fine.")]),
      () => new Response("nope", { status: 500 }),
      () => sseOf([text("Ok.")])
    ]);
    await loop.reply("first");
    await loop.reply("second");
    await loop.reply("third");
    expect(chats[2].messages.map((message: any) => message.content)).toEqual(["Be brief.", "first", "Fine.", "third"]);
  });

  it("also drops an older picture when a later request that still carried it fails", async () => {
    const { loop, chats } = setup([
      () => sseOf([text("Fine.")]),
      () => new Response("nope", { status: 500 }),
      () => sseOf([text("Ok.")])
    ]);
    loop.addImage(pic("A"));
    await loop.reply("first");
    // The picture is still in the history this request resends, and it may be why it failed.
    await loop.reply("second");
    await loop.reply("third");
    expect(chats[2].messages[1].content).toEqual([{ type: "text", text: "first" }, OLD]);
  });

  it("keeps a picture for the next turn when the turn that carried it was cut off", async () => {
    const { loop, chats, request } = setup([() => sseOf([text("Red.")])]);
    request.mockImplementationOnce(async (_url: unknown, init?: RequestInit) => {
      // A reply that never finishes by itself: only the barge-in ends it.
      const body = new ReadableStream({
        start(controller) {
          init!.signal!.addEventListener("abort", () => controller.error(new Error("aborted")));
        }
      });
      return new Response(body, { status: 200 });
    });
    loop.addImage(pic("A"));
    const first = loop.reply("what colour?");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    loop.stop();
    await first;

    await loop.reply("I mean the picture I just showed");
    expect(chats[0].messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "I mean the picture I just showed" }, imagePart("A")]
    });
  });

  it("does not bring a picture back after its request failed", async () => {
    const { loop, chats } = setup([refused, () => sseOf([text("Ok.")])]);
    loop.addImage(pic("A"));
    await loop.reply("what colour?");
    await loop.reply("hello");
    expect(JSON.stringify(chats[1].messages)).not.toContain("image_url");
  });

  it("removes picture data a vendor echoes in an error before it is reported", async () => {
    const b64 = "/9j/4AAQSkZJRgABAQAAAQABAAD".repeat(4);
    const echoed = () =>
      new Response(`{"error":{"message":"bad image data:image/jpeg;base64,${b64} and raw ${b64} end"}}`, {
        status: 400
      });
    const { loop, seen } = setup([echoed]);
    loop.addImage(pic("A"));
    await loop.reply("what colour?");
    const reported = seen.find((entry) => entry.startsWith("error:"))!;
    expect(reported).toContain("Chat model HTTP 400");
    expect(reported).toContain("[data]");
    expect(reported).not.toContain("/9j/4AAQ");
    expect(reported).not.toMatch(/[A-Za-z0-9+/=_-]{40,}/);
  });
});
