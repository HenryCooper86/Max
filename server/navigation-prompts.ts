import type { NavPromptEvent, NavRouteEvent } from "../shared/agent";
import type { NavPromptSpeech } from "./routing";

const MAX_ID_BYTES = 120;
const ONE_MINUTE_MS = 60_000;
const DEFAULT_MAX_PER_MINUTE = 30;
const MAX_RETAINED_PROMPT_IDS = 256;

const NAV_FIXED_TEXT = {
  offRoute: "已偏离路线，正在重新规划。",
  rerouteFailed: "无法重新规划路线，已停止导航。",
  arrived: "已到达目的地。",
  locationLost: "手机定位已断开，导航已暂停。"
} as const;

function validId(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && Buffer.byteLength(value) <= MAX_ID_BYTES;
}

export function createNavPromptHandler(options: {
  activeRoute: () => NavRouteEvent | undefined;
  speak: (speech: NavPromptSpeech) => void;
  now?: () => number;
  maxPerMinute?: number;
}): (event: NavPromptEvent) => void {
  const { activeRoute, speak, now = Date.now, maxPerMinute = DEFAULT_MAX_PER_MINUTE } = options;
  const seenPromptIds = new Set<string>();
  const acceptedAt: number[] = [];
  let accountingRouteCommandId: string | undefined;

  return function handleNavPrompt(event: NavPromptEvent): void {
    const receivedAt = now();
    if (!validId(event.promptId) || !validId(event.routeCommandId)) return;
    const route = activeRoute();
    if (route?.commandId !== accountingRouteCommandId) {
      accountingRouteCommandId = route?.commandId;
      seenPromptIds.clear();
      acceptedAt.length = 0;
    }
    if (!route || event.routeCommandId !== route.commandId) return;

    let speech: NavPromptSpeech;
    if (event.kind === "maneuver") {
      if (
        !Number.isInteger(event.maneuverIndex) ||
        event.maneuverIndex < 0 ||
        event.maneuverIndex >= route.steps.length ||
        (event.threshold !== "far" && event.threshold !== "near" && event.threshold !== "now") ||
        typeof event.distanceMeters !== "number" ||
        !Number.isFinite(event.distanceMeters) ||
        event.distanceMeters < 0 ||
        event.distanceMeters > 20_000
      ) {
        return;
      }
      const instruction = route.steps[event.maneuverIndex]?.instruction;
      if (typeof instruction !== "string") return;
      if (event.threshold === "now") {
        speech = { text: instruction, interrupt: true };
      } else {
        speech = {
          text: `前方${Math.round(event.distanceMeters / 50) * 50}米，${instruction}`,
          interrupt: false,
          expiresAt: receivedAt + 3_000
        };
      }
    } else {
      if (
        event.kind !== "offRoute" &&
        event.kind !== "rerouteFailed" &&
        event.kind !== "arrived" &&
        event.kind !== "locationLost"
      ) {
        return;
      }
      const text = NAV_FIXED_TEXT[event.kind];
      speech = { text, interrupt: false };
    }

    if (seenPromptIds.has(event.promptId)) return;
    while (acceptedAt.length && receivedAt - acceptedAt[0]! >= ONE_MINUTE_MS) acceptedAt.shift();
    if (acceptedAt.length >= Math.max(0, Math.floor(maxPerMinute))) return;

    acceptedAt.push(receivedAt);
    seenPromptIds.add(event.promptId);
    if (seenPromptIds.size > MAX_RETAINED_PROMPT_IDS) {
      const oldest = seenPromptIds.values().next().value;
      if (oldest !== undefined) seenPromptIds.delete(oldest);
    }
    speak(speech);
  };
}
