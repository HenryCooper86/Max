/**
 * Voice-agent SDK: talk to a voice-agent relay from any browser page.
 *
 * @packageDocumentation
 */

export { VoiceAgent, VoiceAgentError, defineClientTool } from "./client";
export type {
  CloseInfo,
  ClientTool,
  StartOptions,
  ToolCallInfo,
  VoiceAgentErrorCode,
  VoiceAgentEvents,
  VoiceAgentOptions,
  VoiceAgentStatus
} from "./client";
export type { AgentCapabilities, JsonSchema, ToolActivityEvent, TranscriptItem, VoiceGender } from "./protocol";
