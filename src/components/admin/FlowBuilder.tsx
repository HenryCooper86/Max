import { ArrowRight, FloppyDisk, Plus, SquaresFour, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  addStep,
  arrowsOf,
  connect,
  curve,
  flowProblems,
  flowToSave,
  MAX_STEPS,
  NODE,
  placed,
  removeStep,
  renameStep,
  snap,
  START,
  stepAt,
  surfaceSize,
  tidy,
  type FlowProblem,
  type FlowStep
} from "../../lib/flow";
import { localized } from "../../lib/i18n";
import { SECTION_LEAVE_EVENT } from "./AssistantStudio";
import { fetchStudioFlow, saveStudioFlow } from "../../lib/studio-api";
import { useLanguage } from "../LanguageToggle";

const DEFAULT_API = { fetchStudioFlow, saveStudioFlow };

type Props = {
  onAuthenticationExpired: () => void;
  /** Injected in tests. */
  api?: typeof DEFAULT_API;
};

type Status = { kind: "idle" | "saved" | "error"; message?: string };

const isStart = (id: string) => id.toLowerCase() === START;

/**
 * Admin → Studio → Flow: the assistant's agents drawn as steps, with an arrow
 * for each handover and the condition written on it. What is drawn here is the
 * `agents` key of the assistant config.
 */
