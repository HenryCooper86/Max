// tests/navigation-panel.test.tsx
import { act } from "react";
import { describe, expect, it } from "vitest";
import { create } from "react-test-renderer";
import { NavigationPanel } from "../src/components/NavigationPanel";
import { INITIAL_PROGRESS, step } from "../shared/guidance";
import { MOCK_ROUTE } from "../shared/nav-fixtures";
import type { NavRouteEvent } from "../shared/agent";

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
