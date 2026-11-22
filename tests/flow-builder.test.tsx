import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECTION_LEAVE_EVENT } from "../src/components/admin/AssistantStudio";
import { FlowBuilder } from "../src/components/admin/FlowBuilder";
import type { ApiResult } from "../src/lib/api-client";
import type { FlowStep } from "../src/lib/flow";
import type { StudioFlow } from "../src/lib/studio-api";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const STEPS: FlowStep[] = [
  { id: "main", handoffs: [{ to: "orders", when: "An order." }], at: [40, 40] },
  {
    id: "orders",
    description: "Orders.",
    instructions: "Look the order up.",
    tools: ["find_order"],
    handoffs: [{ to: "refunds" }],
    at: [440, 40]
  },
  { id: "refunds", description: "Money back.", instructions: "Refund politely.", at: [840, 40] }
];

const flow = (steps: FlowStep[] = STEPS, problems: string[] = []): StudioFlow => ({
  ok: true,
  steps,
  tools: ["find_order", "refund"],
  problems
});

function fakeApi(initial: StudioFlow = flow()) {
  return {
    fetchStudioFlow: vi.fn(async (): Promise<ApiResult<StudioFlow>> => ({ ok: true, data: initial })),
    saveStudioFlow: vi.fn<(steps: FlowStep[]) => Promise<ApiResult<StudioFlow>>>(async (steps) => ({
      ok: true,
      data: flow(steps)
    }))
  };
}

type Listener = (event: Event) => void;
let listeners: Map<string, Set<Listener>>;
let confirmAnswer: boolean;
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  listeners = new Map();
  confirmAnswer = false;
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => listeners.get(type)?.delete(listener),
    confirm: vi.fn(() => confirmAnswer),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function mount(api = fakeApi(), onExpired = vi.fn()) {
  await act(async () => {
    renderer = create(<FlowBuilder api={api} onAuthenticationExpired={onExpired} />);
  });
  return { api, onExpired };
}

const root = () => renderer!.root;
function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
}
const byClass = (name: string) =>
  root().findAll(
    (node) =>
      typeof node.type === "string" &&
      String(node.props.className ?? "")
        .split(" ")
        .includes(name)
  );
const stepNode = (id: string) => byClass("flowStep").find((node) => node.props["data-step"] === id)!;
const button = (label: RegExp) =>
  root().find((node: ReactTestInstance) => node.type === "button" && label.test(textOf(node).trim()));
const field = (id: string) => root().find((node) => node.props.id === id);
const status = () => textOf(byClass("studioStatus")[0]!);
const arrowPaths = () => root().findAll((node) => node.type === "path" && node.props.markerEnd !== undefined);
const select = (id: string) => act(async () => stepNode(id).props.onClick());
const pointer = (x: number, y: number, target: object = {}) => ({
  button: 0,
  pointerId: 1,
  clientX: x,
  clientY: y,
  currentTarget: target,
  stopPropagation: () => {},
  preventDefault: () => {}
});

