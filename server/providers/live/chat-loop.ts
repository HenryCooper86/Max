import type { Logger } from "../../logger";
import { forFastLocalModel } from "../../prompts";
import type { ToolSpec } from "../../tools";
import type { EngineEvents } from "./engine";

/**
 * The chat-model half of a cascaded voice engine: streaming chat completions
 * over SSE, tool-call rounds, conversation history, and the generation/abort
 * rules that make a barge-in drop a reply cleanly. What happens to the words —
 * synthesizing them over HTTP, or streaming them to a speech server — is the
 * engine's own, supplied as a `Speaker`.
 */

export type ChatStage = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Sent as `reasoning_effort`. Local voice replies use "none": a hidden thinking step delays every answer. */
  reasoningEffort?: string;
};

/** Where one reply's text goes. Created per reply, so it can hold that reply's state.
 *  Only `delta` is gated on the reply still being current; `sentence` and `say`
 *  are not, so a speaker drops stale work itself with `SpeakerContext.current`. */
export type Speaker = {
  /** Every text delta as the model writes it, for speakers that chunk text themselves. */
  delta?(text: string): void;
  /** Each finished sentence. Splitting only happens when this is set. */
  sentence?(text: string): void;
  /** A relay-composed line to say verbatim. Falls back to `sentence`. */
  say?(text: string): void;
  /** All text has been handed over; resolves once the audio has been delivered.
   *  A rejection ends the reply as a failure, keeping the text that arrived. */
  finish(): Promise<void>;
  /** The chat model failed mid-reply. Wind down what was already handed over
   *  (finish the spoken text, or cancel it); the reply ends when a returned
   *  promise settles, so the last audio still arrives before `onResponseDone`.
   *  Afterwards the reply is no longer current, so later audio is dropped. */
  abandon?(): void | Promise<void>;
};

type SpeakerContext = {
  /** Aborted when this reply is stopped: barge-in, cancel, close. */
  signal: AbortSignal;
  /** False once the reply was superseded or the engine closed, so late audio can be dropped. */
  current(): boolean;
};

export type ChatLoopOptions = {
  log: Logger;
  request: typeof fetch;
  stage(): ChatStage;
  /** Read per request, because the engine's config arrives after construction. */
  events(): EngineEvents | undefined;
  tools(): ToolSpec[];
  instructions(): string;
  closed(): boolean;
  newSpeaker(context: SpeakerContext): Speaker;
  /** Names the engine in the log line for a failed reply. */
  label: string;
};

export type ChatLoop = {
  /** Answers `userText` (or just continues the history when empty), or says `exactLine` as is. */
  reply(userText: string | undefined, exactLine?: string): Promise<void>;
  /** Stops the work in hand without reporting it; pair with `endReply`. */
  stop(): void;
  /** Whether a reply has started and not yet reported done. */
  readonly replying: boolean;
  /** Bumped by `stop`; work that captured an older value is stale. */
  readonly generation: number;
  /** Reports the reply done, once. */
  endReply(cancelled: boolean): void;
  addContext(text: string): void;
  sendToolResult(callId: string, output: string): void;
};

type ChatToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Tool rounds one reply may take before the model must answer in words. */
const MAX_TOOL_ROUNDS = 4;

/**
 * A reply that promises a lookup ("Let me check.") and then ends without
 * calling anything. Small models do this; left alone, the user waits for an
 * answer that never comes. The model is told once, and its next round carries on.
 */
const MAX_STALLED_REPLY_CHARS = 160;
// "Let me X" is a promise whatever X is. "I'll X" is one only for looking
// things up or passing the caller on: "I'll get you the refund" is an answer.
const STALLED_PROMISE =
  /\b(?:let me|allow me to)\s+(?:just\s+|quickly\s+)?(?:check|look|find|search|pull|see|get|verify|confirm|transfer|connect)\b|\b(?:i(?:'|’)ll|i will|i am going to|i(?:'|’)m going to)\s+(?:just\s+|quickly\s+)?(?:check|look (?:that|this|it|into|up|for)|find out|search|pull (?:that|this|it) up|pull up|transfer you|connect you)\b|^\W*(?:one moment|just a moment|hold on|give me a (?:second|moment))(?:,? please)?\W*$|(?:我|让我|帮你|帮您|为您|给您)(?:来|先|去)?(?:查一下|查查|查询|查看|看一下|看看|确认一下|找一下|转接)|稍等|请稍候/i;
// Sent as the user's turn, marked as not theirs: several local chat templates
// refuse a system message anywhere but first.
const STALLED_NUDGE =
  "(Automatic note, not from the user.) You said you would look something up or take an action, but you called no tool. Call the tool now. Do not repeat what you already said.";

/** Whether a reply with no tool call reads as an unkept promise to use one:
 *  short, not a question, and ending on the promise rather than on an answer. */
