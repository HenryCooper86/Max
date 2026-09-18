/** Local HUD protocol v1. Coordinates are GCJ-02, already converted by the phone. */
export type CastPoint = { lat: number; lon: number };
export type CastTurn = CastPoint & { instruction: string; distance: number };
export type CastFrame = {
  type: "hud.frame";
  sequence: number;
  destination: string;
  instruction: string;
  distance: number;
  remaining: number;
  seconds: number;
  offRoute: boolean;
  polyline: CastPoint[];
  position: CastPoint | null;
  turns?: CastTurn[];
};

export function parseCastFrame(value: unknown): CastFrame {
  if (!value || typeof value !== "object") throw new Error("Invalid frame");
  const v = value as Record<string, unknown>;
  const number = (n: unknown, max: number): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max;
  const point = (p: unknown): p is CastPoint => {
    if (!p || typeof p !== "object") return false;
    const q = p as CastPoint;
    return (
      typeof q.lat === "number" &&
      Number.isFinite(q.lat) &&
      Math.abs(q.lat) <= 90 &&
      typeof q.lon === "number" &&
      Number.isFinite(q.lon) &&
      Math.abs(q.lon) <= 180
    );
  };
  if (
    v.type !== "hud.frame" ||
    !Number.isSafeInteger(v.sequence) ||
    (v.sequence as number) < 1 ||
    typeof v.destination !== "string" ||
    v.destination.length > 200 ||
    typeof v.instruction !== "string" ||
    v.instruction.length > 500 ||
    !number(v.distance, 50_000_000) ||
    !number(v.remaining, 50_000_000) ||
    !number(v.seconds, 10_000_000) ||
    typeof v.offRoute !== "boolean" ||
    !Array.isArray(v.polyline) ||
    v.polyline.length < 2 ||
    v.polyline.length > 2048 ||
    !v.polyline.every(point) ||
    !(v.position === null || point(v.position))
  )
    throw new Error("Invalid frame");
  let turns: CastTurn[] | undefined;
  if (v.turns !== undefined) {
    if (!Array.isArray(v.turns) || v.turns.length > 3) throw new Error("Invalid turns");
    turns = v.turns.map((turn: unknown) => {
      if (!point(turn)) throw new Error("Invalid turn coordinate");
      const t = turn as CastTurn;
      if (typeof t.instruction !== "string" || t.instruction.length > 500 || !number(t.distance, 50_000_000)) {
        throw new Error("Invalid turn");
      }
      return { lat: t.lat, lon: t.lon, instruction: t.instruction, distance: t.distance };
    });
  }
  // Rebuild, never pass arbitrary peer fields to the display.
  return {
    type: "hud.frame",
    sequence: v.sequence as number,
    destination: v.destination,
    instruction: v.instruction,
    distance: v.distance,
    remaining: v.remaining,
    seconds: v.seconds,
    offRoute: v.offRoute,
    polyline: v.polyline.map(({ lat, lon }) => ({ lat, lon })),
    position: v.position === null ? null : { lat: v.position.lat, lon: v.position.lon },
    ...(turns === undefined ? {} : { turns })
  };
}
