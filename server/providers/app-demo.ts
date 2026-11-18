import type { WebSocket } from "ws";
import { APP_DEMO_CAPABILITIES } from "../../shared/agent";
import { assistant, promptsInChinese } from "../assistant";
import type { Logger } from "../logger";
import { sessionLanguage } from "../prompts";
import { createToolBroker, type ToolBroker } from "../tools/broker";
import type { ToolDefinition, ToolSpec } from "../tools";
import { serverTools as installedServerTools } from "../tools/registry";
import { createTranscriptDelivery, transcriptEvent } from "../transcript-events";
import { createVad } from "./live/pipeline";
import type { AgentProvider, ProviderSessionContext, ProviderTelemetry, SessionStartEvent } from "./types";

/**
 * The keyless demo for a software assistant (a `general` device preset with
 * VOICE_PROVIDER=mock): everything a developer wires up can be tried before
 * any API key exists.
 *
 * - Speech is detected (the turn-taking, the status changes, the barge-in
 *   cues all happen), but there is no speech recognition, and it says so.
 * - Typed messages (`text.input`) get an answer.
 * - Tools really run. Type a tool's name — "get_order_status" or "get order
 *   status" — optionally followed by JSON arguments, and the demo calls it
 *   exactly as a live model would: server tools in the relay, client tools
 *   through `tool.call` / `tool.result`, with `tool.activity` along the way.
 *
 * Replies are spoken by the client's own text-to-speech (`useBrowserSpeech`).
 */

export type AppDemoOptions = {
  serverTools?: () => readonly ToolDefinition[];
  toolTimeoutMs?: number;
};

/** Finds the tool a typed message names, and any JSON arguments after it. Exported for tests. */
export function toolRequestFrom(
  text: string,
  tools: readonly ToolSpec[]
): { tool: ToolSpec; args: Record<string, unknown> } | undefined {
  const lowered = text.toLowerCase();
  const tool = tools.find((candidate) => {
    const name = candidate.name.toLowerCase();
    return lowered.includes(name) || lowered.includes(name.replace(/[_-]+/g, " "));
  });
  if (!tool) return undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { tool, args: parsed as Record<string, unknown> };
      }
    } catch {
      /* not JSON: call without arguments */
    }
  }
  return { tool, args: {} };
}

