import { describe, expect, it } from "vitest";
import {
  addStep,
  arrowsOf,
  connect,
  curve,
  flowProblems,
  flowToSave,
  NODE,
  placed,
  removeStep,
  renameStep,
  snap,
  stepAt,
  surfaceSize,
  tidy,
  type FlowStep
} from "../src/lib/flow";

const flow: FlowStep[] = [
  { id: "main", handoffs: [{ to: "orders", when: "An order." }] },
  { id: "orders", description: "Orders.", instructions: "Look it up.", handoffs: [{ to: "refunds" }, { to: "main" }] },
  { id: "refunds", description: "Money back.", instructions: "Refund.", handoffs: [] },
  { id: "sales", description: "Buying.", instructions: "Sell." }
];

describe("laying a flow out", () => {
  it("puts each step one column right of the first step that leads to it, and the rest last", () => {
    const laid = tidy(flow);
    const column = (id: string) => laid.find((step) => step.id === id)!.at![0];
    expect(column("main")).toBeLessThan(column("orders"));
    expect(column("orders")).toBeLessThan(column("refunds"));
    // No arrow leads to sales: it goes in the column after the last one reached.
    expect(column("sales")).toBeGreaterThan(column("refunds"));
    // No two steps on top of each other.
    const places = laid.map((step) => step.at!.join(","));
    expect(new Set(places).size).toBe(laid.length);
  });

  it("stacks the steps of one column", () => {
    const laid = tidy([
      { id: "main", handoffs: [{ to: "a" }, { to: "b" }] },
      { id: "a", handoffs: [] },
      { id: "b", handoffs: [] }
    ]);
    expect(laid[1]!.at![0]).toBe(laid[2]!.at![0]);
    expect(laid[2]!.at![1] - laid[1]!.at![1]).toBeGreaterThanOrEqual(NODE.height);
  });

  it("gives a place only to the steps that have none, clear of the ones that do", () => {
    const some = placed([{ ...flow[0]!, at: [40, 40] }, { ...flow[1]! }, { ...flow[2]!, at: [440, 40] }]);
    expect(some[0]!.at).toEqual([40, 40]);
    expect(some[2]!.at).toEqual([440, 40]);
    // Where the layout would put "orders" is taken by "refunds": it goes below.
    expect(some[1]!.at![0]).toBe(440);
    expect(some[1]!.at![1]).toBeGreaterThanOrEqual(40 + NODE.height);
    const all = [{ ...flow[0]!, at: [1, 2] as [number, number] }];
    expect(placed(all)).toEqual(all);
  });

  it("keeps a place on the grid and on the canvas", () => {
    expect(snap(123, 87)).toEqual([120, 90]);
    expect(snap(-40, 99999)).toEqual([0, 4000]);
  });

  it("sizes the canvas to hold every step with room to spare", () => {
    const [width, height] = surfaceSize([
      { id: "main", at: [40, 40] },
      { id: "a", at: [900, 300] }
    ]);
    expect(width).toBeGreaterThan(900 + NODE.width);
    expect(height).toBeGreaterThan(300 + NODE.height);
  });
});

describe("arrows", () => {
  it("draws one for each handoff written down, and none for a step open to any step", () => {
    const arrows = arrowsOf(tidy(flow));
    expect(arrows.map((arrow) => `${arrow.from}>${arrow.to}`)).toEqual([
      "main>orders",
      "orders>refunds",
      "orders>main"
    ]);
    expect(arrows[0]!.when).toBe("An order.");
    expect(arrows[1]).not.toHaveProperty("when");
    expect(arrows[0]!.path).toMatch(/^M \d+ \d+ C /);
  });

  it("leaves a step's right side for a step to the right, and its left side for one to the left", () => {
    const forward = curve([40, 40], [440, 40]);
    expect(forward.path.startsWith(`M ${40 + NODE.width} `)).toBe(true);
    expect(forward.path.endsWith(` 440 ${40 + NODE.height / 2 - 10}`)).toBe(true);
    const back = curve([440, 40], [40, 40]);
    expect(back.path.startsWith("M 440 ")).toBe(true);
    expect(back.path.endsWith(` ${40 + NODE.width} ${40 + NODE.height / 2 + 14}`)).toBe(true);
    // The two do not run on top of each other, and each label sits between the steps.
    expect(forward.middle[1]).not.toBe(back.middle[1]);
    expect(forward.middle[0]).toBeGreaterThan(40 + NODE.width);
    expect(forward.middle[0]).toBeLessThan(440);
  });

  it("finds the step under a point", () => {
    const laid = tidy(flow);
    const orders = laid[1]!;
    expect(stepAt(laid, orders.at![0] + 5, orders.at![1] + 5)?.id).toBe("orders");
    expect(stepAt(laid, orders.at![0] - 5, orders.at![1] + 5)).toBeUndefined();
  });
});

