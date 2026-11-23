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
  VoiceAgentStatus,
  VoiceAgentWarning
} from "./client.js";
export type { ImageSource } from "./image.js";
export type { VideoKind, VideoOptions, VideoSource } from "./video.js";
export type { AgentCapabilities, JsonSchema, ToolActivityEvent, TranscriptItem, VoiceGender } from "./protocol.js";
export { PROTOCOL_VERSION, SDK_VERSION } from "./version.js";
