// Guidance card + always-on SVG route schematic for the web HUD. The
// schematic (polyline normalized into a 280x160 viewBox, rider dot, maneuver
// markers) renders unconditionally whenever the panel itself renders — no
// Amap key is required for a fully functional panel. The optional Amap JS
// tile map (Task 9) mounts underneath this schematic without touching it.

import type { GeoPoint } from "../../shared/geo";
import type { NavPhase } from "../lib/navigation";

const VIEW_WIDTH = 280;
const VIEW_HEIGHT = 160;
const VIEW_PADDING = 18;

type SchematicBounds = {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  scale: number;
  xOffset: number;
  yOffset: number;
};

function computeBounds(polyline: readonly GeoPoint[]): SchematicBounds {
  const lats = polyline.map((p) => p.lat);
  const lons = polyline.map((p) => p.lon);
  const minLat = lats.length ? Math.min(...lats) : 0;
  const maxLat = lats.length ? Math.max(...lats) : 0;
  const minLon = lons.length ? Math.min(...lons) : 0;
  const maxLon = lons.length ? Math.max(...lons) : 0;
  // A degenerate (single-point or empty) route falls back to a 1-unit span
  // so the scale below stays finite instead of dividing by zero.
  const latSpan = maxLat - minLat || 1;
  const lonSpan = maxLon - minLon || 1;
  const innerWidth = VIEW_WIDTH - VIEW_PADDING * 2;
  const innerHeight = VIEW_HEIGHT - VIEW_PADDING * 2;
  const scale = Math.min(innerWidth / lonSpan, innerHeight / latSpan);
  const xOffset = VIEW_PADDING + (innerWidth - lonSpan * scale) / 2;
  const yOffset = VIEW_PADDING + (innerHeight - latSpan * scale) / 2;
  return { minLat, maxLat, minLon, maxLon, scale, xOffset, yOffset };
}

function project(bounds: SchematicBounds, point: GeoPoint): { x: number; y: number } {
  return {
    x: bounds.xOffset + (point.lon - bounds.minLon) * bounds.scale,
    // SVG y grows downward; north (higher latitude) must render toward the top.
    y: bounds.yOffset + (bounds.maxLat - point.lat) * bounds.scale
  };
}

function RouteSchematic({
  polyline,
  maneuvers,
  rider
}: {
  polyline: readonly GeoPoint[];
  maneuvers: ReadonlyArray<{ lat: number; lon: number }>;
  rider: GeoPoint | null;
}) {
  const bounds = computeBounds(polyline);
  const points = polyline.map((p) => project(bounds, p));
  const riderPoint = rider ? project(bounds, rider) : null;

  return (
    <svg
      className="navigationSchematic"
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      role="img"
      aria-label="路线示意图"
    >
      {points.length > 1 ? (
        <polyline className="navigationRoute" points={points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" />
      ) : null}
      {maneuvers.map((maneuver, index) => {
        const p = project(bounds, maneuver);
        return <circle key={index} className="navigationManeuver" cx={p.x} cy={p.y} r={4} />;
      })}
      {riderPoint ? <circle className="navigationRider" cx={riderPoint.x} cy={riderPoint.y} r={5} /> : null}
    </svg>
  );
}

export function NavigationPanel({ state }: { state: NavPhase }) {
  if (state.phase === "idle") return null;

  if (state.phase === "requesting") {
    return (
      <section className="navigationPanel" aria-label="导航">
        <div className="navigationCard">
          <div className="navigationCardHead">
            <strong>正在规划路线…</strong>
          </div>
          <p className="navigationInstruction">{state.query}</p>
        </div>
        <RouteSchematic polyline={[]} maneuvers={[]} rider={null} />
      </section>
    );
  }

  const { route, update, position } = state;
  const distanceRounded = Math.round(update.distanceToManeuverMeters / 10) * 10;
  const remainingKm = (update.remainingMeters / 1000).toFixed(1);
  const etaMinutes = Math.max(0, Math.round(update.remainingSeconds / 60));

  return (
    <section className="navigationPanel" aria-label="导航">
      <div className="navigationCard">
        <div className="navigationCardHead">
          <strong>{route.destinationName}</strong>
          <span className="navigationEta">
            {remainingKm} 公里 · 约 {etaMinutes} 分钟
          </span>
        </div>
        <p className="navigationInstruction">{update.currentInstruction}</p>
        <p className="navigationDistance">{distanceRounded} 米</p>
        {update.offRoute ? (
          <p className="navigationOffRoute" role="status">
            已偏离路线，重新规划中…
          </p>
        ) : null}
      </div>
      <RouteSchematic polyline={route.polyline} maneuvers={route.steps} rider={position} />
    </section>
  );
}
