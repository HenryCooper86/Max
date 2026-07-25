import type { AgentEvent } from "../../../../shared/agent";

export type HudTurn = {
  speaker: "rider" | "agent";
  text: string;
  final: boolean;
  turnId: string;
};

export type HudState = {
  connection: string;
  turnState: string;
  transcript: HudTurn[];
  latencyMs: number | null;
  lastError: string | null;
};

export function initialHudState(): HudState {
  return { connection: "offline", turnState: "idle", transcript: [], latencyMs: null, lastError: null };
}

/**
 * Pure reducer for the bench HUD. Partial transcripts update in place by
 * `turnId`, matching how the other clients merge streaming captions.
 */
export function reduceHud(state: HudState, event: AgentEvent): HudState {
  switch (event.type) {
    case "connection":
      return { ...state, connection: event.state };
    case "status":
      return { ...state, turnState: event.state };
    case "metric":
      return { ...state, latencyMs: event.latencyMs };
    case "error":
      return { ...state, lastError: event.message };
    case "transcript": {
      const turn: HudTurn = {
        speaker: event.speaker,
        text: event.text,
        final: event.final === true,
        turnId: event.turnId
      };
      const index = state.transcript.findIndex((item) => item.turnId === event.turnId);
      const transcript =
        index === -1
          ? [...state.transcript, turn]
          : state.transcript.map((item, position) => (position === index ? turn : item));
      return { ...state, transcript };
    }
    default:
      return state;
  }
}
