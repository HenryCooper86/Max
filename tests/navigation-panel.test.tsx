// tests/navigation-panel.test.tsx
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { create } from "react-test-renderer";
import { computeBounds, NavigationPanel, project } from "../src/components/NavigationPanel";
import { INITIAL_PROGRESS, step } from "../shared/guidance";
import { MOCK_ROUTE } from "../shared/nav-fixtures";
import type { NavRouteEvent } from "../shared/agent";
import type { NavPhase } from "../src/lib/navigation";
import { LanguageProvider, LanguageToggle } from "../src/components/LanguageToggle";

// This repo's installed React 19.2.7 + react-test-renderer 19.2.7 require the
// initial create() commit to run inside act() to flush synchronously — every
// other react-test-renderer test in this repo (e.g. language-toggle.test.tsx)
// does the same. Without it, toJSON() reads back null even though the
// component itself rendered content; verified directly against a trivial
// component before assuming NavigationPanel was at fault. The assertions and
// test structure below are otherwise verbatim from the task brief.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const route: NavRouteEvent = {
  type: "nav.route",
  commandId: "t",
  destinationName: "外滩",
  destination: MOCK_ROUTE.polyline.at(-1)!,
  distanceMeters: MOCK_ROUTE.distanceMeters,
  etaSeconds: MOCK_ROUTE.etaSeconds,
  polyline: MOCK_ROUTE.polyline,
  steps: MOCK_ROUTE.steps
};

describe("NavigationPanel", () => {
  it.each([
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
    ],
    ["Custom provider detail", "Custom provider detail"]
  ])("localizes known navigation failure %s while preserving custom error detail", async (message, expected) => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "en-US" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ key: null }) }));
    let tree: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        tree = create(
          <LanguageProvider>
            <NavigationPanel state={{ phase: "unavailable", message }} />
          </LanguageProvider>
        );
      });
      expect(tree!.root.findByProps({ role: "status" }).children).toEqual([expected]);
    } finally {
      act(() => tree?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("switches navigation controls and status copy while preserving route and destination text", async () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem: () => undefined } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ key: "public-key" }) }));
    let tree: ReturnType<typeof create> | undefined;
    const position = MOCK_ROUTE.polyline[0];
    const update = step(position, route, INITIAL_PROGRESS);
    const guiding: NavPhase = { phase: "guiding", route, update, position };
    const renderPanel = (state: NavPhase) => (
      <LanguageProvider>
        <LanguageToggle />
        <NavigationPanel state={state} onEnableMap={() => undefined} />
      </LanguageProvider>
    );
    try {
      await act(async () => {
        tree = create(renderPanel(guiding));
      });
      const english = tree!.root.find((node) => node.type === "button" && node.children.includes("EN"));
      act(() => english.props.onClick());
      let rendered = JSON.stringify(tree!.toJSON());
      expect(rendered).toContain("Expand map");
      expect(rendered).toContain("Route steps");
      expect(rendered).toContain("Enable map");
      expect(tree!.root.findByType("svg").props["aria-label"]).toBe("Route schematic");
      expect(rendered).toContain(route.destinationName);
      expect(rendered).toContain(update.currentInstruction);
      act(() => tree!.update(renderPanel({ ...guiding, locationStale: true })));
      expect(JSON.stringify(tree!.toJSON())).toContain("Navigation is paused");
      act(() => tree!.update(renderPanel({ phase: "locating", query: "外滩" })));
      expect(JSON.stringify(tree!.toJSON())).toContain("Getting an accurate location");
      act(() => tree!.update(renderPanel({ phase: "requesting", query: "外滩" })));
      expect(JSON.stringify(tree!.toJSON())).toContain("Planning route");
      const chinese = tree!.root.find((node) => node.type === "button" && node.children.includes("中文"));
      act(() => chinese.props.onClick());
      rendered = JSON.stringify(tree!.toJSON());
      expect(rendered).toContain("正在规划路线");
      expect(rendered).toContain("启用地图");
      expect(tree!.root.findByType("svg").props["aria-label"]).toBe("路线示意图");
    } finally {
      act(() => tree?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it.each([
    {
      direction: "north–south",
      polyline: [
        { lat: 31.23, lon: 121.47 },
        { lat: 31.24, lon: 121.47 }
      ],
      expected: [
        { x: 140, y: 142 },
        { x: 140, y: 18 }
      ]
    },
    {
      direction: "east–west",
      polyline: [
        { lat: 31.23, lon: 121.47 },
        { lat: 31.23, lon: 121.48 }
      ],
      expected: [
        { x: 18, y: 80 },
        { x: 262, y: 80 }
      ]
    }
  ])("fits a $direction route to the schematic and centers its constant axis", ({ polyline, expected }) => {
    const bounds = computeBounds(polyline);
    polyline.forEach((point, index) => {
      const projected = project(bounds, point);
      expect(projected.x).toBeCloseTo(expected[index]!.x);
      expect(projected.y).toBeCloseTo(expected[index]!.y);
    });
  });

  it("centers a point route with a finite scale", () => {
    const point = { lat: 31.23, lon: 121.47 };
    const bounds = computeBounds([point, point]);
    expect(Number.isFinite(bounds.scale)).toBe(true);
    expect(project(bounds, point)).toEqual({ x: 140, y: 80 });
  });

  it("shows instruction, distance, destination, and an svg route", () => {
    const position = MOCK_ROUTE.polyline[0];
    const update = step(position, route, INITIAL_PROGRESS);
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<NavigationPanel state={{ phase: "guiding", route, update, position }} />);
    });
    const text = JSON.stringify(tree!.toJSON());
    expect(text).toContain("外滩");
    expect(text).toContain(update.currentInstruction!);
    expect(text).toContain("svg");
  });

  it("renders nothing when idle", () => {
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<NavigationPanel state={{ phase: "idle" }} />);
    });
    expect(tree!.toJSON()).toBeNull();
  });
});