export function FlowBuilder({ onAuthenticationExpired, api = DEFAULT_API }: Props) {
  const { language } = useLanguage();
  const say = useCallback((zh: string, en: string) => localized(language, zh, en), [language]);
  const [steps, setSteps] = useState<FlowStep[] | null>(null);
  const [saved, setSaved] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [showProblems, setShowProblems] = useState(false);
  const [busy, setBusy] = useState(false);
  const [extraTool, setExtraTool] = useState("");
  // An arrow being drawn: from which step, and where the pointer is on the canvas.
  const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: string; pointer: [number, number]; origin: [number, number] } | null>(null);

  const adopt = useCallback((flow: { steps: FlowStep[]; tools: string[]; problems: string[] }) => {
    const laid = placed(flow.steps);
    setSteps(laid);
    setSaved(JSON.stringify(flowToSave(laid)));
    setTools(flow.tools);
    setSkipped(flow.problems);
    setSelected((current) => (current && laid.some((step) => step.id === current) ? current : null));
  }, []);

  useEffect(() => {
    let active = true;
    void api.fetchStudioFlow().then((result) => {
      if (!active) return;
      if (result.ok) adopt(result.data);
      else {
        if (result.error.kind === "unauthorized") onAuthenticationExpired();
        setLoadError(result.error.message);
      }
    });
    return () => {
      active = false;
    };
    // Load once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const dirty = steps !== null && JSON.stringify(flowToSave(steps)) !== saved;
  // Unsaved changes: confirm before the tab closes, the workspace closes, or another section opens.
  useEffect(() => {
    if (!dirty) return;
    const message = say("放弃流程里未保存的修改？", "Discard your unsaved changes to the flow?");
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const onLeave = (event: Event) => {
      if (!event.defaultPrevented && !window.confirm(message)) event.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("admin:beforeleave", onLeave);
    window.addEventListener(SECTION_LEAVE_EVENT, onLeave);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("admin:beforeleave", onLeave);
      window.removeEventListener(SECTION_LEAVE_EVENT, onLeave);
    };
  }, [dirty, say]);

  // A step that was just added or chosen from the list of problems may lie outside what the canvas shows.
  useEffect(() => {
    if (selected === null) return;
    const node = [...(surface.current?.querySelectorAll<HTMLElement>("[data-step]") ?? [])].find(
      (element) => element.dataset.step === selected
    );
    node?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected]);

  const problems = useMemo(() => (steps ? flowProblems(steps) : []), [steps]);
  const arrows = useMemo(() => (steps ? arrowsOf(steps) : []), [steps]);

  if (loadError) {
    return (
      <section className="flowBuilder studioScope" aria-labelledby="studio-flow">
        <h3 id="studio-flow">{say("流程", "Flow")}</h3>
        <p className="flowError" role="alert">
          {loadError}
        </p>
      </section>
    );
  }
  if (!steps) {
    return (
      <section className="flowBuilder studioScope" aria-labelledby="studio-flow">
        <h3 id="studio-flow">{say("流程", "Flow")}</h3>
        <p role="status">{say("正在读取流程…", "Loading the flow…")}</p>
      </section>
    );
  }

  const change = (next: FlowStep[]) => {
    setSteps(next);
    setStatus({ kind: "idle" });
  };
  const patch = (id: string, values: Partial<FlowStep>) =>
    change(steps.map((step) => (step.id === id ? { ...step, ...values } : step)));
  const current = steps.find((step) => step.id === selected);
  const [width, height] = surfaceSize(steps);
  const nameOf = (id: string) => (isStart(id) ? say("开始", "Start") : id);

  const describe = (problem: FlowProblem): string => {
    const step = nameOf(problem.step);
    if (problem.field === "flow") {
      return problem.kind === "many"
        ? say(`一个流程最多 ${MAX_STEPS} 步。`, `A flow has at most ${MAX_STEPS} steps.`)
        : say(
            "流程除了“开始”至少还要有一步。添加一步，或者清空“开始”里填写的内容。",
            "A flow needs at least one step besides Start. Add a step, or clear what is written in Start."
          );
    }
    if (problem.field === "id") {
      return problem.kind === "twice"
        ? say(`有两步都叫 ${step}。`, `Two steps are called ${step}.`)
        : say(
            `“${step}”不能作为名称：以字母开头，只用字母、数字、_ 和 -，最多 32 个字符。`,
            `"${step}" cannot be a step's name: start with a letter and use letters, digits, _ and -, 32 characters at most.`
          );
    }
    if (problem.kind === "long") {
      return problem.field === "instructions"
        ? say(`${step}：指令最多 8000 个字符。`, `${step}: the instructions can be 8,000 characters at most.`)
        : problem.field === "description"
          ? say(`${step}：说明最多 400 个字符。`, `${step}: the description can be 400 characters at most.`)
          : say(`${step}：箭头上的条件最多 300 个字符。`, `${step}: a condition can be 300 characters at most.`);
    }
    return problem.field === "instructions"
      ? say(`${step}：写上这一步的指令。`, `${step}: write this step's instructions.`)
      : say(
          `${step}：写上什么时候进入这一步，其他步骤靠它判断。`,
          `${step}: say when to come to this step. The other steps go by it.`
        );
  };

  const save = async () => {
    setShowProblems(true);
    if (problems.length > 0) {
      setStatus({
        kind: "error",
        message: say("先修正下面列出的问题再保存。", "Fix what is listed below, then save.")
      });
      return;
    }
    setBusy(true);
    const result = await api.saveStudioFlow(flowToSave(steps));
    setBusy(false);
    if (!result.ok) {
      if (result.error.kind === "unauthorized") onAuthenticationExpired();
      setStatus({ kind: "error", message: result.error.message });
      return;
    }
    adopt(result.data);
    setShowProblems(false);
    setStatus({
      kind: "saved",
      message: say("流程已保存。新的会话会立即使用。", "Flow saved. New sessions use it from now on.")
    });
  };

  const discard = () => {
    const before = JSON.parse(saved) as FlowStep[];
    setSteps(before);
    setSelected((id) => (id && before.some((step) => step.id === id) ? id : null));
    setShowProblems(false);
    setStatus({ kind: "idle" });
  };

  // ---- moving a step, and drawing an arrow from one ------------------------

  const point = (event: PointerEvent): [number, number] => {
    const box = surface.current?.getBoundingClientRect();
    return [event.clientX - (box?.left ?? 0), event.clientY - (box?.top ?? 0)];
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>, step: FlowStep) => {
    if (event.button !== 0 || !step.at) return;
    drag.current = { id: step.id, pointer: [event.clientX, event.clientY], origin: step.at };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSelected(step.id);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (!held) return;
    const at = snap(held.origin[0] + event.clientX - held.pointer[0], held.origin[1] + event.clientY - held.pointer[1]);
    setSteps((all) => (all ? all.map((step) => (step.id === held.id ? { ...step, at } : step)) : all));
  };
  const endDrag = () => {
    drag.current = null;
  };

  const startLink = (event: PointerEvent<HTMLButtonElement>, step: FlowStep) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const [x, y] = point(event);
    setLinking({ from: step.id, x, y });
  };
  const moveLink = (event: PointerEvent<HTMLButtonElement>) => {
    if (!linking) return;
    const [x, y] = point(event);
    setLinking({ ...linking, x, y });
  };
  const endLink = (event: PointerEvent<HTMLButtonElement>) => {
    if (!linking) return;
    const [x, y] = point(event);
    const target = stepAt(steps, x, y);
    if (target && target.id !== linking.from) {
      change(connect(steps, linking.from, target.id));
      setSelected(linking.from);
    }
    setLinking(null);
  };

  const nudge = (event: KeyboardEvent<HTMLDivElement>, step: FlowStep) => {
    const by: Record<string, [number, number]> = {
      ArrowLeft: [-20, 0],
      ArrowRight: [20, 0],
      ArrowUp: [0, -20],
      ArrowDown: [0, 20]
    };
    const move = by[event.key];
    if (move && step.at && event.target === event.currentTarget) {
      event.preventDefault();
      patch(step.id, { at: snap(step.at[0] + move[0], step.at[1] + move[1]) });
    } else if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
      event.preventDefault();
      setSelected(step.id);
    }
  };

  const linkFrom = linking ? steps.find((step) => step.id === linking.from)?.at : undefined;
  const flawed = new Set(showProblems ? problems.map((problem) => problem.step) : []);
  const targetsLeft = current
    ? steps.filter((step) => step.id !== current.id && !current.handoffs?.some((handoff) => handoff.to === step.id))
    : [];
  const toolChoices = current ? [...new Set([...tools, ...(current.tools ?? [])])] : [];

  return (
    <section className="flowBuilder studioScope" aria-labelledby="studio-flow">
      <h3 id="studio-flow" className="visuallyHidden">
        {say("流程", "Flow")}
      </h3>
      <p className="flowNote">
        {say(
          "每一步有自己的指令和可用的工具；箭头决定对话可以从哪一步走到哪一步、在什么情况下走。每次对话都从“开始”出发。只有“开始”一步时，助手就是一个整体，不分步骤。保存后新的会话立即生效。",
          "Each step has its own instructions and the tools it may use. The arrows say where a conversation can go from a step, and when. Every conversation begins at Start. With Start alone, the assistant works as one, without steps. New sessions use a saved flow straight away."
        )}
      </p>
      {skipped.length > 0 ? (
        <p className="flowError" role="alert">
          {say(
            "配置文件里有中继无法使用、因此没有显示的部分：",
            "The config file holds parts the relay cannot use, which are not shown here: "
          )}
          {skipped.join("; ")}
        </p>
      ) : null}

      <div className="flowToolbar">
        <button
          type="button"
          className="studioButton"
          disabled={busy || steps.length >= MAX_STEPS}
          onClick={() => {
            const next = addStep(steps, selected ?? undefined);
            change(next);
            setSelected(next.at(-1)!.id);
          }}
        >
          <Plus size={16} aria-hidden="true" /> {say("添加一步", "Add a step")}
        </button>
        <button type="button" className="studioButton quiet" disabled={busy} onClick={() => change(tidy(steps))}>
          <SquaresFour size={16} aria-hidden="true" /> {say("整理布局", "Tidy up")}
        </button>
        <span className="flowToolbarSave">
          <button type="button" className="studioButton" disabled={!dirty || busy} onClick={discard}>
            {say("放弃修改", "Discard")}
          </button>
          <button type="button" className="studioButton primary" disabled={!dirty || busy} onClick={() => void save()}>
            <FloppyDisk size={16} aria-hidden="true" />{" "}
            {busy ? say("保存中…", "Saving…") : say("保存流程", "Save the flow")}
          </button>
        </span>
      </div>
      <p role="status" className={`studioStatus ${status.kind}`}>
        {status.message ??
          (dirty
            ? say("流程有未保存的修改。", "The flow has unsaved changes.")
            : say("流程没有未保存的修改。", "No unsaved changes to the flow."))}
      </p>
      <p className="flowToolbarHint">
        {say(
          "拖动一步来移动它，或者选中后用方向键。从一步右边的圆点拖到另一步，画出箭头。",
          "Drag a step to move it, or select it and use the arrow keys. Drag from the dot on a step's right edge to another step to draw an arrow."
        )}
      </p>

      <div className="flowCanvas" role="group" aria-label={say("流程画布", "Flow canvas")}>
        <div className="flowSurface" ref={surface} style={{ width, height }}>
          <svg className="flowArrows" width={width} height={height} aria-hidden="true">
            <defs>
              <marker
                id="flow-arrowhead"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {arrows.map((arrow) => (
              <path
                key={`${arrow.from}>${arrow.to}`}
                className={arrow.from === selected ? "selected" : ""}
                d={arrow.path}
                markerEnd="url(#flow-arrowhead)"
              />
            ))}
            {linking && linkFrom ? (
              <path className="drawing" d={curve(linkFrom, [linking.x, linking.y - NODE.height / 2 + 10]).path} />
            ) : null}
          </svg>
          {arrows
            .filter((arrow) => arrow.when)
            .map((arrow) => (
              <span
                key={`${arrow.from}>${arrow.to}`}
                className={`flowCondition${arrow.from === selected ? " selected" : ""}`}
                style={{ left: arrow.middle[0], top: arrow.middle[1] }}
                title={arrow.when}
              >
                {arrow.when}
              </span>
            ))}
          {steps.map((step) => {
            const open = step.handoffs === undefined && steps.length > 1;
            const end = step.handoffs?.length === 0;
            return (
              <div
                key={step.id}
                className={`flowStep${step.id === selected ? " selected" : ""}${isStart(step.id) ? " start" : ""}${flawed.has(step.id) ? " flawed" : ""}`}
                style={{ left: step.at?.[0] ?? 0, top: step.at?.[1] ?? 0, width: NODE.width, height: NODE.height }}
                data-step={step.id}
                role="button"
                tabIndex={0}
                aria-pressed={step.id === selected}
                aria-label={say(`步骤 ${nameOf(step.id)}`, `Step ${nameOf(step.id)}`)}
                onPointerDown={(event) => startDrag(event, step)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onClick={() => setSelected(step.id)}
                onKeyDown={(event) => nudge(event, step)}
              >
                <strong>
                  {nameOf(step.id)}
                  {isStart(step.id) ? null : flawed.has(step.id) ? <em>{say("待补全", "Incomplete")}</em> : null}
                </strong>
                <span className="flowStepText">
                  {step.instructions?.trim() ||
                    (isStart(step.id)
                      ? say("使用助手自己的指令。", "The assistant's own instructions.")
                      : say("还没有指令。", "No instructions yet."))}
                </span>
                <span className="flowStepMeta">
                  {step.tools
                    ? say(
                        `${step.tools.length} 个工具`,
                        `${step.tools.length} ${step.tools.length === 1 ? "tool" : "tools"}`
                      )
                    : say("全部工具", "Every tool")}
                  {open ? say(" · 可转到任意一步", " · to any step") : end ? say(" · 到此为止", " · ends here") : ""}
                </span>
                <button
                  type="button"
                  className="flowHandle"
                  tabIndex={-1}
                  aria-hidden="true"
                  title={say("拖到另一步，画出箭头", "Drag to another step to draw an arrow")}
                  onPointerDown={(event) => startLink(event, step)}
                  onPointerMove={moveLink}
                  onPointerUp={endLink}
                  onPointerCancel={() => setLinking(null)}
                  onClick={(event) => event.stopPropagation()}
                />
              </div>
            );
          })}
        </div>
      </div>

      {current ? (
        <div className="flowEditor" key={steps.indexOf(current)}>
          <div className="flowEditorHead">
            <h4>{say(`步骤：${nameOf(current.id)}`, `Step: ${nameOf(current.id)}`)}</h4>
            {isStart(current.id) ? null : (
              <button
                type="button"
                className="studioButton quiet"
                disabled={busy}
                onClick={() => {
                  change(removeStep(steps, current.id));
                  setSelected(null);
                }}
              >
                <Trash size={16} aria-hidden="true" /> {say("删除这一步", "Delete this step")}
              </button>
            )}
          </div>
          <div className="flowEditorColumns">
            <div>
              {isStart(current.id) ? null : (
                <>
                  <div className="studioField">
                    <label className="studioLabel" htmlFor="flow-step-id">
                      {say("名称", "Name")}
                    </label>
                    <input
                      id="flow-step-id"
                      className="studioInput mono"
                      value={current.id}
                      maxLength={32}
                      spellCheck={false}
                      onChange={(event) => {
                        const id = event.currentTarget.value.replace(/\s+/g, "_");
                        // Two steps of one name could not be told apart from here on.
                        if (steps.some((step) => step !== current && step.id === id)) return;
                        change(renameStep(steps, current.id, id));
                        setSelected(id);
                      }}
                    />
                    <p className="studioHint">
                      {say(
                        "以字母开头，只用字母、数字、_ 和 -。客户端会在 agent.changed 事件里收到它。",
                        "Starts with a letter; letters, digits, _ and - only. The client receives it in the agent.changed event."
                      )}
                    </p>
                  </div>
                  <div className="studioField">
                    <label className="studioLabel" htmlFor="flow-step-description">
                      {say("什么时候进入这一步", "When to come to this step")}
                    </label>
                    <input
                      id="flow-step-description"
                      className="studioInput"
                      value={current.description ?? ""}
                      maxLength={400}
                      placeholder={say(
                        "例如：发票、退款和付款问题。",
                        "For example: invoices, refunds and payment problems."
                      )}
                      onChange={(event) => patch(current.id, { description: event.currentTarget.value })}
                    />
                    <p className="studioHint">
                      {say(
                        "通向这一步、又没有写条件的箭头，就按这句话判断。",
                        "An arrow that leads here without a condition of its own goes by this sentence."
                      )}
                    </p>
                  </div>
                </>
              )}
              <div className="studioField">
                <label className="studioLabel" htmlFor="flow-step-instructions">
                  {say("这一步的指令", "This step's instructions")}
                </label>
                <textarea
                  id="flow-step-instructions"
                  className="studioTextarea"
                  rows={6}
                  maxLength={8000}
                  value={current.instructions ?? ""}
                  placeholder={
                    isStart(current.id)
                      ? say(
                          "可以留空：这时只用助手自己的指令。",
                          "May stay empty: the assistant's own instructions then apply alone."
                        )
                      : say(
                          "例如：先核对订单号，再谈金额。",
                          "For example: confirm the order number before you discuss money."
                        )
                  }
                  onChange={(event) => patch(current.id, { instructions: event.currentTarget.value })}
                />
                <p className="studioHint">
                  {say(
                    "加在助手自己的指令之后，不会取代它。",
                    "Added to the assistant's own instructions, not put in their place."
                  )}
                </p>
              </div>
            </div>

            <div>
              <fieldset className="flowFieldset">
                <legend className="studioLabel">
                  {say("从这一步可以去哪里", "Where the conversation can go from here")}
                </legend>
                <label className="studioCheck">
                  <input
                    type="checkbox"
                    checked={current.handoffs === undefined}
                    onChange={(event) => patch(current.id, { handoffs: event.currentTarget.checked ? undefined : [] })}
                  />
                  <span>{say("任意一步，由各步的说明决定", "Any step, going by each step's description")}</span>
                </label>
                {current.handoffs !== undefined ? (
                  <>
                    {current.handoffs.length === 0 ? (
                      <p className="studioHint">
                        {say(
                          "没有箭头：对话会留在这一步，直到结束。",
                          "No arrows: the conversation stays in this step until it ends."
                        )}
                      </p>
                    ) : null}
                    <ul className="flowHandoffs">
                      {current.handoffs.map((handoff, index) => (
                        <li key={handoff.to}>
                          <span className="flowHandoffTo">
                            <ArrowRight size={14} aria-hidden="true" /> {nameOf(handoff.to)}
                          </span>
                          <input
                            className="studioInput"
                            value={handoff.when ?? ""}
                            maxLength={300}
                            aria-label={say(
                              `什么时候转到 ${nameOf(handoff.to)}`,
                              `When to go to ${nameOf(handoff.to)}`
                            )}
                            placeholder={say("什么时候走这个箭头（可不填）", "When to take this arrow (optional)")}
                            onChange={(event) => {
                              const when = event.currentTarget.value;
                              patch(current.id, {
                                handoffs: current.handoffs!.map((other, position) =>
                                  position === index ? { to: other.to, ...(when ? { when } : {}) } : other
                                )
                              });
                            }}
                          />
                          <button
                            type="button"
                            className="studioButton quiet"
                            aria-label={say(
                              `删除通向 ${nameOf(handoff.to)} 的箭头`,
                              `Remove the arrow to ${nameOf(handoff.to)}`
                            )}
                            onClick={() =>
                              patch(current.id, {
                                handoffs: current.handoffs!.filter((_, position) => position !== index)
                              })
                            }
                          >
                            <Trash size={16} aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                    {targetsLeft.length > 0 ? (
                      <label className="flowAddArrow">
                        <span>{say("添加箭头，通向", "Add an arrow to")}</span>
                        <select
                          className="studioSelect"
                          value=""
                          onChange={(event) => {
                            if (event.currentTarget.value)
                              change(connect(steps, current.id, event.currentTarget.value));
                          }}
                        >
                          <option value="">{say("选择一步…", "Choose a step…")}</option>
                          {targetsLeft.map((step) => (
                            <option key={step.id} value={step.id}>
                              {nameOf(step.id)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </>
                ) : null}
              </fieldset>

              <fieldset className="flowFieldset">
                <legend className="studioLabel">{say("这一步可以用的工具", "The tools this step may use")}</legend>
                <label className="studioCheck">
                  <input
                    type="checkbox"
                    checked={current.tools === undefined}
                    onChange={(event) => patch(current.id, { tools: event.currentTarget.checked ? undefined : [] })}
                  />
                  <span>{say("全部工具", "Every tool")}</span>
                </label>
                {current.tools === undefined && steps.length > 1 ? (
                  <p className="studioHint">
                    {say(
                      "能用全部工具的一步，可以自己把别的步骤的事办了，而不去转交。只勾选这一步需要的工具，流程才会按箭头走。",
                      "A step with every tool can do the other steps' work itself instead of handing over. Tick only the tools this step needs, and the flow goes the way the arrows say."
                    )}
                  </p>
                ) : null}
                {current.tools !== undefined ? (
                  <>
                    {toolChoices.length === 0 ? (
                      <p className="studioHint">{say("中继上还没有工具。", "The relay has no tools yet.")}</p>
                    ) : null}
                    <div className="flowTools">
                      {toolChoices.map((name) => (
                        <label key={name} className="studioCheck">
                          <input
                            type="checkbox"
                            checked={current.tools!.includes(name)}
                            onChange={(event) =>
                              patch(current.id, {
                                tools: event.currentTarget.checked
                                  ? [...current.tools!, name]
                                  : current.tools!.filter((other) => other !== name)
                              })
                            }
                          />
                          <code>{name}</code>
                        </label>
                      ))}
                    </div>
                    <div className="flowAddTool">
                      <input
                        className="studioInput mono"
                        value={extraTool}
                        maxLength={64}
                        aria-label={say("另一个工具的名称", "Another tool's name")}
                        placeholder={say("客户端自己的工具名称", "The name of a tool of your client")}
                        onChange={(event) => setExtraTool(event.currentTarget.value.trim())}
                      />
                      <button
                        type="button"
                        className="studioButton"
                        disabled={!extraTool || current.tools.includes(extraTool) || current.tools.length >= 64}
                        onClick={() => {
                          patch(current.id, { tools: [...current.tools!, extraTool] });
                          setExtraTool("");
                        }}
                      >
                        {say("添加", "Add")}
                      </button>
                    </div>
                    <p className="studioHint">
                      {say(
                        "结束对话、转交给另一步和电话转接这几个内置工具，每一步都能用。",
                        "Ending the conversation, handing over to another step and transferring a phone call are always available to every step."
                      )}
                    </p>
                  </>
                ) : null}
              </fieldset>
            </div>
          </div>
        </div>
      ) : (
        <p className="flowNote">{say("选中一步来编辑它。", "Select a step to edit it.")}</p>
      )}

      {showProblems && problems.length > 0 ? (
        <ul className="flowProblems" role="alert">
          {problems.map((problem) => (
            <li key={`${problem.step}:${problem.field}:${problem.kind}`}>
              <button type="button" className="linkButton" onClick={() => setSelected(problem.step)}>
                {describe(problem)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