describe("flow builder", () => {
  it("draws the steps and an arrow for each handoff, the start first", async () => {
    const { api } = await mount();
    expect(api.fetchStudioFlow).toHaveBeenCalledOnce();
    expect(byClass("flowStep").map((node) => node.props["data-step"])).toEqual(["main", "orders", "refunds"]);
    expect(stepNode("main").props.style).toMatchObject({ left: 40, top: 40 });
    expect(textOf(stepNode("main"))).toContain("开始");
    expect(arrowPaths()).toHaveLength(2);
    // The condition is written on its arrow.
    expect(byClass("flowCondition").map(textOf)).toEqual(["An order."]);
    // A step without written handoffs is open to any step; one with a tool list says how many.
    expect(textOf(stepNode("refunds"))).toContain("可转到任意一步");
    expect(textOf(stepNode("orders"))).toContain("1 个工具");
    expect(status()).toContain("没有未保存");
    expect(button(/保存流程/).props.disabled).toBe(true);
  });

  it("gives a place to steps that have none, without calling that a change", async () => {
    const unplaced = STEPS.map((step) => Object.fromEntries(Object.entries(step).filter(([key]) => key !== "at")));
    await mount(fakeApi(flow(unplaced as FlowStep[])));
    const places = byClass("flowStep").map((node) => `${node.props.style.left},${node.props.style.top}`);
    expect(new Set(places).size).toBe(3);
    expect(button(/保存流程/).props.disabled).toBe(true);
  });

  it("edits a step and saves the flow as drawn", async () => {
    const { api } = await mount();
    await select("orders");
    expect(field("flow-step-id").props.value).toBe("orders");
    await act(async () =>
      field("flow-step-instructions").props.onChange({ currentTarget: { value: "  Ask for the number first.  " } })
    );
    expect(status()).toContain("未保存");
    await act(async () => button(/保存流程/).props.onClick());
    expect(api.saveStudioFlow).toHaveBeenCalledWith([
      STEPS[0],
      { ...STEPS[1], instructions: "Ask for the number first." },
      STEPS[2]
    ]);
    expect(status()).toContain("已保存");
    expect(button(/保存流程/).props.disabled).toBe(true);
  });

  it("renames a step along with the arrows that lead to it", async () => {
    const { api } = await mount();
    await select("orders");
    await act(async () => field("flow-step-id").props.onChange({ currentTarget: { value: "order desk" } }));
    expect(field("flow-step-id").props.value).toBe("order_desk");
    // A name another step has is not taken.
    await act(async () => field("flow-step-id").props.onChange({ currentTarget: { value: "refunds" } }));
    expect(field("flow-step-id").props.value).toBe("order_desk");
    await act(async () => button(/保存流程/).props.onClick());
    const sent = api.saveStudioFlow.mock.calls[0]![0];
    expect(sent.map((step) => step.id)).toEqual(["main", "order_desk", "refunds"]);
    expect(sent[0]!.handoffs).toEqual([{ to: "order_desk", when: "An order." }]);
  });

  it("adds a step, and will not save it until it says when to come to it and what to do", async () => {
    const { api } = await mount();
    await act(async () => button(/添加一步/).props.onClick());
    expect(byClass("flowStep")).toHaveLength(4);
    // The new step is the one being edited.
    expect(field("flow-step-id").props.value).toBe("step4");
    await act(async () => button(/保存流程/).props.onClick());
    expect(api.saveStudioFlow).not.toHaveBeenCalled();
    const listed = byClass("flowProblems")[0]!;
    expect(textOf(listed)).toContain("step4：写上什么时候进入这一步");
    expect(textOf(listed)).toContain("step4：写上这一步的指令");
    expect(String(stepNode("step4").props.className)).toContain("flawed");
    await act(async () => field("flow-step-description").props.onChange({ currentTarget: { value: "Buying." } }));
    await act(async () => field("flow-step-instructions").props.onChange({ currentTarget: { value: "Sell." } }));
    await act(async () => button(/保存流程/).props.onClick());
    expect(api.saveStudioFlow.mock.calls[0]![0].at(-1)).toMatchObject({
      id: "step4",
      description: "Buying.",
      instructions: "Sell."
    });
  });

  it("draws an arrow by dragging from a step's dot to another step", async () => {
    const { api } = await mount();
    const handle = stepNode("refunds").findByProps({ className: "flowHandle" });
    await act(async () => handle.props.onPointerDown(pointer(1060, 90)));
    await act(async () => handle.props.onPointerMove(pointer(600, 120)));
    // While it is drawn, a dashed line follows the pointer.
    expect(root().findAll((node) => node.type === "path" && node.props.className === "drawing")).toHaveLength(1);
    // Let go over "main".
    await act(async () => handle.props.onPointerUp(pointer(100, 80)));
    expect(arrowPaths()).toHaveLength(3);
    // Let go over nothing: no arrow.
    await act(async () => handle.props.onPointerDown(pointer(1060, 90)));
    await act(async () => handle.props.onPointerUp(pointer(700, 400)));
    expect(arrowPaths()).toHaveLength(3);
    await act(async () => button(/保存流程/).props.onClick());
    // The step was open to any step; with an arrow drawn it leads only where its arrows do.
    expect(api.saveStudioFlow.mock.calls[0]![0][2]!.handoffs).toEqual([{ to: "main" }]);
  });

  it("moves a step by dragging it, and with the arrow keys", async () => {
    const { api } = await mount();
    const node = stepNode("orders");
    const captured: number[] = [];
    await act(async () =>
      node.props.onPointerDown(pointer(500, 60, { setPointerCapture: (id: number) => captured.push(id) }))
    );
    await act(async () => node.props.onPointerMove(pointer(533, 204)));
    await act(async () => node.props.onPointerUp(pointer(533, 204)));
    expect(captured).toEqual([1]);
    expect(stepNode("orders").props.style).toMatchObject({ left: 470, top: 180 });
    // Moving the pointer without holding a step does nothing.
    await act(async () => stepNode("orders").props.onPointerMove(pointer(900, 900)));
    expect(stepNode("orders").props.style).toMatchObject({ left: 470, top: 180 });
    const target = {};
    await act(async () =>
      stepNode("orders").props.onKeyDown({ key: "ArrowRight", target, currentTarget: target, preventDefault: () => {} })
    );
    expect(stepNode("orders").props.style).toMatchObject({ left: 490, top: 180 });
    await act(async () => button(/保存流程/).props.onClick());
    expect(api.saveStudioFlow.mock.calls[0]![0][1]!.at).toEqual([490, 180]);
  });

  it("adds, conditions and removes arrows in the editor, and opens a step to any step again", async () => {
    const { api } = await mount();
    await select("orders");
    const adder = root().find((node) => node.type === "select");
    // The steps there is no arrow to yet.
    expect(adder.findAllByType("option").map((option) => option.props.value)).toEqual(["", "main"]);
    await act(async () => adder.props.onChange({ currentTarget: { value: "main" } }));
    const when = root().find((node) => node.type === "input" && node.props["aria-label"] === "什么时候转到 开始");
    await act(async () => when.props.onChange({ currentTarget: { value: "Something else." } }));
    await act(async () => button(/保存流程/).props.onClick());
    expect(api.saveStudioFlow.mock.calls[0]![0][1]!.handoffs).toEqual([
      { to: "refunds" },
      { to: "main", when: "Something else." }
    ]);
    const remove = root().find(
      (node) => node.type === "button" && node.props["aria-label"] === "删除通向 refunds 的箭头"
    );
    await act(async () => remove.props.onClick());
    expect(arrowPaths()).toHaveLength(2);
    const any = root().find(
      (node) => node.type === "input" && node.props.type === "checkbox" && /任意一步/.test(textOf(node.parent!))
    );
    await act(async () => any.props.onChange({ currentTarget: { checked: true } }));
    await act(async () => button(/保存流程/).props.onClick());
    expect(api.saveStudioFlow.mock.calls[1]![0][1]).not.toHaveProperty("handoffs");
  });

  it("limits a step to some tools, a client's own among them", async () => {
    const { api } = await mount();
    await select("refunds");
    const every = () =>
      root().find(
        (node) => node.type === "input" && node.props.type === "checkbox" && /全部工具/.test(textOf(node.parent!))
      );
    expect(every().props.checked).toBe(true);
    await act(async () => every().props.onChange({ currentTarget: { checked: false } }));
    const box = (name: string) =>
      root().find((node) => node.type === "input" && node.props.type === "checkbox" && textOf(node.parent!) === name);
    await act(async () => box("refund").props.onChange({ currentTarget: { checked: true } }));
    const other = root().find((node) => node.type === "input" && node.props["aria-label"] === "另一个工具的名称");
    await act(async () => other.props.onChange({ currentTarget: { value: " open_page " } }));
    await act(async () => button(/^添加$/).props.onClick());
    expect(box("open_page").props.checked).toBe(true);
    await act(async () => button(/保存流程/).props.onClick());
    expect(api.saveStudioFlow.mock.calls[0]![0][2]!.tools).toEqual(["refund", "open_page"]);
  });

  it("deletes a step with its arrows, but offers no such thing for the start", async () => {
    const { api } = await mount();
    await select("main");
    expect(root().findAll((node) => node.type === "button" && /删除这一步/.test(textOf(node)))).toHaveLength(0);
    expect(root().findAll((node) => node.props.id === "flow-step-id")).toHaveLength(0);
    await select("refunds");
    await act(async () => button(/删除这一步/).props.onClick());
    expect(byClass("flowStep")).toHaveLength(2);
    expect(arrowPaths()).toHaveLength(1);
    await act(async () => button(/保存流程/).props.onClick());
    expect(api.saveStudioFlow.mock.calls[0]![0][1]!.handoffs).toEqual([]);
  });

  it("goes back to the saved flow on discard, and lays it out afresh on request", async () => {
    await mount();
    await act(async () => button(/添加一步/).props.onClick());
    await act(async () => button(/放弃修改/).props.onClick());
    expect(byClass("flowStep")).toHaveLength(3);
    expect(button(/保存流程/).props.disabled).toBe(true);
    await select("orders");
    await act(async () => stepNode("orders").props.onPointerDown(pointer(500, 60)));
    await act(async () => stepNode("orders").props.onPointerMove(pointer(900, 500)));
    await act(async () => stepNode("orders").props.onPointerUp(pointer(900, 500)));
    await act(async () => button(/整理布局/).props.onClick());
    expect(stepNode("orders").props.style).toMatchObject({ left: 440, top: 40 });
  });

  it("shows the relay's reason when a save is refused, and keeps the drawing", async () => {
    const api = fakeApi();
    api.saveStudioFlow.mockResolvedValue({
      ok: false,
      error: { kind: "http", status: 400, message: "Agent orders: there is no agent legal to hand over to." }
    } as ApiResult<StudioFlow>);
    await mount(api);
    await select("orders");
    await act(async () => field("flow-step-instructions").props.onChange({ currentTarget: { value: "New." } }));
    await act(async () => button(/保存流程/).props.onClick());
    expect(status()).toBe("Agent orders: there is no agent legal to hand over to.");
    expect(field("flow-step-instructions").props.value).toBe("New.");
    expect(button(/保存流程/).props.disabled).toBe(false);
  });

  it("says what the relay left out of a config written by hand", async () => {
    await mount(fakeApi(flow(STEPS, ["agent sales needs instructions"])));
    expect(textOf(byClass("flowError")[0]!)).toContain("agent sales needs instructions");
  });

  it("asks before another section opens with unsaved changes, and not otherwise", async () => {
    await mount();
    const leave = () => {
      const event = new Event(SECTION_LEAVE_EVENT, { cancelable: true });
      for (const listener of listeners.get(SECTION_LEAVE_EVENT) ?? []) listener(event);
      return !event.defaultPrevented;
    };
    expect(leave()).toBe(true);
    await act(async () => button(/添加一步/).props.onClick());
    confirmAnswer = false;
    expect(leave()).toBe(false);
    confirmAnswer = true;
    expect(leave()).toBe(true);
    expect(listeners.get("beforeunload")?.size).toBe(1);
  });

  it("signs the admin out when the relay no longer accepts the token", async () => {
    const api = fakeApi();
    api.fetchStudioFlow.mockResolvedValueOnce({
      ok: false,
      error: { kind: "unauthorized", status: 401, message: "no" }
    } as ApiResult<StudioFlow>);
    const { onExpired } = await mount(api);
    expect(onExpired).toHaveBeenCalledOnce();
    expect(textOf(byClass("flowError")[0]!)).toBe("no");
  });
});
