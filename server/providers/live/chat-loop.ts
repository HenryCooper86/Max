import type { Logger } from "../../logger";
import { forFastLocalModel } from "../../prompts";
import type { ToolSpec } from "../../tools";
import type { EngineEvents, EngineImage } from "./engine";

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
  /** The owner says this chat model can see pictures. The relay cannot tell. */
  images?: boolean;
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
  /** Holds a picture for the next user turn; it starts nothing and stops nothing. */
  addImage(image: EngineImage): void;
  /** The newest frame of live video, in place of the one before: the next user
   *  turn takes it as what the user is showing. `undefined`: the video stopped. */
  setFrame(image: EngineImage | undefined): void;
  sendToolResult(callId: string, output: string): void;
  /** A line to speak as it is while this call is waited for, before the model carries on with its result. */
  sayDuringTool(callId: string, line: string): void;
};

type ChatToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatPart[] }
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
/** Pictures resent with every request; older ones are replaced by a note. */
const MAX_PICTURES_IN_HISTORY = 2;
const OLD_PICTURE_NOTE = "[a picture the user showed earlier]";

function hasPicture(message: ChatMessage): boolean {
  return (
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "image_url")
  );
}

/** The messages with only the newest `keep` pictures left in; the others become a note, and an
 *  older frame of live video goes without one (the conversation already says the video was on).
 *  Returns new objects where it changes anything and never touches the input. */
