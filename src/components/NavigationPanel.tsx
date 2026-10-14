// Guidance card + always-on SVG route schematic for the web HUD. The
// schematic (polyline normalized into a 280x160 viewBox, rider dot, maneuver
// markers) renders unconditionally whenever the panel itself renders — no
// Amap key is required for a fully functional panel. The optional Amap JS
// tile map (Task 9) mounts underneath this schematic without touching it.
//
// The 安全密钥 (security secret) that the Amap JS SDK needs for every request
// never reaches the browser: this component only ever sees the public JS key
// (from `/nav/js-config`) and points the SDK's internal requests at the
// relay's own `/_AMapService` proxy (server/amap-proxy.ts), which appends the
// secret server-side. With no key configured, `/nav/js-config` returns
// `{ key: null }` and the panel stays exactly as it is without this task: the
// schematic only, no script tag, no network request beyond the config fetch
// itself. A script-load failure degrades the same way, silently.

import { useEffect, useRef, useState } from "react";
import type { GeoPoint } from "../../shared/geo";
import { amapCameraPlan, applyAmapCameraPlan } from "../lib/amap-camera";
import type { AmapLatLng as AMapLatLng } from "../lib/amap-camera";
import { shouldMountAmapMap } from "../lib/amap-consent";
import type { AmapConsentDecision } from "../lib/amap-consent";
import type { NavPhase } from "../lib/navigation";
import { localized } from "../lib/i18n";
import { useLanguage } from "./LanguageToggle";

// Minimal surface of the Amap JS API 2.0 this component actually calls. The
// SDK is never bundled (it loads at runtime from webapi.amap.com), so there
// are no upstream types to import — this is deliberately narrow rather than
// `any`, matching the rest of this codebase's avoidance of `any`.
type AMapMapInstance = {
  destroy: () => void;
  // The camera is driven from the current route/rider on every change rather
  // than only at construction — see src/lib/amap-camera.ts.
  setFitView: (overlays: readonly unknown[]) => void;
  setCenter: (position: AMapLatLng) => void;
};
type AMapOverlay = { setMap: (map: AMapMapInstance | null) => void };
type AMapMarker = AMapOverlay & { setPosition: (position: AMapLatLng) => void };
type AMapNamespace = {
  Map: new (container: HTMLDivElement, options: { zoom: number; center: AMapLatLng }) => AMapMapInstance;
  Polyline: new (options: { path: AMapLatLng[]; strokeColor: string; strokeWeight: number }) => AMapOverlay;
  Marker: new (options: { position: AMapLatLng }) => AMapMarker;
};

declare global {
  interface Window {
    AMap?: AMapNamespace;
    _AMapSecurityConfig?: { serviceHost: string };
  }
}

// The Amap constructor requires a centre before any route or fix is known.
// It is never meaningfully visible: the camera effect points the map at the
// real route or rider on the same commit that creates it.
const PLACEHOLDER_CENTER: AMapLatLng = [116.397428, 39.90923];

// Translate the controller's known UI failures; provider-specific detail stays
// verbatim, like the destination and route instructions.
const NAVIGATION_ERROR_COPY = new Map<string, string>([
  [
    "请在浏览器设置中允许定位，再重新发起导航。",
    "Allow location access in your browser settings, then start navigation again."
  ],
  ["还没定位到，到室外或空旷处再说一次。", "No location fix yet. Move outdoors or to an open area, then try again."],
  ["没有找到目的地，请换一个名称重新导航。", "Destination not found. Try navigation again with a different name."],
  ["地图服务暂不可用，请稍后重新发起导航。", "The map service is unavailable. Try navigation again later."],
  [
    "重新规划失败，导航已停止。请稍后重新发起导航。",
    "Replanning failed and navigation stopped. Try navigation again later."
  ]
]);

// Module-level (not component-level) so every NavigationPanel mount across
// the app's lifetime reuses the same script tag/promise instead of injecting
// the Amap SDK repeatedly.
let amapScriptPromise: Promise<void> | null = null;

function loadAmapScript(key: string): Promise<void> {
  if (window.AMap) return Promise.resolve();
  if (amapScriptPromise) return amapScriptPromise;

  amapScriptPromise = new Promise<void>((resolve, reject) => {
    // Must be set before the script tag is injected: the SDK reads this
    // during its own initialization to route its internal tile/style/geocode
    // requests through the relay's secret-holding proxy instead of calling
    // Amap directly with no jscode.
    window._AMapSecurityConfig = { serviceHost: `${window.location.origin}/_AMapService` };
    const script = document.createElement("script");
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("amap script failed to load"));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    // Allow a later mount to retry after a transient network blip instead of
    // latching a permanent failure for the rest of the page's lifetime.
    amapScriptPromise = null;
    throw error;
  });

  return amapScriptPromise;
}

