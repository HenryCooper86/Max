import type {
  ClientEvent,
  DeviceResultEvent,
  SessionStartEvent,
  ToolResultEvent,
  VisionFramesEvent
} from "../../shared/agent";
import type { UserMemoryFact, UserMemoryTurn } from "../user-memory";
import type { NavPromptSpeech } from "../routing";

export type { ClientEvent, SessionStartEvent, VoiceGender } from "../../shared/agent";

// shared/agent.ts's hazard.report variant has no standalone exported name (it
// is inline in the ClientEvent union) — same situation crash-escalation.ts
// solved for crash.alert/crash.cancel, and the same fix: derive it here with
// Extract rather than duplicating the field list. Export when a consumer imports it by name.
type HazardReportEvent = Extract<ClientEvent, { type: "hazard.report" }>;

export type ProviderTelemetry = {
  serverEvent(payload: unknown, bytes: number): void;
  serverAudio(bytes: number): void;
  ttsFallback(): void;
};

export type ProviderSessionContext = {
  /** The relay's id for this session (tools receive it). */
  sessionId?: string;
  /** Who the session belongs to: the signed-in account, or the `userId` the
   *  owner's backend stamped on the session token. */
  userId?: string;
  /** Facts the owner's backend stamped on the session token. Unlike the
   *  client's own `context`, the client cannot change these. */
  trustedContext?: string;
  /** Bounded, server-owned history for the authenticated user. */
  previousConversation?: {
    updatedAt: number;
    turns: UserMemoryTurn[];
    facts: UserMemoryFact[];
  };
  /** Live read of whether the relay currently has a route planned — backed by
   *  server/routing.ts's createNavHandler().activeRoute(), the same signal
   *  createNavPromptHandler already trusts to gate relay nav prompts. Not a
   *  snapshot: call it fresh each time, since the underlying route can start
   *  or clear over the life of the session. A provider with no fabrication
   *  guard (or any other reason to know route state) omits reading it;
   *  session-controller.ts passes it unconditionally. */
  routeActive?: () => boolean;
  /** Captures the route generation being stopped. Invoke the returned callback
   * only when the device confirms it stopped; a newer route must survive a
   * delayed acknowledgment for this command. */
  captureNavigationStop?: () => () => void;
};

export type AgentProvider = {
  start(event: SessionStartEvent, context?: ProviderSessionContext): Promise<void>;
  startAudio(): Promise<void>;
  sendAudio(chunk: Buffer): Promise<void>;
  stopAudio(): Promise<void>;
  close(): Promise<void>;
  /** Toggles the guided demo ride. Providers without a demo tour omit this. */
  setGuidedDemo?(enabled: boolean): Promise<void>;
  /** Mid-ride rider position update. Providers without location context omit this. */
  updateLocation?(lat: number, lon: number): Promise<void>;
  /** Result of a dispatched device command. Providers without a device-action
   *  path omit this. */
  deviceResult?(event: DeviceResultEvent): Promise<void>;
  /** A hazard the embedded board detected and already announced — flows
   *  upward only (see shared/agent.ts's hazard.report doc comment). Every
   *  provider gates its watch governor on this. */
  hazardReport?(event: HazardReportEvent): Promise<void>;
  /** One frame the rider asked Max to look at. Providers without a vision path
   *  omit this. */
  cameraFrame?(event: { commandId: string; image: string }): Promise<void>;
  /** One chunk of a multi-frame gallery understanding request. Providers
   *  without a vision path omit this. */
  visionFrames?(event: VisionFramesEvent): Promise<void>;
  /** Attaches the relay-spoken route summary to the most recently issued
   *  navigation.start command, once server/routing.ts's createNavHandler has
   *  resolved a destination and planned a route (see its onRouteAnnounced
   *  option, wired in session-controller.ts). Providers without a navigation
   *  confirmation path omit this. */
  attachNavOkSpeech?(speech: string): void;
  /** Speaks a relay-composed navigation line that has no associated
   *  device.command to reconcile against — currently only the
   *  reroute-success confirmation (server/routing.ts's onRerouteAnnounced
   *  option, wired in session-controller.ts). One transcript send, mirroring
   *  applyDeviceReconciliation's own delivery shape
   *  (transcriptEvent(..., "agent", text, { final: true, useBrowserSpeech:
   *  true }) → send). Providers without a navigation confirmation path omit
   *  this. */
  speakNavLine?(text: string): void;
  /** Speaks relay-validated, relay-composed RDK guidance. */
  speakNavPrompt?(speech: NavPromptSpeech): void;
  /** A turn the user typed. Resolves `false` when the backend cannot take
   *  typed turns. Providers without typed input omit this. */
  textInput?(text: string): Promise<boolean | void>;
  /** A client's answer to a `tool.call`. Providers without tools omit this. */
  toolResult?(event: ToolResultEvent): Promise<void>;
};
