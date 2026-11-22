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

  /** Types a name into the field and leaves it, as a user does. */
  async function rename(to: string) {
    await act(async () => field("flow-step-id").props.onChange({ currentTarget: { value: to } }));
    await act(async () => field("flow-step-id").props.onBlur());
  }

  it("renames a step along with the arrows that lead to it, once the field is left", async () => {
    const { api } = await mount();
    await select("orders");
    // Typing alone renames nothing: the name is a draft until the field is left.
    await act(async () => field("flow-step-id").props.onChange({ currentTarget: { value: "order desk" } }));
    expect(byClass("flowStep").map((node) => node.props["data-step"])).toEqual(["main", "orders", "refunds"]);
    await act(async () => field("flow-step-id").props.onBlur());
    expect(field("flow-step-id").props.value).toBe("order_desk");
    expect(byClass("flowStep").map((node) => node.props["data-step"])).toEqual(["main", "order_desk", "refunds"]);
    await act(async () => button(/保存流程/).props.onClick());
    const sent = api.saveStudioFlow.mock.calls[0]![0];
    expect(sent.map((step) => step.id)).toEqual(["main", "order_desk", "refunds"]);
    expect(sent[0]!.handoffs).toEqual([{ to: "order_desk", when: "An order." }]);
  });

  it("lets a name be typed through another step's name, and takes Enter as well", async () => {
    await mount();
    await select("orders");
    for (const typed of ["r", "refunds", "refunds_desk"]) {
      await act(async () => field("flow-step-id").props.onChange({ currentTarget: { value: typed } }));
      expect(field("flow-step-id").props.value).toBe(typed);
    }
    const prevented = vi.fn();
    await act(async () => field("flow-step-id").props.onKeyDown({ key: "Enter", preventDefault: prevented }));
    expect(prevented).toHaveBeenCalled();
    expect(byClass("flowStep").map((node) => node.props["data-step"])).toEqual(["main", "refunds_desk", "refunds"]);
  });

  it("refuses another step's name, the start's and one the relay would not take, and says so", async () => {
    await mount();
    await select("orders");
    const refusal = () => byClass("flowNameRefused").map(textOf).join("");
    for (const [name, said] of [
      ["Refunds", /已经有一步叫 Refunds/],
      ["MAIN", /main 是“开始”这一步的名称/],
      ["9lives", /这个名称不能用/]
    ] as const) {
      await rename(name);
      expect(refusal()).toMatch(said);
      expect(field("flow-step-id").props["aria-invalid"]).toBe(true);
      // The step keeps its name, and is still one that can be renamed and deleted.
      expect(byClass("flowStep").map((node) => node.props["data-step"])).toEqual(["main", "orders", "refunds"]);
      expect(button(/删除这一步/)).toBeTruthy();
    }
    expect(button(/保存流程/).props.disabled).toBe(true);
    // An emptied field goes back to the name the step has.
    await rename("  ");
    expect(field("flow-step-id").props.value).toBe("orders");
    expect(refusal()).toBe("");
    // Escape gives the draft up.
    await act(async () => field("flow-step-id").props.onChange({ currentTarget: { value: "elsewhere" } }));
    await act(async () => field("flow-step-id").props.onKeyDown({ key: "Escape", stopPropagation: () => {} }));
    expect(field("flow-step-id").props.value).toBe("orders");
  });

  it("goes back to the saved names on Discard after a rename", async () => {
    await mount();
    await select("orders");
    await rename("desk");
    await act(async () => button(/放弃修改/).props.onClick());
    expect(byClass("flowStep").map((node) => node.props["data-step"])).toEqual(["main", "orders", "refunds"]);
    expect(root().findAll((node) => node.props.id === "flow-step-id")).toHaveLength(0);
  });

  it("warns about steps no arrow leads to, without stopping the save", async () => {
    const { api } = await mount();
    const warnings = () => byClass("flowWarnings").map(textOf).join("");
    expect(warnings()).toBe("");
    // Deleting orders leaves refunds with no way in: Start's only arrow went with it.
    await select("orders");
    await act(async () => button(/删除这一步/).props.onClick());
    expect(warnings()).toMatch(/“开始”没有通往任何一步的箭头/);
    await act(async () => button(/保存流程/).props.onClick());
    expect(api.saveStudioFlow).toHaveBeenCalledOnce();
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
    const adder = byClass("flowAddArrow")[0]!.find((node) => node.type === "select");
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

  describe("what a step does by rule on arriving", () => {
    const ENTRY = {
      say: "One moment.",
      call: { tool: "find_order", arguments: { which: "latest" } },
      next: [{ to: "refunds", if: { path: "status", is: "delivered" } }, { to: "main" }]
    };
    const withEntry = (): FlowStep[] => [STEPS[0]!, { ...STEPS[1]!, onEnter: ENTRY }, STEPS[2]!];
    const labelled = (label: string) =>
      // Each row names its controls with the branch it is: "分支 1：条件".
      root().findAll(
        (node) => typeof node.type === "string" && String(node.props["aria-label"] ?? "").endsWith(`：${label}`)
      );
    const type = (node: ReactTestInstance, value: string) =>
      act(async () => node.props.onChange({ currentTarget: { value } }));

    it("shows it, draws its branches as arrows of their own, and saves it as it was", async () => {
      const { api } = await mount(fakeApi(flow(withEntry())));
      // Two handoffs and two branches.
      expect(arrowPaths().map((path) => path.props.className)).toEqual(["", "", "byRule", "byRule"]);
      expect(byClass("flowCondition").map(textOf)).toEqual(["An order.", "status = delivered"]);
      await select("orders");
      expect(field("flow-entry-say").props.value).toBe("One moment.");
      expect(field("flow-entry-tool").props.value).toBe("find_order");
      expect(field("flow-entry-arguments").props.value).toBe('{"which":"latest"}');
      expect(labelled("转到哪一步").map((node) => node.props.value)).toEqual(["refunds", "main"]);
      expect(labelled("条件").map((node) => node.props.value)).toEqual(["is", "always"]);
      // A change elsewhere, and the save carries the onEnter along untouched.
      await type(field("flow-step-instructions"), "Help with the order.");
      await act(async () => button(/保存流程/).props.onClick());
      expect(api.saveStudioFlow.mock.calls[0]![0][1]).toEqual({
        ...STEPS[1],
        instructions: "Help with the order.",
        onEnter: ENTRY
      });
    });

    it("writes a sentence, a call with arguments and branches", async () => {
      const { api } = await mount();
      await select("orders");
      await type(field("flow-entry-say"), "  One moment,   please. ");
      await type(field("flow-entry-tool"), "find_order");
      // Not JSON yet: said so, and the arguments stay as they were.
      await type(field("flow-entry-arguments"), '{ "which": ');
      await act(async () => field("flow-entry-arguments").props.onBlur());
      expect(byClass("flowNameRefused").map(textOf).join()).toContain("不是一个 JSON 对象");
      await type(field("flow-entry-arguments"), '{ "which": "latest" }');
      await act(async () => field("flow-entry-arguments").props.onBlur());
      expect(byClass("flowNameRefused")).toEqual([]);
      await act(async () => button(/添加一个分支/).props.onClick());
      // A branch with nothing to compare with cannot be saved.
      await act(async () => button(/保存流程/).props.onClick());
      expect(api.saveStudioFlow).not.toHaveBeenCalled();
      expect(byClass("flowProblems").map(textOf).join()).toContain("有一个分支没有写比较的值");
      await type(labelled("转到哪一步")[0]!, "refunds");
      await type(labelled("看答复里的哪一项")[0]!, " order.total ");
      await type(labelled("条件")[0]!, "above");
      await type(labelled("比较的值")[0]!, "100.5");
      await act(async () => button(/添加一个分支/).props.onClick());
      await type(labelled("条件")[1]!, "failed");
      await act(async () => button(/保存流程/).props.onClick());
      expect(api.saveStudioFlow.mock.calls[0]![0][1]!.onEnter).toEqual({
        say: "One moment, please.",
        call: { tool: "find_order", arguments: { which: "latest" } },
        next: [
          { to: "refunds", if: { path: "order.total", above: 100.5 } },
          { to: "main", if: { failed: true } }
        ]
      });
    });

    it("keeps a list of values as it is typed, and reads numbers among them", async () => {
      const { api } = await mount(fakeApi(flow(withEntry())));
      await select("orders");
      await type(labelled("条件")[0]!, "in");
      await type(labelled("比较的值")[0]!, "shipped, ");
      // The comma that was just typed is still there.
      expect(labelled("比较的值")[0]!.props.value).toBe("shipped, ");
      await type(labelled("比较的值")[0]!, "shipped, packed, 3");
      await act(async () => button(/保存流程/).props.onClick());
      expect(api.saveStudioFlow.mock.calls[0]![0][1]!.onEnter!.next![0]).toEqual({
        to: "refunds",
        if: { path: "status", in: ["shipped", "packed", 3] }
      });
    });

    it("keeps as text what a number would write differently", async () => {
      const { api } = await mount(fakeApi(flow(withEntry())));
      await select("orders");
      // A postcode, a price and an id longer than a number can hold: the relay compares "is" as text.
      for (const [typedIn, saved] of [
        ["02134", "02134"],
        ["1.50", "1.50"],
        ["12345678901234567890", "12345678901234567890"],
        ["1e3", "1e3"],
        ["40", 40],
        ["-2.5", -2.5],
        ["true", true]
      ] as const) {
        await type(labelled("比较的值")[0]!, typedIn);
        await act(async () => button(/保存流程/).props.onClick());
        expect(api.saveStudioFlow.mock.calls.at(-1)![0][1]!.onEnter!.next![0]!.if).toEqual({
          path: "status",
          is: saved
        });
      }
      await type(labelled("条件")[0]!, "in");
      await type(labelled("比较的值")[0]!, "02134, 10001");
      await act(async () => button(/保存流程/).props.onClick());
      expect(api.saveStudioFlow.mock.calls.at(-1)![0][1]!.onEnter!.next![0]!.if).toEqual({
        path: "status",
        in: ["02134", 10001]
      });
    });

    it("names the controls of each branch with the branch they belong to", async () => {
      await mount(fakeApi(flow(withEntry())));
      await select("orders");
      const names = root()
        .findAll((node) => node.type === "select" && String(node.props["aria-label"] ?? "").startsWith("分支"))
        .map((node) => node.props["aria-label"]);
      expect(names).toEqual([
        "分支 1：转到哪一步",
        "分支 1：看什么",
        "分支 1：条件",
        "分支 2：转到哪一步",
        "分支 2：条件"
      ]);
    });

    it("writes what a step asks for first, what it keeps, and a branch on a value", async () => {
      const { api } = await mount(fakeApi(flow(withEntry())));
      await select("orders");
      await act(async () => button(/添加一个值/).props.onClick());
      await type(labelled("名字")[0]!, "order_number");
      await type(labelled("它是什么")[0]!, "  The number of the order ");
      await act(async () => button(/添加一个值/).props.onClick());
      await type(labelled("名字")[1]!, "amount");
      await type(labelled("它是什么")[1]!, "How much back");
      await type(labelled("类型")[1]!, "number");
      await act(async () => labelled("必填")[1]!.props.onChange({ currentTarget: { checked: false } }));
      // The sentence and the arguments use it.
      await type(field("flow-entry-say"), "Looking up order {{order_number}}.");
      await type(field("flow-entry-arguments"), '{"number":"{{order_number}}"}');
      await act(async () => field("flow-entry-arguments").props.onBlur());
      // Something of the answer is kept, and the first branch goes by it.
      await act(async () => button(/保存一个值/).props.onClick());
      await type(labelled("名字")[2]!, "status");
      await type(labelled("在答复里的位置")[0]!, "order.status");
      await type(labelled("看什么")[0]!, "value");
      await type(labelled("值的名字")[0]!, "status");
      await act(async () => button(/保存流程/).props.onClick());
      const saved = api.saveStudioFlow.mock.calls[0]![0][1]!;
      expect(saved.collect).toEqual([
        { name: "order_number", description: "The number of the order", type: "text", required: true },
        { name: "amount", description: "How much back", type: "number", required: false }
      ]);
      expect(saved.onEnter).toEqual({
        say: "Looking up order {{order_number}}.",
        call: { tool: "find_order", arguments: { number: "{{order_number}}" } },
        save: { status: "order.status" },
        next: [{ to: "refunds", if: { value: "status", is: "delivered" } }, { to: "main" }]
      });
      // And it comes back as it was saved.
      expect(byClass("flowCondition").map(textOf)).toContain("{{status}} = delivered");
    });

    it("says what is wrong with a value before it is saved", async () => {
      const { api } = await mount(fakeApi(flow(withEntry())));
      await select("orders");
      const refusedWith = async (text: RegExp) => {
        await act(async () => button(/保存流程/).props.onClick());
        expect(api.saveStudioFlow).not.toHaveBeenCalled();
        expect(byClass("flowProblems").map(textOf).join(" ")).toMatch(text);
      };
      await act(async () => button(/添加一个值/).props.onClick());
      await refusedWith(/值的名字用小写字母/);
      await type(labelled("名字")[0]!, "order_number");
      await refusedWith(/每个值都要写明它是什么/);
      await type(labelled("它是什么")[0]!, "The number");
      // A value nobody asks for or keeps.
      await type(field("flow-entry-say"), "Order {{order_numbr}}.");
      await refusedWith(/用到了 \{\{order_numbr\}\}，没有哪一步先问或保存它/);
      // Braces around what is no name would be said aloud as they are written.
      await type(field("flow-entry-say"), "Order {{Order Number}}.");
      await refusedWith(/\{\{Order Number\}\} 不是一个值的写法/);
      // Nor can a value take a name the relay or the handover has.
      await type(field("flow-entry-say"), "One moment.");
      await type(labelled("名字")[0]!, "channel");
      await refusedWith(/不能叫 channel、agent 或 values/);
      await type(labelled("名字")[0]!, "order_number");
      await type(field("flow-entry-say"), "Order {{order_number}} for {{user.id}}.");
      await act(async () => button(/保存流程/).props.onClick());
      expect(api.saveStudioFlow).toHaveBeenCalledTimes(1);
    });

    it("offers nothing to ask for first at the start, and drops what was kept with the tool", async () => {
      const { api } = await mount(fakeApi(flow(withEntry())));
      await select("main");
      expect(root().findAll((node) => node.type === "button" && /添加一个值/.test(textOf(node)))).toEqual([]);
      await select("orders");
      await act(async () => button(/保存一个值/).props.onClick());
      await type(labelled("名字")[0]!, "status");
      await type(labelled("在答复里的位置")[0]!, "status");
      // No tool, no answer to keep from; the branch that read the answer goes too, by hand.
      await type(field("flow-entry-tool"), "");
      await act(async () => labelled("删除")[0]!.props.onClick());
      await act(async () => button(/保存流程/).props.onClick());
      expect(api.saveStudioFlow.mock.calls[0]![0][1]!.onEnter).toEqual({ say: "One moment.", next: [{ to: "main" }] });
    });

    it("keeps both rows while a kept value's name passes through the name of another", async () => {
      const { api } = await mount(fakeApi(flow(withEntry())));
      await select("orders");
      await act(async () => button(/保存一个值/).props.onClick());
      await type(labelled("名字")[0]!, "status");
      await type(labelled("在答复里的位置")[0]!, "order.status");
      await act(async () => button(/保存一个值/).props.onClick());
      await type(labelled("在答复里的位置")[1]!, "order.status_code");
      // On the way to "status_code" the second name is "status" for a moment.
      await type(labelled("名字")[1]!, "status");
      expect(labelled("名字").map((node) => node.props.value)).toEqual(["status", "status"]);
      expect(
        root()
          .findAll((node) => node.props.role === "alert")
          .map(textOf)
          .join(" ")
      ).toMatch(/同一个名字/);
      await type(labelled("名字")[1]!, "status_code");
      expect(
        root()
          .findAll((node) => node.props.role === "alert")
          .map(textOf)
          .join(" ")
      ).not.toMatch(/同一个名字/);
      await act(async () => button(/保存流程/).props.onClick());
      expect(api.saveStudioFlow.mock.calls[0]![0][1]!.onEnter!.save).toEqual({
        status: "order.status",
        status_code: "order.status_code"
      });
    });

    it("writes what the start does when a conversation starts, apart from when one is handed back", async () => {
      const { api } = await mount(fakeApi(flow(withEntry())));
      await select("main");
      // The start shows what is done when a conversation starts.
      expect(field("flow-entry-when").props.value).toBe("onStart");
      await type(field("flow-entry-say"), "I am checking your account.");
      await type(field("flow-entry-tool"), "find_order");
      await act(async () => button(/添加一个分支/).props.onClick());
      await type(labelled("转到哪一步")[0]!, "refunds");
      await type(labelled("条件")[0]!, "failed");
      // And, apart from it, what is done when a conversation is handed back.
      await type(field("flow-entry-when"), "onEnter");
      expect(field("flow-entry-say").props.value).toBe("");
      await type(field("flow-entry-say"), "Back with me.");
      await type(field("flow-entry-when"), "onStart");
      expect(field("flow-entry-say").props.value).toBe("I am checking your account.");
      // The branch at the start is an arrow of its own.
      expect(byClass("flowCondition").map(textOf)).toContain("call failed");
      await act(async () => button(/保存流程/).props.onClick());
      const main = api.saveStudioFlow.mock.calls[0]![0][0]!;
      expect(main.onStart).toEqual({
        say: "I am checking your account.",
        call: { tool: "find_order", arguments: {} },
        next: [{ to: "refunds", if: { failed: true } }]
      });
      expect(main.onEnter).toEqual({ say: "Back with me." });
      // Another step has no such choice.
      await select("orders");
      expect(root().findAll((node) => node.props.id === "flow-entry-when")).toEqual([]);
    });

    it("has one name be one value: asked of the user or kept from a tool, and of one type", async () => {
      await mount(fakeApi(flow(withEntry())));
      const refusedWith = async (text: RegExp) => {
        await act(async () => button(/保存流程/).props.onClick());
        expect(
          root()
            .findAll((node) => node.props.role === "alert")
            .map(textOf)
            .join(" ")
        ).toMatch(text);
      };
      // Orders keeps "status" from its tool. Refunds cannot ask the user for it too.
      await select("orders");
      await act(async () => button(/保存一个值/).props.onClick());
      await type(labelled("名字")[0]!, "status");
      await type(labelled("在答复里的位置")[0]!, "order.status");
      await select("refunds");
      await act(async () => button(/添加一个值/).props.onClick());
      await type(labelled("名字")[0]!, "status");
      await type(labelled("它是什么")[0]!, "The status");
      await refusedWith(/要么问用户，要么从工具保存/);
      // Nor can a value be a text for one step and a number for another.
      await type(labelled("名字")[0]!, "order_number");
      await type(labelled("类型")[0]!, "number");
      await select("orders");
      await act(async () => button(/添加一个值/).props.onClick());
      await type(labelled("名字")[0]!, "order_number");
      await type(labelled("它是什么")[0]!, "The number of the order");
      await refusedWith(/同一个名字只能是一种类型/);
    });

    it("opens the start on what is written for it, and says which of the two a problem is with", async () => {
      const steps = withEntry();
      await mount(fakeApi(flow([{ ...steps[0]!, onEnter: { say: "Back with me." } }, ...steps.slice(1)])));
      await select("main");
      // Only "handed back" is written: that is what is shown.
      expect(field("flow-entry-when").props.value).toBe("onEnter");
      expect(field("flow-entry-say").props.value).toBe("Back with me.");
      // Emptying it does not flip the editor to the other while it is being typed in.
      await type(field("flow-entry-say"), "");
      expect(field("flow-entry-when").props.value).toBe("onEnter");
      await type(field("flow-entry-say"), "Back {{Nobody}}.");
      await type(field("flow-entry-when"), "onStart");
      await act(async () => button(/保存流程/).props.onClick());
      expect(
        root()
          .findAll((node) => node.props.role === "alert")
          .map(textOf)
          .join(" ")
      ).toMatch(/开始（对话被转交回来时）：\{\{Nobody\}\} 不是一个值的写法/);
    });

    it("will not save a branch with a condition and no call, or a tool the step may not use", async () => {
      const { api } = await mount(fakeApi(flow(withEntry())));
      await select("orders");
      await type(field("flow-entry-tool"), "");
      await act(async () => button(/保存流程/).props.onClick());
      expect(byClass("flowProblems").map(textOf).join()).toContain("带条件的分支要看工具的答复");
      await type(field("flow-entry-tool"), "refund");
      await act(async () => button(/保存流程/).props.onClick());
      expect(byClass("flowProblems").map(textOf).join()).toContain("不在这一步可以用的工具里");
      expect(api.saveStudioFlow).not.toHaveBeenCalled();
    });

    it("removes a branch, and with a step the branches that led to it", async () => {
      const { api } = await mount(fakeApi(flow(withEntry())));
      await select("orders");
      await act(async () => labelled("删除")[1]!.props.onClick());
      expect(labelled("转到哪一步").map((node) => node.props.value)).toEqual(["refunds"]);
      await select("refunds");
      confirmAnswer = true;
      await act(async () => button(/删除这一步/).props.onClick());
      await act(async () => button(/保存流程/).props.onClick());
      expect(api.saveStudioFlow.mock.calls[0]![0][1]!.onEnter).toEqual({ say: ENTRY.say, call: ENTRY.call });
    });
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
