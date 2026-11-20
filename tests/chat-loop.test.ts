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

function setup(replies: Array<() => Response>, speakerParts: Partial<Speaker> = {}) {
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
    stage: () => ({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "m" }),
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
