/** A project-level observation. Contains no visitor identity, origin, token or conversation content. */
export type InstallSignalKind =
  | "disabled"
  | "origin"
  | "modelKey"
  | "busy"
  | "monthlyLimit"
  | "balance"
  | "unavailable"
  | "tokenIssued"
  | "connected"
  | "ready"
  | "waitingForAnswer"
  | "providerError"
  | "closed"
  | "answered";
export type InstallSignal = { kind: InstallSignalKind; at: number };
