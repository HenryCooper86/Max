// tests/hud-layout.test.ts
import { describe, expect, it } from "vitest";
import { INITIAL_PROGRESS, step } from "../shared/guidance";
import { MOCK_ROUTE } from "../shared/nav-fixtures";
import { chromeAvailable, probeHudLayout } from "./support/hud-layout-probe";
import type { NavPhase } from "../src/lib/navigation";
import type { NavRouteEvent } from "../shared/agent";

// Geometry the rest of the suite cannot see: vitest has no browser and
// react-test-renderer never applies CSS, so every layout defect this file
// pins had already shipped. Each case below is a bug that reached a device.
//
// Skipped in CI (the Linux runner has no Chrome) and on any machine without
// Chrome installed, so it hardens local work without becoming a broken gate.
const enabled = !process.env.CI && chromeAvailable();

const route: NavRouteEvent = {
  type: "nav.route",
  commandId: "layout",
  destinationName: "外滩",
  destination: MOCK_ROUTE.polyline.at(-1)!,
  distanceMeters: MOCK_ROUTE.distanceMeters,
  etaSeconds: MOCK_ROUTE.etaSeconds,
  polyline: MOCK_ROUTE.polyline,
  steps: MOCK_ROUTE.steps
};

const position = MOCK_ROUTE.polyline[0];
const guiding: NavPhase = {
  phase: "guiding",
  route,
  update: step(position, route, INITIAL_PROGRESS),
  position
};

const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const DESKTOP = { width: 1440, height: 1000 };

describe.skipIf(!enabled)("HUD layout under a real browser", () => {
  describe("while navigating", () => {
    for (const [name, viewport] of [
      ["phone portrait", PORTRAIT],
      ["phone landscape", LANDSCAPE],
      ["desktop", DESKTOP]
    ] as const) {
      // The guidance card used to overrun the column: 38px past the fold in
      // portrait, 122px on desktop, taking the hands-free button with it.
      it(`keeps the shell within the viewport on ${name}`, () => {
        const result = probeHudLayout({ ...viewport, nav: guiding, captions: false });

        expect(result.shellOverflowPx).toBeLessThanOrEqual(0);
      });

      // The sole session control must stay reachable while a route is up.
      it(`keeps the hands-free control on screen on ${name}`, () => {
        const result = probeHudLayout({ ...viewport, nav: guiding, captions: false });

        expect(result.dockOnScreen).toBe(true);
      });

      // Landscape laid the card into a grid row collapsed to zero height.
      it(`does not clip the guidance card on ${name}`, () => {
        const result = probeHudLayout({ ...viewport, nav: guiding, captions: false });

        expect(result.navPanel).not.toBeNull();
        expect(result.navPanel!.clippedPx <= 8 || result.navPanel!.scrollable).toBe(true);
        expect(result.navPanel!.height).toBeGreaterThan(40);
      });
    }
  });

  describe("with captions open mid-route", () => {
    // Both shared one grid area and resolved to the identical rectangle, so
    // caption text painted over the maneuver and its distance.
    it("never draws captions over the guidance card in landscape", () => {
      const result = probeHudLayout({ ...LANDSCAPE, nav: guiding, captions: true });

      expect(result.navOverlapsTranscript).toBe(false);
      expect(result.navPanel).not.toBeNull();
      expect(result.transcript).not.toBeNull();
    });

    it("keeps the turn instruction readable rather than hiding it", () => {
      const result = probeHudLayout({ ...LANDSCAPE, nav: guiding, captions: true });

      // Compact, but still a real card rather than a collapsed sliver.
      expect(result.navPanel!.height).toBeGreaterThan(60);
    });

    it("still fits the viewport with both open in landscape", () => {
      const result = probeHudLayout({ ...LANDSCAPE, nav: guiding, captions: true });

      expect(result.shellOverflowPx).toBeLessThanOrEqual(0);
      expect(result.dockOnScreen).toBe(true);
    });
  });

  for (const viewport of [
    { width: 320, height: 568 },
    { width: 360, height: 640 },
    { width: 430, height: 932 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 568, height: 320 }
  ]) {
    for (const captions of [false, true]) {
      it(`fits controls, helmet and captions at ${viewport.width}x${viewport.height}, captions=${captions}`, () => {
        const result = probeHudLayout({ ...viewport, nav: guiding, captions });
        expect(result.viewport).toEqual(viewport);
        expect(result.shellOverflowPx).toBeLessThanOrEqual(1);
        expect(result.horizontalOverflowPx).toBeLessThanOrEqual(1);
        expect(result.helmetOverflowPx).toBeLessThanOrEqual(1);
        expect(result.dockOnScreen).toBe(true);
        expect(result.navPanel!.height).toBeGreaterThan(60);
        expect(result.navOverlapsTranscript).toBe(false);
        if (captions) expect(result.transcript!.height).toBeGreaterThanOrEqual(100);
      });
    }
  }

  // Nothing above should cost anything when no route is showing.
  it("leaves the idle shell within the viewport", () => {
    const result = probeHudLayout({ ...PORTRAIT, nav: null, captions: false });

    expect(result.shellOverflowPx).toBeLessThanOrEqual(0);
    expect(result.dockOnScreen).toBe(true);
    expect(result.navPanel).toBeNull();
  });
});
