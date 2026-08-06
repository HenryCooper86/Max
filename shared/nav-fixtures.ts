import type { NavManeuver } from "./agent";
import type { GeoPoint } from "./geo";

/** Served by the relay's MockRouteProvider when AMAP_API_KEY is unset, and
 *  walked by the web HUD's demo ride simulator. GCJ-02, like every nav.*
 *  coordinate. alongRouteMeters values are the cumulative haversine distances
 *  of the legs (4 × 166.4 m north, then 3 × 142.8 m east). */
export const MOCK_ROUTE: {
  distanceMeters: number;
  etaSeconds: number;
  polyline: GeoPoint[];
  steps: NavManeuver[];
} = {
  distanceMeters: 1094,
  etaSeconds: 240,
  polyline: [
    { lat: 31.2304, lon: 121.4737 },
    { lat: 31.2319, lon: 121.4737 },
    { lat: 31.2334, lon: 121.4737 },
    { lat: 31.2349, lon: 121.4737 },
    { lat: 31.2364, lon: 121.4737 },
    { lat: 31.2364, lon: 121.4752 },
    { lat: 31.2364, lon: 121.4767 },
    { lat: 31.2364, lon: 121.4782 }
  ],
  steps: [
    { instruction: "右转进入南京东路", lat: 31.2364, lon: 121.4737, alongRouteMeters: 666 },
    { instruction: "到达终点", lat: 31.2364, lon: 121.4782, alongRouteMeters: 1094 }
  ]
};
