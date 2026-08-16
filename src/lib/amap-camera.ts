// Where the Amap JS map should point, decided without touching the SDK or the
// DOM so it is unit-testable — the tile map itself cannot be exercised in this
// suite (no jsdom, and the SDK only loads with a configured JS key).
//
// This exists because the camera used to be set exactly once, when the map
// instance was constructed. The polyline effect drew each new route but never
// moved the camera, so a route that arrived after the SDK became ready left
// the map on its fallback centre with the route drawn off-screen. Deciding the
// camera from the current route/rider — and applying it on every change —
// removes the ordering dependency rather than papering over it.

import type { GeoPoint } from "../../shared/geo";

/** Amap's own coordinate order: [lon, lat], not [lat, lon]. */
export type AmapLatLng = [number, number];

/** The subset of the Amap map instance the camera needs. */
export type AmapCameraTarget = {
  setFitView: (overlays: readonly unknown[]) => void;
  setCenter: (position: AmapLatLng) => void;
};

export type AmapCameraPlan =
  { kind: "fit"; path: AmapLatLng[] } | { kind: "center"; at: AmapLatLng } | { kind: "none" };

function toAmap(point: GeoPoint): AmapLatLng {
  return [point.lon, point.lat];
}

/**
 * A real route wins over the rider so the whole way stays framed. A single
 * point is a position rather than a route — fitting it would frame a
 * degenerate bounding box — so it centres instead.
 */
export function amapCameraPlan(polyline: readonly GeoPoint[], rider: GeoPoint | null): AmapCameraPlan {
  if (polyline.length > 1) {
    return { kind: "fit", path: polyline.map(toAmap) };
  }
  const single = polyline[0] ?? rider;
  return single ? { kind: "center", at: toAmap(single) } : { kind: "none" };
}

/**
 * `setFitView` frames the drawn overlay, which is also what replaces the old
 * fixed zoom: a long route is framed rather than cropped. With no overlay to
 * frame there is nothing for it to measure, so fall back to the route's start
 * instead of leaving the camera wherever it happened to be.
 */
export function applyAmapCameraPlan(map: AmapCameraTarget, plan: AmapCameraPlan, routeOverlay: unknown | null): void {
  switch (plan.kind) {
    case "fit":
      if (routeOverlay) {
        map.setFitView([routeOverlay]);
      } else if (plan.path[0]) {
        map.setCenter(plan.path[0]);
      }
      return;
    case "center":
      map.setCenter(plan.at);
      return;
    case "none":
      return;
  }
}