function repliedWithoutActing(text: string): boolean {
  const said = text.trim();
  if (said.length === 0 || said.length > MAX_STALLED_REPLY_CHARS || /[?？]\s*$/.test(said)) return false;
  // Sentences end at a full stop followed by a space, so "3.5" stays whole.
  const sentences = said.split(/(?<=[.!])\s+|(?<=[。！…\n])/).filter((part) => /[\p{L}\p{N}]/u.test(part));
  const last = sentences.at(-1) ?? said;
  const promise = STALLED_PROMISE.exec(last);
  // "Let me confirm: your total is $5." has kept its promise in the same breath.
  return promise !== null && !/[:：]/.test(last.slice(promise.index + promise[0].length));
}

type StreamedChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
};

const MAX_HISTORY_MESSAGES = 16;
// Sentence boundaries for both Latin and CJK punctuation.
const SENTENCE_END = /[。！？!?；;\n]|[.](?=\s|$)/u;

export function authHeaders(item: ChatStage): Record<string, string> {
  return item.apiKey ? { Authorization: `Bearer ${item.apiKey}` } : {};
}

export async function failure(stageName: string, response: Response): Promise<Error> {
  const body = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
  const hint = response.status === 401 || response.status === 403 ? " — check the API key" : "";
  return new Error(`${stageName} HTTP ${response.status}${hint}${body ? `: ${body}` : ""}`);
}

