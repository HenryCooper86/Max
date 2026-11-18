/**
 * Voice-agent SDK: talk to a voice-agent relay from any browser page.
 *
 * @packageDocumentation
 */

export { VoiceAgent, VoiceAgentError, defineClientTool } from "./client.js";
export type {
  CloseInfo,
  ClientTool,
  StartOptions,
  ToolCallInfo,
  VoiceAgentErrorCode,
  VoiceAgentEvents,
  VoiceAgentOptions,
  VoiceAgentStatus
} from "./client.js";
export type { AgentCapabilities, JsonSchema, ToolActivityEvent, TranscriptItem, VoiceGender } from "./protocol.js";