/** Fetches the public JS key once per app lifetime. Null (unset key, fetch
 *  failure, or non-browser environment) means "keep the schematic only" —
 *  never surfaced as an error. */
function useAmapJsKey(): string | null {
  const [key, setKey] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    fetch("/nav/js-config")
      .then((res) => (res.ok ? (res.json() as Promise<{ key?: string | null }>) : { key: null }))
      .then((data) => {
        if (!cancelled && typeof data.key === "string" && data.key) setKey(data.key);
      })
      .catch(() => {
        // Keyless mode must stay fully functional and silent; nothing to do.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return key;
}

function AmapTileMap({
  mapKey,
  polyline,
  rider,
  followsRider = false
}: {
  mapKey: string;
  followsRider?: boolean;
  polyline: readonly GeoPoint[];
  rider: GeoPoint | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<AMapMapInstance | null>(null);
  const polylineRef = useRef<AMapOverlay | null>(null);
  const markerRef = useRef<AMapMarker | null>(null);
  const [ready, setReady] = useState(false);

  // Load the SDK once for this mapKey and flag readiness; a failure warns
  // once and leaves `ready` false forever, so only the schematic shows.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    loadAmapScript(mapKey)
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((error: unknown) => {
        console.warn("Amap JS SDK failed to load; showing the route schematic only.", error);
      });
    return () => {
      cancelled = true;
    };
  }, [mapKey]);

  // Create the map instance once the SDK is ready, and destroy it on unmount.
  // The constructor demands some centre, but nothing depends on this one: the
  // camera effect below runs on the same commit and points it at whatever is
  // actually known. A route arriving later moves it again.
  useEffect(() => {
    if (!ready || typeof window === "undefined" || !window.AMap || !containerRef.current) return;
    mapRef.current = new window.AMap.Map(containerRef.current, {
      zoom: 15,
      center: PLACEHOLDER_CENTER
    });
    return () => {
      mapRef.current?.destroy();
      mapRef.current = null;
    };
    // Only re-runs when the SDK becomes ready: the map's camera and overlays
    // are updated by the effects below rather than by a full re-init.
  }, [ready]);

  // Keep the route polyline in sync with the current route, then point the
  // camera at it. These are deliberately one effect: the overlay is what
  // `setFitView` measures, so drawing it and framing it cannot be allowed to
  // drift apart — separating them is exactly how the camera got stranded.
  useEffect(() => {
    if (!ready || typeof window === "undefined" || !window.AMap || !mapRef.current) return;
    polylineRef.current?.setMap(null);
    polylineRef.current = null;
    if (polyline.length > 1) {
      const overlay = new window.AMap.Polyline({
        path: polyline.map((p): AMapLatLng => [p.lon, p.lat]),
        strokeColor: "#4fd1c5",
        strokeWeight: 4
      });
      overlay.setMap(mapRef.current);
      polylineRef.current = overlay;
    }
    applyAmapCameraPlan(mapRef.current, amapCameraPlan(polyline, rider), polylineRef.current);
    // `rider` only seeds the camera until a route exists; once one does the
    // plan ignores it, and the marker effect below tracks the rider instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, polyline]);

  // Keep the rider marker in sync with the current position.
  useEffect(() => {
    if (!ready || typeof window === "undefined" || !window.AMap || !mapRef.current) return;
    if (!rider) {
      markerRef.current?.setMap(null);
      markerRef.current = null;
      return;
    }
    const position: AMapLatLng = [rider.lon, rider.lat];
    if (markerRef.current) {
      markerRef.current.setPosition(position);
    } else {
      const marker = new window.AMap.Marker({ position });
      marker.setMap(mapRef.current);
      markerRef.current = marker;
    }
    if (followsRider) mapRef.current.setCenter(position);
  }, [ready, rider, followsRider]);

  useEffect(() => {
    if (ready && mapRef.current && !followsRider) {
      applyAmapCameraPlan(mapRef.current, amapCameraPlan(polyline, rider), polylineRef.current);
    }
  }, [ready, followsRider, polyline, rider]);

  // Nothing renders while the SDK is loading or if it never becomes ready
  // (absent key never gets here; a load failure leaves `ready` false
  // forever) — no placeholder box, no layout shift, panel stays exactly as
  // it is without the map, matching the schematic-only behavior above.
  if (!ready) return null;
  return <div ref={containerRef} className="navigationMap" aria-hidden="true" />;
}

/** Sits where the map would be, so the offer is discoverable without a modal
 *  interrupting a rider mid-navigation — the panel only exists while guiding.
 *  The full disclosure lives in the settings sheet; this is the doorway. */
function AmapConsentPrompt({ onEnable }: { onEnable: () => void }) {
  const { language } = useLanguage();
  return (
    <div className="navigationMapConsent">
      <p>
        {localized(
          language,
          "高德地图可显示路线底图。启用后，路线与当前位置会提供给高德用于地图显示。",
          "Amap can show a base map. When enabled, your route and current position are shared with Amap to display it."
        )}
      </p>
      <button type="button" onClick={onEnable}>
        {localized(language, "启用地图", "Enable map")}
      </button>
    </div>
  );
}

const VIEW_WIDTH = 280;
const VIEW_HEIGHT = 160;
const VIEW_PADDING = 18;

/** `SchematicBounds`, `computeBounds`, and `project` are exported for one
 *  reason, and it is not a caller in `src/`: the RDK board's bench HUD
 *  (`rdk/agent/src/hud/index.html`) reimplements this projection inline —
 *  that page is assembled by string substitution and cannot import shared
 *  code — and `tests/rdk-hud-render.test.ts` pins the two against a single
 *  fixture so they cannot drift apart silently. A cleanup pass that sees no
 *  caller outside `tests/` and un-exports these deletes the only thing
 *  catching board-vs-web drift. */
export type SchematicBounds = {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  scale: number;
  xOffset: number;
  yOffset: number;
};

export function computeBounds(polyline: readonly GeoPoint[]): SchematicBounds {
  const lats = polyline.map((p) => p.lat);
  const lons = polyline.map((p) => p.lon);
  const minLat = lats.length ? Math.min(...lats) : 0;
  const maxLat = lats.length ? Math.max(...lats) : 0;
  const minLon = lons.length ? Math.min(...lons) : 0;
  const maxLon = lons.length ? Math.max(...lons) : 0;
  const latSpan = maxLat - minLat;
  const lonSpan = maxLon - minLon;
  const innerWidth = VIEW_WIDTH - VIEW_PADDING * 2;
  const innerHeight = VIEW_HEIGHT - VIEW_PADDING * 2;
  // A constant axis should not constrain the other axis's scale. Keep its
  // actual zero span for centering, and use a finite scale for point routes.
  const scale =
    latSpan || lonSpan
      ? Math.min(lonSpan ? innerWidth / lonSpan : Infinity, latSpan ? innerHeight / latSpan : Infinity)
      : 1;
  const xOffset = VIEW_PADDING + (innerWidth - lonSpan * scale) / 2;
  const yOffset = VIEW_PADDING + (innerHeight - latSpan * scale) / 2;
  return { minLat, maxLat, minLon, maxLon, scale, xOffset, yOffset };
}

export function project(bounds: SchematicBounds, point: GeoPoint): { x: number; y: number } {
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
  const { language } = useLanguage();
  const bounds = computeBounds(polyline);
  const points = polyline.map((p) => project(bounds, p));
  const riderPoint = rider ? project(bounds, rider) : null;

  return (
    <svg
      className="navigationSchematic"
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      role="img"
      aria-label={localized(language, "路线示意图", "Route schematic")}
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

export function NavigationPanel({
  state,
  mapConsent = "unknown",
  onEnableMap
}: {
  state: NavPhase;
  /** Defaults to "unknown" so a caller that knows nothing about consent can
   *  never accidentally load the SDK. */
  mapConsent?: AmapConsentDecision;
  onEnableMap?: () => void;
}) {
  const { language } = useLanguage();
  const label = (zh: string, en: string) => localized(language, zh, en);
  // Called unconditionally, before either early return, per the Rules of
  // Hooks — Node-side/test renders (no window) always resolve to null, so
  // the tile map never mounts there and the schematic-only tests are
  // unaffected.
  const amapKey = useAmapJsKey();
  const [followsRider, setFollowsRider] = useState(true);
  const [expanded, setExpanded] = useState(false);
  // Gates the SDK, not the element: mounting AmapTileMap is what injects the
  // webapi.amap.com script and hands Amap the route.
  const mapAllowed = shouldMountAmapMap(amapKey, mapConsent);
  const mapOffered = Boolean(amapKey) && mapConsent === "unknown" && Boolean(onEnableMap);

  if (state.phase === "idle") return null;
  if (state.phase === "locating")
    return (
      <section className="navigationPanel" aria-label={label("导航", "Navigation")}>
        <p role="status">
          {label(
            "正在获取准确定位…请保持页面打开，并到室外或空旷处。",
            "Getting an accurate location… Keep this page open and move outdoors or to an open area."
          )}
        </p>
        <p>{state.query}</p>
      </section>
    );

  if (state.phase === "unavailable")
    return (
      <section className="navigationPanel" aria-label={label("导航", "Navigation")}>
        <p role="status">
          {language === "en-US" ? (NAVIGATION_ERROR_COPY.get(state.message) ?? state.message) : state.message}
        </p>
      </section>
    );

  if (state.phase === "requesting") {
    return (
      <section className="navigationPanel" aria-label={label("导航", "Navigation")}>
        <div className="navigationCard">
          <div className="navigationCardHead">
            <strong>{label("正在规划路线…", "Planning route…")}</strong>
          </div>
          <p className="navigationInstruction">{state.query}</p>
        </div>
        <RouteSchematic polyline={[]} maneuvers={[]} rider={null} />
        {mapAllowed && amapKey ? <AmapTileMap mapKey={amapKey} polyline={[]} rider={null} /> : null}
        {mapOffered ? <AmapConsentPrompt onEnable={onEnableMap!} /> : null}
      </section>
    );
  }

  const { route, update, position, locationStale } = state;
  const rider = locationStale ? null : position;
  const distanceRounded = Math.round(update.distanceToManeuverMeters / 10) * 10;
  const remainingKm = (update.remainingMeters / 1000).toFixed(1);
  const etaMinutes = Math.max(0, Math.round(update.remainingSeconds / 60));

  return (
    <section
      className={`navigationPanel ${expanded ? "navigationExpanded" : ""}`}
      aria-label={label("导航", "Navigation")}
    >
      <div className="navigationActions">
        <button type="button" aria-pressed={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? label("收起地图", "Collapse map") : label("展开地图", "Expand map")}
        </button>
        {mapAllowed ? (
          <button
            type="button"
            aria-pressed={followsRider}
            disabled={Boolean(locationStale)}
            onClick={() => setFollowsRider((value) => !value)}
          >
            {followsRider ? label("查看全程", "Show full route") : label("跟随位置", "Follow position")}
          </button>
        ) : null}
      </div>
      <div className="navigationCard">
        <div className="navigationCardHead">
          <strong>{route.destinationName}</strong>
          <span className="navigationEta" hidden={locationStale}>
            {label(`${remainingKm} 公里 · 约 ${etaMinutes} 分钟`, `${remainingKm} km · about ${etaMinutes} min`)}
          </span>
        </div>
        <p className="navigationInstruction" role={locationStale ? "status" : undefined}>
          {locationStale
            ? label(
                "定位信号较弱，导航已暂停。定位恢复后将自动继续。",
                "Location signal is weak. Navigation is paused and will resume when location recovers."
              )
            : update.currentInstruction}
        </p>
        <p className="navigationDistance" hidden={locationStale}>
          {distanceRounded} {label("米", "m")}
        </p>
        {!locationStale && update.offRoute ? (
          <p className="navigationOffRoute" role="status">
            {label("已偏离路线，重新规划中…", "Off route. Replanning…")}
          </p>
        ) : null}
      </div>
      <RouteSchematic polyline={route.polyline} maneuvers={route.steps} rider={rider} />
      {mapAllowed && amapKey ? (
        <AmapTileMap mapKey={amapKey} polyline={route.polyline} rider={rider} followsRider={followsRider} />
      ) : null}
      {mapOffered ? <AmapConsentPrompt onEnable={onEnableMap!} /> : null}
      <details className="navigationSteps">
        <summary>
          {label("路线步骤", "Route steps")} · {route.steps.length - update.progress.maneuverIndex}
        </summary>
        <ol>
          {route.steps.slice(update.progress.maneuverIndex).map((step, index) => (
            <li key={`${route.commandId}-${index}`}>
              <strong>{step.instruction}</strong>
              {!locationStale ? (
                <span>
                  {label("距当前位置", "From current position")}{" "}
                  {Math.round(Math.max(0, step.alongRouteMeters - (route.distanceMeters - update.remainingMeters)))}{" "}
                  {label("米", "m")}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
