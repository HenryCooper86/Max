export type Observation = { at: number; type: string; [key: string]: unknown };
export type PlaybackSnapshot = {
  active: number;
  activeSourceIds: number[];
  browserSpeaking: boolean;
  contextState: string;
};
export type AssertionResult = { id: string; status: "pass" | "fail"; detail: string };
function eventPayload(item: Observation): Record<string, unknown> {
  return (item.event || {}) as Record<string, unknown>;
}
export function assertBackgroundQuiet(events: Observation[], initial: PlaybackSnapshot): void {
  if (initial.active || initial.browserSpeaking) throw new Error("Background began with pending agent speech");
  if (
    events.some(
      (item) =>
        ["audio.received", "playback.start", "speech.start"].includes(item.type) ||
        (item.type === "relay.event" &&
          eventPayload(item).type === "transcript" &&
          eventPayload(item).speaker === "agent")
    )
  )
    throw new Error("Agent produced transcript, PCM or speech for unaddressed background audio");
}
/** The socket observer snapshots the real queue before the production hazard handler. */
export function findHazardInterruption(events: Observation[]): { hazardAt: number; stoppedSourceIds: number[] } | null {
  for (let index = 0; index < events.length; index++) {
    const hazard = events[index]!;
    const payload = eventPayload(hazard);
    if (hazard.type !== "relay.event" || payload.type !== "hazard.alert" || payload.interrupt !== true) continue;
    const before = hazard.playbackBefore as PlaybackSnapshot | undefined;
    if (!before?.active || before.activeSourceIds.length !== before.active) continue;
    const stopped = new Set<number>();
    for (const next of events.slice(index + 1)) {
      if (
        next.at - hazard.at > 1000 ||
        ["relay.event", "audio.received", "playback.start", "speech.start"].includes(next.type)
      )
        break;
      if (next.type === "playback.stop" && typeof next.sourceId === "number") stopped.add(next.sourceId);
    }
    if (before.activeSourceIds.every((id) => stopped.has(id)))
      return { hazardAt: hazard.at, stoppedSourceIds: [...before.activeSourceIds] };
  }
  return null;
}
export function assertFullPcmLifecycle(events: Observation[], allowInterruptions = false): void {
  const permittedStops = new Set<number>();
  if (allowInterruptions) {
    for (let index = 0; index < events.length; index++) {
      if (events[index]?.type !== "relay.event" || eventPayload(events[index]!).type !== "hazard.alert") continue;
      const interruption = findHazardInterruption(events.slice(index));
      interruption?.stoppedSourceIds.forEach((id) => permittedStops.add(id));
    }
  }
  const received = events.filter((item) => item.type === "audio.received");
  const starts = events.filter((item) => item.type === "playback.start");
  if (
    !received.length ||
    received.some((item) => typeof item.bytes !== "number" || item.bytes <= 0 || item.bytes % 2 !== 0)
  )
    throw new Error("A complete valid relay PCM response was not received");
  if (starts.length !== received.length) throw new Error("Not every relay PCM chunk reached production playback");
  const expectedSamples = received.reduce((sum, item) => sum + (item.bytes as number) / 2, 0);
  const scheduledSamples = starts.reduce((sum, item) => sum + (typeof item.samples === "number" ? item.samples : 0), 0);
  if (expectedSamples !== scheduledSamples)
    throw new Error("PCM sample count was truncated during playback scheduling");
  if (
    !events.some(
      (item) =>
        (item.type === "playback.state" && item.state === "running") ||
        (item.type === "playback.start" && item.state === "running")
    )
  )
    throw new Error("Playback AudioContext never ran");
  for (const source of starts) {
    const naturalEnd = events.some(
      (item) => item.type === "playback.ended" && item.sourceId === source.sourceId && item.interrupted !== true
    );
    const stopped = events.some((item) => item.type === "playback.stop" && item.sourceId === source.sourceId);
    if (!naturalEnd && !(stopped && permittedStops.has(source.sourceId as number)))
      throw new Error(
        `PCM source ${source.sourceId} never finished${allowInterruptions ? " or stopped" : " naturally"}`
      );
    if (stopped && !permittedStops.has(source.sourceId as number))
      throw new Error("PCM response was interrupted without a correlated ADAS hazard");
  }
}
export function assertDisconnected(state: {
  captureActive: boolean;
  listening: boolean;
  connection: string;
  playback: PlaybackSnapshot;
}): void {
  if (
    state.captureActive ||
    state.listening ||
    state.connection !== "offline" ||
    state.playback.active ||
    state.playback.browserSpeaking ||
    !["closed", "none"].includes(state.playback.contextState)
  )
    throw new Error("Disconnect left capture, connection or agent playback active");
}