it("keeps the route mounted through GPS loss and recovery, hiding the stale rider", () => {
  const position = MOCK_ROUTE.polyline[0];
  const update = step(position, route, INITIAL_PROGRESS);
  const state = { phase: "guiding" as const, route, update, position };
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(<NavigationPanel state={state} />);
  });
  const schematic = tree!.root.findByType("svg");
  act(() => {
    tree!.update(<NavigationPanel state={{ ...state, locationStale: true }} />);
  });
  expect(tree!.root.findByType("svg")).toBe(schematic);
  expect(JSON.stringify(tree!.toJSON())).toContain("导航已暂停");
  expect(tree!.root.findAllByProps({ className: "navigationRider" })).toHaveLength(0);
  act(() => {
    tree!.update(<NavigationPanel state={state} />);
  });
  expect(tree!.root.findByType("svg")).toBe(schematic);
  expect(tree!.root.findAllByProps({ className: "navigationRider" })).toHaveLength(1);
  act(() => tree!.unmount());
});

it("shows actionable failure instead of removing the navigation panel", () => {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(<NavigationPanel state={{ phase: "unavailable", message: "地图服务暂不可用" }} />);
  });
  expect(tree!.root.findByProps({ role: "status" }).children).toContain("地图服务暂不可用");
  act(() => tree!.unmount());
});

it("expands the map and exposes upcoming route steps", () => {
  const position = MOCK_ROUTE.polyline[0];
  const update = step(position, route, INITIAL_PROGRESS);
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(<NavigationPanel state={{ phase: "guiding", route, update, position }} />);
  });
  const expand = tree!.root.findAllByType("button").find((button) => button.children.includes("展开地图"))!;
  act(() => expand.props.onClick());
  expect(tree!.root.findByType("section").props.className).toContain("navigationExpanded");
  expect(tree!.root.findByType("ol").findAllByType("li")).toHaveLength(
    route.steps.length - update.progress.maneuverIndex
  );
  act(() => tree!.unmount());
});