export function createAppDemoProvider(
  client: WebSocket,
  log: Logger,
  telemetry?: ProviderTelemetry,
  options: AppDemoOptions = {}
): AgentProvider {
  let language = "";
  let tools: ToolBroker | undefined;
  let audioActive = false;
  let greeted = false;
  let closed = false;
  let callCounter = 0;

  function send(payload: unknown): void {
    if (closed || client.readyState !== client.OPEN) return;
    const encoded = JSON.stringify(payload);
    telemetry?.serverEvent(payload, Buffer.byteLength(encoded));
    client.send(encoded);
  }

  function t(zh: string, en: string): string {
    if (language === "en") return en;
    if (language && !language.startsWith("zh")) return en;
    return promptsInChinese() ? zh : en;
  }

  function status(state: string, detail: string): void {
    send({ type: "status", state, detail });
  }

  function listening(): void {
    if (audioActive) status("listening", t("演示模式：正在收听", "Demo mode: listening"));
    else status("ready", t("演示模式已就绪", "Demo mode ready"));
  }

  function say(text: string): void {
    send(transcriptEvent(createTranscriptDelivery(), "agent", text, { final: true, useBrowserSpeech: true }));
  }

  function toolNames(): string {
    return (tools?.specs() ?? []).map((tool) => tool.name).join(", ");
  }

  const vad = createVad({
    onStart() {
      if (closed) return;
      status("hearing", t("检测到语音", "Hearing you"));
    },
    onEnd() {
      if (closed) return;
      send(
        transcriptEvent(createTranscriptDelivery(), "rider", t("（语音）", "(speech)"), {
          final: true
        })
      );
      say(
        t(
          "我听到你说话了。这是演示模式，没有语音识别。在 .env 里设置 VOICE_PROVIDER 接入真实的语音后端，或者直接输入文字。",
          "I heard you. This is demo mode, which has no speech recognition. Set VOICE_PROVIDER in .env to use a real voice backend, or type a message."
        )
      );
      listening();
    }
  });

  async function answer(text: string): Promise<void> {
    send(transcriptEvent(createTranscriptDelivery(), "rider", text, { final: true }));
    status("thinking", t(`${assistant().name} 正在思考`, `${assistant().name} is thinking`));
    const request = tools ? toolRequestFrom(text, tools.specs()) : undefined;
    if (request && tools) {
      callCounter += 1;
      status("thinking", t(`正在使用工具：${request.tool.name}`, `Using ${request.tool.name}`));
      const outcome = await tools.run({
        callId: `demo_${Date.now().toString(36)}_${callCounter}`,
        name: request.tool.name,
        arguments: request.args
      });
      if (closed) return;
      say(
        outcome.ok
          ? t(`${request.tool.name} 返回：${outcome.output}`, `${request.tool.name} returned: ${outcome.output}`)
          : t(`${request.tool.name} 失败了：${outcome.output}`, `${request.tool.name} failed: ${outcome.output}`)
      );
      listening();
      return;
    }
    const available = toolNames();
    say(
      t(
        `演示模式收到了：“${text}”。接入真实的语音后端后，${assistant().name} 会真正回答。` +
          (available ? `输入工具名称即可试用工具：${available}。` : ""),
        `Demo mode got: "${text}". Connect a real voice backend and ${assistant().name} will answer for real.` +
          (available ? ` Type a tool's name to try it: ${available}.` : "")
      )
    );
    listening();
  }

  return {
    async start(event: SessionStartEvent, context?: ProviderSessionContext) {
      language = sessionLanguage(event.language, assistant().languages);
      tools = createToolBroker({
        sessionId: context?.sessionId ?? "session",
        serverTools: options.serverTools ?? installedServerTools,
        clientTools: (event.tools ?? []).map((tool) => ({
          ...tool,
          parameters: tool.parameters ?? { type: "object", properties: {} }
        })),
        send,
        language: () => language || assistant().languages[0],
        userId: context?.userId,
        log,
        clientTimeoutMs: options.toolTimeoutMs
      });
      send({ type: "session.started", provider: "mock", mode: "mock", capabilities: APP_DEMO_CAPABILITIES });
      status("ready", t("演示模式已就绪", "Demo mode ready"));
    },
    async startAudio() {
      audioActive = true;
      listening();
      if (greeted) return;
      greeted = true;
      const available = toolNames();
      say(
        assistant().greeting ??
          t(
            `你好，我是 ${assistant().name}。现在是演示模式：可以输入文字和我对话${available ? `，或输入工具名称试用工具（${available}）` : ""}。`,
            `Hi, I'm ${assistant().name}. This is demo mode: type a message to talk to me${available ? `, or type a tool's name to try it (${available})` : ""}.`
          )
      );
    },
    async sendAudio(chunk: Buffer) {
      if (audioActive) vad.push(chunk);
    },
    async stopAudio() {
      audioActive = false;
      vad.reset();
      status("ready", t("麦克风已静音", "Microphone muted"));
    },
    async textInput(text: string) {
      // Detached: the relay handles one client message at a time, and a
      // client tool's `tool.result` arrives behind this one. Awaiting the
      // answer here would leave that result queued until the tool timed out.
      void answer(text).catch((error: unknown) => {
        log.warn("demo answer failed", { message: error instanceof Error ? error.message : String(error) });
      });
      return true;
    },
    async toolResult(event) {
      tools?.clientResult(event);
    },
    async close() {
      closed = true;
      vad.reset();
      tools?.close();
    }
  };
}