describe("changing a flow", () => {
  it("adds a step with a name nobody has, on a free place", () => {
    const laid = tidy(flow);
    const more = addStep(laid, "orders");
    const added = more.at(-1)!;
    expect(added).toMatchObject({ id: "step5", description: "", instructions: "" });
    expect(more.filter((step) => step.at!.join() === added.at!.join())).toHaveLength(1);
    expect(addStep([...laid, { id: "Step5", at: [0, 0] }]).at(-1)!.id).toBe("step6");
  });

  it("renames a step together with the arrows that lead to it", () => {
    const renamed = renameStep(flow, "orders", "billing");
    expect(renamed.map((step) => step.id)).toEqual(["main", "billing", "refunds", "sales"]);
    expect(renamed[0]!.handoffs).toEqual([{ to: "billing", when: "An order." }]);
    expect(renamed[3]).not.toHaveProperty("handoffs");
  });

  it("removes a step together with the arrows that led to it, but never the start", () => {
    const fewer = removeStep(flow, "refunds");
    expect(fewer.map((step) => step.id)).toEqual(["main", "orders", "sales"]);
    expect(fewer[1]!.handoffs).toEqual([{ to: "main" }]);
    expect(removeStep(flow, "main")).toEqual(flow);
  });

  it("draws an arrow once, and closes a step that was open to any step", () => {
    const drawn = connect(flow, "sales", "main");
    expect(drawn[3]!.handoffs).toEqual([{ to: "main" }]);
    expect(connect(drawn, "sales", "main")[3]!.handoffs).toEqual([{ to: "main" }]);
    expect(connect(flow, "orders", "orders")).toEqual(flow);
    expect(connect(flow, "main", "sales")[0]!.handoffs).toEqual([{ to: "orders", when: "An order." }, { to: "sales" }]);
  });
});

describe("what has to be right before a flow is saved", () => {
  const kinds = (steps: FlowStep[]) =>
    flowProblems(steps).map((problem) => `${problem.step}:${problem.field}:${problem.kind}`);

  it("finds nothing wrong with a complete flow, or with the start alone", () => {
    expect(kinds(flow)).toEqual([]);
    expect(kinds([{ id: "main" }])).toEqual([]);
    expect(kinds([{ id: "main", at: [0, 0] }])).toEqual([]);
  });

  it("names what is missing, too long, or named badly", () => {
    expect(kinds([{ id: "main", instructions: "Greet." }])).toEqual(["main:flow:alone"]);
    expect(kinds([{ id: "main" }, { id: "a" }])).toEqual(["a:description:missing", "a:instructions:missing"]);
    expect(kinds([{ id: "main" }, { id: "2nd", description: "x", instructions: "y" }])).toEqual(["2nd:id:invalid"]);
    expect(
      kinds([
        { id: "main" },
        { id: "a", description: "x", instructions: "y" },
        { id: "A", description: "x", instructions: "y" }
      ])
    ).toEqual(["a:id:twice", "A:id:twice"]);
    expect(
      kinds([
        { id: "main", handoffs: [{ to: "a", when: "w".repeat(301) }] },
        { id: "a", description: "d".repeat(401), instructions: "i".repeat(8001) }
      ])
    ).toEqual(["main:handoffs:long", "a:description:long", "a:instructions:long"]);
    expect(
      kinds(Array.from({ length: 13 }, (_, index) => ({ id: `s${index}`, description: "x", instructions: "y" })))
    ).toEqual(["main:flow:many"]);
  });

  it("sends the steps trimmed and without what is empty", () => {
    expect(
      flowToSave([
        { id: "main", instructions: "  ", handoffs: [{ to: "a", when: "  " }], at: [40, 40] },
        {
          id: " a ",
          description: " Buying. ",
          instructions: " Sell. ",
          tools: [],
          handoffs: [{ to: "main", when: " Done. " }]
        }
      ])
    ).toEqual([
      { id: "main", handoffs: [{ to: "a" }], at: [40, 40] },
      { id: "a", description: "Buying.", instructions: "Sell.", tools: [], handoffs: [{ to: "main", when: "Done." }] }
    ]);
  });
});
