/**
 * React binding for {@link VoiceAgent}.
 *
 * ```tsx
 * const { status, transcript, start, stop } = useVoiceAgent({ url: "https://relay.example.com", token });
 * ```
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceAgent, VoiceAgentError } from "./client.js";
import type { ClientTool, StartOptions, VoiceAgentOptions, VoiceAgentStatus } from "./client.js";
import type { TranscriptItem } from "./protocol.js";

/** What {@link useVoiceAgent} returns. */
export interface UseVoiceAgentResult {
  /** Current status. */
  status: VoiceAgentStatus;
  /** The conversation so far. */
  transcript: readonly TranscriptItem[];
  /** Connects and opens the mic. Call from a click handler. */
  start(options?: StartOptions): Promise<void>;
  /** Ends the conversation. */
  stop(): void;
  /** Stops sending mic audio. */
  mute(): void;
  /** Resumes sending mic audio. */
  unmute(): void;
  /** Sends a typed turn. Returns false when there is no live session. */
  sendText(text: string): boolean;
  /** Whether the mic is muted. */
  isMuted: boolean;
  /** Mic and agent-output loudness, 0..1. Updates up to ~30 times a second. */
  level: { mic: number; output: number };
  /** The latest error, cleared when a new session starts. */
  error: VoiceAgentError | undefined;
  /** The underlying client, for anything the hook does not expose. Undefined until mounted. */
  agent: VoiceAgent | undefined;
}

const SILENT = { mic: 0, output: 0 };

/**
 * What identifies a client. Changing any of these replaces it; everything else
 * (tool handlers, a token function's identity, `context`) is read live. Inline
 * objects and functions are compared by content, so they do not recreate the
 * client on every render.
 */
function connectionKey(options: VoiceAgentOptions): string {
  const token = options.token;
  return JSON.stringify([
    options.url,
    typeof token === "function" ? { fn: true } : (token ?? null),
    options.project ?? null,
    options.language ?? null,
    options.voice ?? null,
    options.backend ?? null,
    options.transport ?? null,
    options.iceServers ?? null,
    options.autoReconnect ?? null,
    options.speakFallback ?? null,
    (options.tools ?? []).map(({ name, description, parameters }) => [name, description, parameters ?? null])
  ]);
}

/**
 * Runs a voice agent for the lifetime of a component.
 *
 * The client is created when the component mounts and again whenever a
 * connection option changes (`url`, `token`, `project`, `language`, `voice`,
 * `backend`, `transport`, `iceServers`, `autoReconnect`, `speakFallback`, or the tools' names,
 * descriptions and parameters); the old one is destroyed, which ends any
 * running conversation. A token function, tool handlers and `context` are read
 * live, so inline closures are safe and never restart the client. `audioContext`
 * is read when the client is created.
 */
export function useVoiceAgent(options: VoiceAgentOptions): UseVoiceAgentResult {
  const latest = useRef(options);
  latest.current = options;
  const key = connectionKey(options);

  const [agent, setAgent] = useState<VoiceAgent | undefined>();
  const [status, setStatus] = useState<VoiceAgentStatus>("idle");
  const [transcript, setTranscript] = useState<readonly TranscriptItem[]>([]);
  const [isMuted, setMuted] = useState(false);
  const [level, setLevel] = useState(SILENT);
  const [error, setError] = useState<VoiceAgentError | undefined>();

  useEffect(() => {
    const first = latest.current;
    // Indirection keeps handlers (and a token function) fresh without recreating the client.
    const tools: ClientTool[] | undefined = first.tools?.map((tool) => ({
      ...tool,
      handler(args) {
        const current = latest.current.tools?.find((candidate) => candidate.name === tool.name) ?? tool;
        return current.handler(args);
      }
    }));
    const token =
      typeof first.token === "function" ? () => (latest.current.token as () => Promise<string>)() : first.token;
    const instance = new VoiceAgent({
      ...first,
      ...(tools ? { tools } : {}),
      ...(token !== undefined ? { token } : {})
    });
    // A previous client's state must not leak into this one.
    setStatus("idle");
    setTranscript([]);
    setMuted(false);
    setLevel(SILENT);
    setError(undefined);
    const off = [
      instance.on("status", (next) => {
        setStatus(next);
        setMuted(instance.muted);
      }),
      instance.on("transcript", ({ transcript: next }) => setTranscript(next)),
      instance.on("level", setLevel),
      instance.on("error", setError)
    ];
    setAgent(instance);
    return () => {
      off.forEach((unsubscribe) => unsubscribe());
      instance.destroy();
      setAgent(undefined);
    };
  }, [key]);

  // The context string applies to the next session, so it can follow props without a new client.
  const context = options.context;
  useEffect(() => {
    if (context !== undefined) agent?.setContext(context);
  }, [agent, context]);

  const start = useCallback(
    (startOptions?: StartOptions) => {
      setError(undefined);
      return agent
        ? agent.start(startOptions)
        : Promise.reject(
            new VoiceAgentError("connection", "The voice agent is not ready yet: wait for the component to mount")
          );
    },
    [agent]
  );
  const stop = useCallback(() => agent?.stop(), [agent]);
  const mute = useCallback(() => {
    agent?.mute();
    setMuted(true);
  }, [agent]);
  const unmute = useCallback(() => {
    agent?.unmute();
    setMuted(false);
  }, [agent]);
  const sendText = useCallback((text: string) => agent?.sendText(text) ?? false, [agent]);

  return { status, transcript, start, stop, mute, unmute, sendText, isMuted, level, error, agent };
}