function withPictures(
  messages: ChatMessage[],
  keep: number,
  isFrame: (part: ChatPart) => boolean = () => false
): ChatMessage[] {
  let seen = 0;
  const result = [...messages];
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index];
    if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
    const parts: ChatPart[] = [];
    // Within one message the later picture is the newer one.
    for (let at = message.content.length - 1; at >= 0; at -= 1) {
      const part = message.content[at]!;
      if (part.type !== "image_url") parts.unshift(part);
      else if ((seen += 1) <= keep) parts.unshift(part);
      else if (!isFrame(part)) parts.unshift({ type: "text", text: OLD_PICTURE_NOTE });
    }
    result[index] = { role: "user", content: parts };
  }
  return result;
}
// Sentence boundaries for both Latin and CJK punctuation.
const SENTENCE_END = /[。！？!?；;\n]|[.](?=\s|$)/u;
/** A line that ends like this is not parted by a space from what follows: scripts written without gaps. */
const NO_GAP_AFTER = /[。！？…，、；：\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;

export function authHeaders(item: ChatStage): Record<string, string> {
  return item.apiKey ? { Authorization: `Bearer ${item.apiKey}` } : {};
}

/** A vendor may echo part of a request in an error. Picture data must not reach a log line or the client. */
function withoutPictureData(text: string): string {
  return text.replace(/data:[^;,\s"]*;base64,[A-Za-z0-9+/=_-]*/g, "[data]").replace(/[A-Za-z0-9+/=_-]{40,}/g, "[data]");
}

export async function failure(stageName: string, response: Response): Promise<Error> {
  const body = withoutPictureData(await response.text().catch(() => ""))
    .replace(/\s+/g, " ")
    .slice(0, 160);
  const hint = response.status === 401 || response.status === 403 ? " — check the API key" : "";
  return new Error(`${stageName} HTTP ${response.status}${hint}${body ? `: ${body}` : ""}`);
}

/** Sentences as one text: a space between them, except where the script does not use one. */
function joined(sentences: string[]): string {
  let text = "";
  for (const sentence of sentences) {
    text += text && !/[\s。！？…]$/u.test(text) ? ` ${sentence}` : sentence;
  }
  return text;
}

export function createChatLoop(options: ChatLoopOptions): ChatLoop {
  const { log, request } = options;
  let history: ChatMessage[] = [];
  /** Pictures shown without words, waiting for the next user turn. */
  let pendingImages: EngineImage[] = [];
  /** The newest frame of live video, until a turn takes it or a newer one comes. */
  let frame: EngineImage | undefined;
  /** The parts of messages that are frames of live video, not pictures the user chose to show. */
  const frameParts = new WeakSet<ChatPart>();
  const isFrame = (part: ChatPart) => frameParts.has(part);
  /** Tool calls waiting for `sendToolResult`, by call id. */
  const toolWaiters = new Map<string, (output: string) => void>();
  /** For each call being waited for: how the reply it belongs to speaks a line of the relay's own. */
  const toolSayers = new Map<string, (line: string) => void>();
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
    offerTools: boolean,
    /** Sentences the user has just heard from the relay itself. A reply that begins by repeating them is not let to. */
    heard: readonly string[] = []
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
    // The beginning of the reply, kept back while it could still be a repeat of what was just said.
    const echoes = heard.map((line) => line.toLowerCase());
    let head: string | undefined = echoes.length > 0 ? "" : undefined;
    /** A repeat was taken out: what follows it starts without the gap that parted the two. */
    let cut = false;
    const take = (delta: string): void => {
      if (head === undefined) return consume(delta);
      let kept: string = head + delta;
      for (;;) {
        const start = kept.trimStart();
        // Lower case can be longer than what it was made from ("İ"): a repeat is measured in the line as written.
        const repeated = heard.find(
          (line) => start.length >= line.length && start.slice(0, line.length).toLowerCase() === line.toLowerCase()
        );
        if (repeated === undefined) {
          // Could still turn into one of them: wait for more.
          const lower = start.toLowerCase();
          if (heard.some((line) => line.slice(0, start.length).toLowerCase() === lower)) head = kept;
          else {
            head = undefined;
            if (cut) kept = kept.trimStart();
            if (kept) consume(kept);
          }
          return;
        }
        cut = true;
        kept = start.slice(repeated.length);
      }
    };
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
        if (delta?.content) take(delta.content);
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
    // What was kept back and turned out to be no repeat after all: the beginning of one, and then the reply ended.
    if (head?.trim() && !echoes.includes(head.trim().toLowerCase())) consume(head);
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
    /** Whether any request of this reply carried a picture. */
    let carriedPicture = false;
    /** Pictures taken for this turn, until the turn is in history or has failed. */
    let shown: EngineImage[] = [];
    /** How many of them were shown as pictures: the rest is the frame of live video this turn took. */
    let waited = 0;
    let settled = false;

    try {
      if (exactLine) {
        (speaker.say ?? speaker.sentence ?? speaker.delta)?.call(speaker, exactLine);
      } else {
        // Pictures shown earlier go with the next turn that has words.
        shown = userText ? pendingImages.slice(-MAX_PICTURES_IN_HISTORY) : [];
        waited = shown.length;
        if (userText) pendingImages = [];
        // With live video on, the turn also carries what the camera or the screen shows as it starts.
        if (userText && frame) {
          shown = [...shown, frame].slice(-MAX_PICTURES_IN_HISTORY);
          waited = shown.length - 1;
          frame = undefined;
        }
        const pictureParts: ChatPart[] = shown.map((image) => ({
          type: "image_url" as const,
          image_url: { url: `data:${image.mimeType};base64,${image.data}` }
        }));
        for (const part of pictureParts.slice(waited)) frameParts.add(part);
        const userMessage: ChatMessage | undefined = userText
          ? {
              role: "user",
              content: shown.length ? [{ type: "text", text: userText }, ...pictureParts] : userText
            }
          : undefined;
        const turn: ChatMessage[] = userMessage ? [userMessage] : [];
        let full = "";
        /** Lines of the relay's own spoken in this reply, whole and sentence by sentence. */
        const heard: string[] = [];
        let nudged = false;
        // With a guardrail that holds speech, nothing of the reply is spoken or
        // shown until the session has read it: sentence by sentence, and every
        // sentence that arrived during one reading together in the next.
        const session = options.events();
        const hold = session?.holdsSpeech?.() ? session.holdSpeech?.bind(session) : undefined;
        const waiting: string[] = [];
        let cleared = "";
        let refused = false;
        let reading: Promise<void> | undefined;
        const read = async (): Promise<void> => {
          while (waiting.length > 0 && current() && !refused) {
            const batch = waiting.splice(0);
            const known = history.length;
            let allowed = true;
            try {
              allowed = await (hold as (text: string) => Promise<boolean>)(
                joined(cleared ? [cleared, ...batch] : batch)
              );
            } catch (error) {
              // A session that cannot read is not a reason to say nothing: its own checks fail open too.
              log.warn(`${options.label} held speech could not be read`, {
                message: error instanceof Error ? error.message : String(error)
              });
            }
            if (!allowed) {
              // The session stopped the reply, and has told the model so. What was
              // asked and what was said until then go before that note.
              refused = true;
              waiting.length = 0;
              if (!settled) {
                settled = true;
                history.splice(
                  Math.min(known, history.length),
                  0,
                  ...(userMessage ? [userMessage] : []),
                  ...(cleared.trim() ? [{ role: "assistant" as const, content: cleared.trim() }] : [])
                );
              }
              return;
            }
            if (!current()) return;
            for (const sentence of batch) {
              const text = cleared ? joined([cleared, sentence]).slice(cleared.length) : sentence;
              cleared += text;
              options.events()?.onAgentText(text);
              if (speaker.sentence) speaker.sentence(sentence);
              else speaker.delta?.(text);
            }
          }
        };
        const held = (sentence: string): void => {
          if (refused || !current()) return;
          waiting.push(sentence);
          reading ??= read().finally(() => {
            reading = undefined;
          });
        };
        /** Everything handed over so far has been read. */
        const allRead = async (): Promise<void> => {
          while (reading) await reading;
        };
        for (let round = 0; ; round += 1) {
          // The last round offers no tools, so the model has to answer in words.
          const offerTools = round < MAX_TOOL_ROUNDS;
          const messages: ChatMessage[] = [
            {
              role: "system",
              content:
                options.stage().reasoningEffort === "none"
                  ? forFastLocalModel(options.instructions())
                  : options.instructions()
            },
            ...withPictures([...history, ...turn], MAX_PICTURES_IN_HISTORY, isFrame)
          ];
          carriedPicture ||= messages.some(hasPicture);
          const result = await streamChat(
            messages,
            controller.signal,
            (delta) => {
              if (!current() || hold) return;
              options.events()?.onAgentText(delta);
              speaker.delta?.(delta);
            },
            hold ? held : speaker.sentence?.bind(speaker),
            offerTools,
            heard
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
            // A line of the relay's own, in the owner's words: spoken as it is while the call
            // is waited for, after what the model has said so far and before what it says next.
            let saying: Promise<void> = Promise.resolve();
            const speak = async (say: string): Promise<void> => {
              if (hold) await allRead();
              if (!current() || refused) return;
              // With the gap that parts it from what the model says next, where the script has gaps.
              const text = `${joined([full, say]).slice(full.length)}${NO_GAP_AFTER.test(say) ? "" : " "}`;
              full += text;
              // A model that is told what was said tends to say it again: its next words are read for that.
              heard.push(say, ...(say.match(/[^.!?。！？…]+[.!?。！？…]+/gu) ?? []).map((one) => one.trim()));
              if (hold) cleared += joined([cleared, say]).slice(cleared.length);
              options.events()?.onAgentText(text);
              if (speaker.sentence) speaker.sentence(say);
              else speaker.delta?.(text);
            };
            toolSayers.set(call.id, (line) => {
              saying = saying.then(() => speak(line)).catch(() => undefined);
            });
            let output: string;
            try {
              output = await awaitTool(call, controller.signal);
            } finally {
              toolSayers.delete(call.id);
            }
            // The model's next words come after the line, never over it.
            await saying;
            if (!current()) return;
            turn.push({ role: "tool", tool_call_id: call.id, content: output });
          }
        }
        if (hold) {
          await allRead();
          if (refused) {
            // The session cancels a reply it stops. If it did not, the reply ends here.
            if (current()) {
              stop();
              endReply(true);
            }
            return;
          }
          if (!current()) return;
          // The model is reminded of what it said, not of what it was kept from saying.
          full = cleared;
        }
        // History keeps what was said; tool chatter stays inside its turn.
        if (userMessage) history.push(userMessage);
        settled = true;
        if (full.trim()) history.push({ role: "assistant", content: full.trim() });
        history = withPictures(history, MAX_PICTURES_IN_HISTORY, isFrame);
        if (history.length > MAX_HISTORY_MESSAGES) history = history.slice(-MAX_HISTORY_MESSAGES);
      }
      await speaker.finish();
      if (mine === generation) endReply(false);
    } catch (error) {
      if (mine !== generation || options.closed()) return;
      settled = true;
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`${options.label} reply failed`, { message });
      // A model that cannot take pictures would refuse every later request
      // while one is in the history. The failed turn never reached it.
      if (carriedPicture) history = withPictures(history, 0, isFrame);
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
    } finally {
      // A turn that was superseded (barge-in) before it reached history: its
      // pictures were never seen, so they wait for the next turn. A frame of
      // live video does not: by then it is no longer what the user is showing.
      if (!settled && waited > 0) {
        pendingImages = [...shown.slice(0, waited), ...pendingImages].slice(-MAX_PICTURES_IN_HISTORY);
      }
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
    addImage(image) {
      pendingImages = [...pendingImages, image].slice(-MAX_PICTURES_IN_HISTORY);
    },
    setFrame(image) {
      frame = image;
    },
    sendToolResult(callId, output) {
      const waiter = toolWaiters.get(callId);
      if (!waiter) return;
      toolWaiters.delete(callId);
      waiter(output);
    },
    sayDuringTool(callId, line) {
      toolSayers.get(callId)?.(line);
    }
  };
}