export function createChatLoop(options: ChatLoopOptions): ChatLoop {
  const { log, request } = options;
  let history: ChatMessage[] = [];
  /** Tool calls waiting for `sendToolResult`, by call id. */
  const toolWaiters = new Map<string, (output: string) => void>();
  /** Bumped whenever the current work must stop: barge-in, cancel, close. */
  let generation = 0;
  let abort: AbortController | undefined;
  let replyActive = false;
  /** Cleared when the server refuses `reasoning_effort`, so later requests do not pay for the retry. */
  let sendReasoningEffort = true;

  function stop(): void {
    generation += 1;
    abort?.abort();
    abort = undefined;
  }

  function endReply(cancelled: boolean): void {
    if (!replyActive) return;
    replyActive = false;
    options.events()?.onResponseDone({ cancelled });
  }

  /** Streams chat-completion text, handing each delta and finished sentence to
   *  the speaker, and collects any tool calls the model makes. */
  async function streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    onDelta: (delta: string) => void,
    onSentence: ((sentence: string) => void) | undefined,
    offerTools: boolean
  ): Promise<{ text: string; toolCalls: ChatToolCall[] }> {
    const stage = options.stage();
    const tools = offerTools ? options.tools() : [];
    const send = (reasoningEffort: string | undefined) =>
      request(`${stage.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(stage) },
        body: JSON.stringify({
          model: stage.model,
          messages,
          stream: true,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          ...(tools.length
            ? {
                tools: tools.map((tool) => ({
                  type: "function",
                  function: { name: tool.name, description: tool.description, parameters: tool.parameters }
                }))
              }
            : {})
        }),
        signal
      });
    const reasoningEffort = sendReasoningEffort ? stage.reasoningEffort : undefined;
    let response = await send(reasoningEffort);
    if (reasoningEffort && (response.status === 400 || response.status === 422)) {
      // Not every OpenAI-compatible server or model accepts the field: answer without it.
      const detail = await response
        .clone()
        .text()
        .catch(() => "");
      if (/reasoning|think/i.test(detail)) {
        sendReasoningEffort = false;
        log.warn(`${options.label} chat model refused reasoning_effort; continuing without it`);
        response = await send(undefined);
      }
    }
    if (!response.ok || !response.body) throw await failure("Chat model", response);
    const decoder = new TextDecoder();
    let buffered = "";
    let sentence = "";
    let full = "";
    const calls: Array<{ id: string; name: string; arguments: string }> = [];
    const consume = (delta: string) => {
      full += delta;
      onDelta(delta);
      if (!onSentence) return;
      sentence += delta;
      for (;;) {
        const match = SENTENCE_END.exec(sentence);
        if (!match) break;
        const end = match.index + match[0].length;
        const complete = sentence.slice(0, end).trim();
        sentence = sentence.slice(end);
        if (complete) onSentence(complete);
      }
    };
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let chunk: StreamedChunk;
        try {
          chunk = JSON.parse(data) as StreamedChunk;
        } catch {
          continue; // a keep-alive or partial line
        }
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) consume(delta.content);
        // Tool calls stream in pieces: the first piece of each carries its id
        // and name, later pieces append to its arguments.
        for (const piece of delta?.tool_calls ?? []) {
          // Servers that omit `index` start a new call with each new id and
          // send later pieces of the same call without one.
          const last = calls.length - 1;
          const index = piece.index ?? (last < 0 || (piece.id && piece.id !== calls[last]?.id) ? calls.length : last);
          const call = (calls[index] ??= { id: "", name: "", arguments: "" });
          if (piece.id) call.id = piece.id;
          if (piece.function?.name) call.name += piece.function.name;
          if (piece.function?.arguments) call.arguments += piece.function.arguments;
        }
      }
    }
    if (onSentence && sentence.trim()) onSentence(sentence.trim());
    const toolCalls = calls
      .filter((call) => call.name)
      .map((call, index) => ({
        id: call.id || `call_${Date.now().toString(36)}_${index}`,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments }
      }));
    return { text: full, toolCalls };
  }

  /** Hands one call to the session and waits for its result. */
  function awaitTool(call: ChatToolCall, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        toolWaiters.delete(call.id);
        reject(new Error("aborted"));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      toolWaiters.set(call.id, (output) => {
        signal.removeEventListener("abort", onAbort);
        resolve(output);
      });
      const events = options.events();
      if (events?.onToolCall) {
        events.onToolCall({ callId: call.id, name: call.function.name, arguments: call.function.arguments });
      } else {
        toolWaiters.delete(call.id);
        resolve(JSON.stringify({ error: "tools are not available" }));
      }
    });
  }

  async function reply(userText: string | undefined, exactLine?: string): Promise<void> {
    stop();
    const mine = generation;
    const controller = new AbortController();
    abort = controller;
    replyActive = true;
    options.events()?.onResponseStarted();
    const current = () => !options.closed() && mine === generation;
    const speaker = options.newSpeaker({ signal: controller.signal, current });

    try {
      if (exactLine) {
        (speaker.say ?? speaker.sentence ?? speaker.delta)?.call(speaker, exactLine);
      } else {
        const turn: ChatMessage[] = userText ? [{ role: "user", content: userText }] : [];
        let full = "";
        let nudged = false;
        for (let round = 0; ; round += 1) {
          // The last round offers no tools, so the model has to answer in words.
          const offerTools = round < MAX_TOOL_ROUNDS;
          const result = await streamChat(
            [
              {
                role: "system",
                content:
                  options.stage().reasoningEffort === "none"
                    ? forFastLocalModel(options.instructions())
                    : options.instructions()
              },
              ...history,
              ...turn
            ],
            controller.signal,
            (delta) => {
              if (!current()) return;
              options.events()?.onAgentText(delta);
              speaker.delta?.(delta);
            },
            speaker.sentence?.bind(speaker),
            offerTools
          );
          full += result.text;
          if (
            !result.toolCalls.length &&
            offerTools &&
            !nudged &&
            options.tools().length > 0 &&
            repliedWithoutActing(result.text)
          ) {
            nudged = true;
            log.info(`${options.label} reply promised a lookup without calling a tool; asking again`);
            full += " ";
            turn.push({ role: "assistant", content: result.text }, { role: "user", content: STALLED_NUDGE });
            continue;
          }
          if (!result.toolCalls.length || !offerTools) break;
          turn.push({ role: "assistant", content: result.text || null, tool_calls: result.toolCalls });
          for (const call of result.toolCalls) {
            const output = await awaitTool(call, controller.signal);
            if (!current()) return;
            turn.push({ role: "tool", tool_call_id: call.id, content: output });
          }
        }
        // History keeps what was said; tool chatter stays inside its turn.
        if (userText) history.push({ role: "user", content: userText });
        if (full.trim()) history.push({ role: "assistant", content: full.trim() });
        if (history.length > MAX_HISTORY_MESSAGES) history = history.slice(-MAX_HISTORY_MESSAGES);
      }
      await speaker.finish();
      if (mine === generation) endReply(false);
    } catch (error) {
      if (mine !== generation || options.closed()) return;
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`${options.label} reply failed`, { message });
      options.events()?.onError(message);
      // The speaker winds down what it already has (its audio may still arrive
      // while it does), then the reply is made stale so nothing later plays.
      // Text that did arrive still reaches the wearer: the session core falls
      // back to client-side speech when a reply ends with text and no audio.
      try {
        await speaker.abandon?.();
      } catch (abandonError) {
        log.warn(`${options.label} abandon failed`, {
          message: abandonError instanceof Error ? abandonError.message : String(abandonError)
        });
      }
      // A barge-in or close during the wait has already ended the reply.
      if (mine !== generation || options.closed()) return;
      stop();
      endReply(false);
    }
  }

  return {
    reply,
    stop,
    get replying() {
      return replyActive;
    },
    get generation() {
      return generation;
    },
    endReply,
    addContext(text) {
      history.push({ role: "system", content: text });
    },
    sendToolResult(callId, output) {
      const waiter = toolWaiters.get(callId);
      if (!waiter) return;
      toolWaiters.delete(callId);
      waiter(output);
    }
  };
}
