import type { AgentEvent } from "../../../../shared/agent";
import type { RdkNavigationSnapshot } from "../navigation/controller";
import type { PhoneLocationState } from "../navigation/phone-location";

export type HudTurn = {
  speaker: "rider" | "agent";
  text: string;
  final: boolean;
  turnId: string;
};

export type HudCompanion = {
  pairingCode?: string;
  pairingExpiresAt?: number;
  paired: boolean;
  locationState: PhoneLocationState["connection"];
  horizontalAccuracyMeters?: number;
  lastFixAgeMs?: number;
};

export type HudState = {
  connection: string;
  turnState: string;
  transcript: HudTurn[];
  latencyMs: number | null;
  lastError: string | null;
  companion: HudCompanion;
  navigation: RdkNavigationSnapshot | null;
};

export type HudEvent =
  | AgentEvent
  | { type: "rdk.companion"; companion: HudCompanion }
  | { type: "rdk.navigation"; navigation: RdkNavigationSnapshot | null };

export function initialHudState(): HudState {
  return {
    connection: "offline",
    turnState: "idle",
    transcript: [],
    latencyMs: null,
    lastError: null,
    companion: { paired: false, locationState: "unpaired" },
    navigation: null
  };
}

function copyCompanion(companion: HudCompanion): HudCompanion {
  return {
    paired: companion.paired,
    locationState: companion.locationState,
    ...(companion.pairingCode === undefined ? {} : { pairingCode: companion.pairingCode }),
    ...(companion.pairingExpiresAt === undefined ? {} : { pairingExpiresAt: companion.pairingExpiresAt }),
    ...(companion.horizontalAccuracyMeters === undefined
      ? {}
      : { horizontalAccuracyMeters: companion.horizontalAccuracyMeters }),
    ...(companion.lastFixAgeMs === undefined ? {} : { lastFixAgeMs: companion.lastFixAgeMs })
  };
}

function copyLocation(location: PhoneLocationState): PhoneLocationState {
  return {
    connection: location.connection,
    usable: location.usable,
    ...(location.horizontalAccuracyMeters === undefined
      ? {}
      : { horizontalAccuracyMeters: location.horizontalAccuracyMeters }),
    ...(location.ageMs === undefined ? {} : { ageMs: location.ageMs }),
    ...(location.reason === undefined ? {} : { reason: location.reason })
  };
}

function copyNavigation(navigation: RdkNavigationSnapshot): RdkNavigationSnapshot {
  return {
    phase: navigation.phase,
    ...(navigation.destinationName === undefined ? {} : { destinationName: navigation.destinationName }),
    ...(navigation.instruction === undefined ? {} : { instruction: navigation.instruction }),
    ...(navigation.distanceToManeuverMeters === undefined
      ? {}
      : { distanceToManeuverMeters: navigation.distanceToManeuverMeters }),
    ...(navigation.remainingMeters === undefined ? {} : { remainingMeters: navigation.remainingMeters }),
    ...(navigation.remainingSeconds === undefined ? {} : { remainingSeconds: navigation.remainingSeconds }),
    ...(navigation.offRoute === undefined ? {} : { offRoute: navigation.offRoute }),
    ...(navigation.location === undefined ? {} : { location: copyLocation(navigation.location) })
  };
}

/**
 * Pure reducer for the bench HUD. Partial transcripts update in place by
 * `turnId`, matching how the other clients merge streaming captions.
 */
export function reduceHud(state: HudState, event: HudEvent): HudState {
  switch (event.type) {
    case "connection":
      return { ...state, connection: event.state };
    case "status":
      return { ...state, turnState: event.state };
    case "metric":
      return { ...state, latencyMs: event.latencyMs };
    case "error":
      return { ...state, lastError: event.message };
    case "companion.pairing":
      return {
        ...state,
        companion: {
          ...state.companion,
          pairingCode: event.code,
          pairingExpiresAt: event.expiresAt,
          paired: event.paired
        }
      };
    case "phone.location.status":
      return {
        ...state,
        companion: { ...state.companion, locationState: event.state }
      };
    case "rdk.companion":
      return { ...state, companion: copyCompanion(event.companion) };
    case "rdk.navigation":
      return {
        ...state,
        navigation: event.navigation === null ? null : copyNavigation(event.navigation)
      };
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
