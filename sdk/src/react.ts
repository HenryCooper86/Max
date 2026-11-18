/**
 * React binding for {@link VoiceAgent}.
 *
 * ```tsx
 * const { status, transcript, start, stop } = useVoiceAgent({ url: "https://relay.example.com", token });
 * ```
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceAgent } from "./client";
import type { ClientTool, StartOptions, VoiceAgentError, VoiceAgentOptions, VoiceAgentStatus } from "./client";
import type { TranscriptItem } from "./protocol";

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
 * Runs a voice agent for the lifetime of a component.
 *
 * The client is created once from the first `options` (connection settings
 * such as `url`, `token`, `language` are not re-read) and destroyed on unmount.
 * Tool handlers are the exception: they always call the latest closure, so
 * they can read current props and state.
 */
export function useVoiceAgent(options: VoiceAgentOptions): UseVoiceAgentResult {
  const latest = useRef(options);
  latest.current = options;

  const [agent, setAgent] = useState<VoiceAgent | undefined>();
  const [status, setStatus] = useState<VoiceAgentStatus>("idle");
  const [transcript, setTranscript] = useState<readonly TranscriptItem[]>([]);
  const [isMuted, setMuted] = useState(false);
  const [level, setLevel] = useState(SILENT);
  const [error, setError] = useState<VoiceAgentError | undefined>();

  useEffect(() => {
    const first = latest.current;
    // Indirection keeps handlers fresh without recreating the client.
    const tools: ClientTool[] | undefined = first.tools?.map((tool) => ({
      ...tool,
      handler(args) {
        const current = latest.current.tools?.find((candidate) => candidate.name === tool.name) ?? tool;
        return current.handler(args);
      }
    }));
    const instance = new VoiceAgent({ ...first, ...(tools ? { tools } : {}) });
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
  }, []);

  const start = useCallback(
    (startOptions?: StartOptions) => {
      setError(undefined);
      return agent ? agent.start(startOptions) : Promise.reject(new Error("Voice agent is not ready"));
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
