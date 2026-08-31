// tests/amap-camera.test.ts
import { describe, expect, it, vi } from "vitest";
import { amapCameraPlan, applyAmapCameraPlan } from "../src/lib/amap-camera";
import type { AmapCameraTarget } from "../src/lib/amap-camera";
import type { GeoPoint } from "../shared/geo";

// The web map creates its instance once and previously only ever set a center
// at construction: the polyline effect drew the route but never moved the
// camera. When the SDK became ready before route data arrived, the map kept
// its fallback centre (Beijing) with the route drawn a thousand kilometres
// off-screen — the same defect just fixed on iOS, from the same cause.

const bund: readonly GeoPoint[] = [
  { lat: 31.2304, lon: 121.4737 },
  { lat: 31.2311, lon: 121.4744 },
  { lat: 31.232, lon: 121.4753 }
];

describe("amapCameraPlan", () => {
  it("fits the whole route when one is known", () => {
    expect(amapCameraPlan(bund, null)).toEqual({
      kind: "fit",
      path: [
        [121.4737, 31.2304],
        [121.4744, 31.2311],
        [121.4753, 31.232]
      ]
    });
  });

  it("centres on the rider when there is no route yet", () => {
    expect(amapCameraPlan([], { lat: 31.2304, lon: 121.4737 })).toEqual({
      kind: "center",
      at: [121.4737, 31.2304]
    });
  });

  // A single point is a position, not a route: fitting it would zoom to a
  // degenerate bounding box.
  it("centres rather than fits a one-point polyline", () => {
    expect(amapCameraPlan([bund[0]], null)).toEqual({
      kind: "center",
      at: [121.4737, 31.2304]
    });
  });

  it("asks for nothing when neither a route nor a rider is known", () => {
    expect(amapCameraPlan([], null)).toEqual({ kind: "none" });
  });

  it("prefers the route over the rider so the whole way stays visible", () => {
    expect(amapCameraPlan(bund, { lat: 39.9042, lon: 116.4074 }).kind).toBe("fit");
  });
});

describe("applyAmapCameraPlan", () => {
  function fakeMap() {
    return {
      setFitView: vi.fn(),
      setCenter: vi.fn(),
      destroy: vi.fn()
    };
  }

  /// The regression: a route arriving after the map exists must move the
  /// camera. Previously nothing did, so the fallback centre survived.
  it("fits the route overlay when a route arrives after the map exists", () => {
    const map = fakeMap();
    const overlay = { setMap: vi.fn() };

    applyAmapCameraPlan(map, amapCameraPlan(bund, null), overlay);

    expect(map.setFitView).toHaveBeenCalledTimes(1);
    expect(map.setFitView).toHaveBeenCalledWith([overlay]);
    expect(map.setCenter).not.toHaveBeenCalled();
  });

  it("centres on the rider when there is no route overlay to fit", () => {
    const map = fakeMap();

    applyAmapCameraPlan(map, amapCameraPlan([], { lat: 31.2304, lon: 121.4737 }), null);

    expect(map.setCenter).toHaveBeenCalledWith([121.4737, 31.2304]);
    expect(map.setFitView).not.toHaveBeenCalled();
  });

  // Without an overlay there is nothing for setFitView to frame, so a fit plan
  // has to fall back rather than silently leave the camera where it was.
  it("centres on the route start when a fit is asked for without an overlay", () => {
    const map = fakeMap();

    applyAmapCameraPlan(map, amapCameraPlan(bund, null), null);

    expect(map.setCenter).toHaveBeenCalledWith([121.4737, 31.2304]);
    expect(map.setFitView).not.toHaveBeenCalled();
  });

  it("leaves the camera alone when nothing is known", () => {
    const map: AmapCameraTarget = fakeMap();

    applyAmapCameraPlan(map, { kind: "none" }, null);

    expect((map as ReturnType<typeof fakeMap>).setFitView).not.toHaveBeenCalled();
    expect((map as ReturnType<typeof fakeMap>).setCenter).not.toHaveBeenCalled();
  });
});
