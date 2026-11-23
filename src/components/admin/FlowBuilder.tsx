import { ArrowRight, FloppyDisk, Plus, SquaresFour, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  addStep,
  arrowsOf,
  BRANCH_TESTS,
  branchOf,
  connect,
  curve,
  flowProblems,
  flowToSave,
  flowWarnings,
  MAX_STEPS,
  nameProblem,
  NODE,
  placed,
  removeStep,
  renameStep,
  snap,
  START,
  stepAt,
  surfaceSize,
  testOf,
  tidy,
  valueOf,
  type BranchTest,
  type EntryKey,
  type FlowBranch,
  type FlowCollected,
  type FlowEntry,
  type FlowProblem,
  type FlowStep
} from "../../lib/flow";
import { localized } from "../../lib/i18n";
import { SECTION_LEAVE_EVENT } from "../../lib/section-leave";
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
/** How far a pressed step has to be moved before that is a drag and not a click. */
const DRAG_THRESHOLD = 4;

/**
 * The name of a step. It is typed as a draft and taken when the field is left
 * or Enter is pressed: a name is only ever given to a step whole, so typing
 * through another step's name ("refund" on the way to "refund_policy") is not
 * in the way, and the arrows are rewritten once.
 */
type Say = (zh: string, en: string) => string;

/**
 * The arguments of the call a step makes on arriving, as JSON. What is typed
 * is kept as typed, and becomes the step's only once it is an object.
 */
function EntryArguments({
  value,
  say,
  onChange
}: {
  value: Record<string, unknown> | undefined;
  say: Say;
  onChange(value: Record<string, unknown>): void;
}) {
  const [draft, setDraft] = useState(() => (value && Object.keys(value).length > 0 ? JSON.stringify(value) : ""));
  const [refused, setRefused] = useState(false);
  const commit = () => {
    if (!draft.trim()) {
      setRefused(false);
      onChange({});
      return;
    }
    try {
      const parsed: unknown = JSON.parse(draft);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      setRefused(false);
      onChange(parsed as Record<string, unknown>);
    } catch {
      setRefused(true);
    }
  };
  return (
    <div className="studioField">
      <label className="studioLabel" htmlFor="flow-entry-arguments">
        {say("调用时的参数（JSON）", "With these arguments (JSON)")}
      </label>
      <input
        id="flow-entry-arguments"
        className="studioInput mono"
        value={draft}
        maxLength={2000}
        spellCheck={false}
        placeholder='{ "which": "latest" }'
        aria-invalid={refused ? true : undefined}
        aria-describedby={refused ? "flow-entry-arguments-refused" : undefined}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setRefused(false);
        }}
        onBlur={commit}
      />
      {refused ? (
        <p id="flow-entry-arguments-refused" className="studioHint flowNameRefused" role="alert">
          {say(
            '这不是一个 JSON 对象，参数没有改动。例如：{ "which": "latest" }',
            'This is not a JSON object, so the arguments were not changed. For example: { "which": "latest" }'
          )}
        </p>
      ) : null}
    </div>
  );
}

/** One branch a step takes by rule: where to, and what of the tool's answer decides it. */
function BranchRow({
  branch,
  targets,
  say,
  nameOf,
  position,
  onChange,
  onRemove
}: {
  branch: FlowBranch;
  /** Which branch of the step this is, from 1: the rows are told apart by it. */
  position: number;
  targets: string[];
  say: Say;
  nameOf(id: string): string;
  onChange(branch: FlowBranch): void;
  onRemove(): void;
}) {
  const test = testOf(branch);
  // As typed: "1." and "a, " are on the way to a value, and must not be tidied away under the cursor.
  const [value, setValue] = useState(() => valueOf(branch));
  // What the test reads: a part of the tool's answer, or a value of the conversation by its name.
  const ofValue = branch.if?.value !== undefined;
  const path = branch.if?.value ?? branch.if?.path ?? "";
  const label: Record<BranchTest, string> = {
    always: say("其余情况", "otherwise"),
    is: say("等于", "is"),
    in: say("是其中之一", "is one of"),
    above: say("大于", "is above"),
    below: say("小于", "is below"),
    exists: say("存在", "is there"),
    missing: say("不存在", "is not there"),
    failed: say("调用失败", "the call failed")
  };
  const reads = test !== "always" && test !== "failed";
  const compares = reads && test !== "exists" && test !== "missing";
  /** Every row has the same controls: each is named with the row it is in. */
  const named = (zh: string, en: string): string => say(`分支 ${position}：${zh}`, `Branch ${position}: ${en}`);
  return (
    <li>
      <ArrowRight size={14} aria-hidden="true" />
      <select
        className="studioInput"
        aria-label={named("转到哪一步", "go to")}
        value={branch.to}
        onChange={(event) => onChange({ ...branch, to: event.currentTarget.value })}
      >
        {targets.map((id) => (
          <option key={id} value={id}>
            {nameOf(id)}
          </option>
        ))}
      </select>
      {reads ? (
        <>
          <select
            className="studioInput"
            aria-label={named("看什么", "what it reads")}
            value={ofValue ? "value" : "answer"}
            onChange={(event) => onChange(branchOf(branch.to, test, "", value, event.currentTarget.value === "value"))}
          >
            <option value="answer">{say("工具的答复", "the tool's answer")}</option>
            <option value="value">{say("对话里的值", "a value")}</option>
          </select>
          <input
            className="studioInput mono"
            aria-label={
              ofValue
                ? named("值的名字", "the name of the value")
                : named("看答复里的哪一项", "which part of the answer")
            }
            placeholder={ofValue ? "order_number" : "order.status"}
            maxLength={120}
            value={path}
            onChange={(event) => onChange(branchOf(branch.to, test, event.currentTarget.value, value, ofValue))}
          />
        </>
      ) : null}
      <select
        className="studioInput"
        aria-label={named("条件", "condition")}
        value={test}
        onChange={(event) =>
          onChange(branchOf(branch.to, event.currentTarget.value as BranchTest, path, value, ofValue))
        }
      >
        {BRANCH_TESTS.map((one) => (
          <option key={one} value={one}>
            {label[one]}
          </option>
        ))}
      </select>
      {compares ? (
        <input
          className="studioInput"
          aria-label={named("比较的值", "the value to compare with")}
          placeholder={test === "in" ? "shipped, packed" : test === "is" ? "shipped" : "100"}
          maxLength={200}
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            onChange(branchOf(branch.to, test, path, event.currentTarget.value, ofValue));
          }}
        />
      ) : null}
      <button type="button" className="studioButton" aria-label={named("删除", "remove")} onClick={onRemove}>
        <Trash size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

/**
 * What a step keeps from its tool's answer: a name and where the part is. The
 * rows are the component's own while they are edited: a name that is still
 * being typed can pass through the name of another row, and neither is lost.
 */
function SaveRows({
  value,
  say,
  onChange
}: {
  value: Record<string, string> | undefined;
  say: Say;
  onChange(value: Record<string, string>): void;
}) {
  const [rows, setRows] = useState<Array<[string, string]>>(() => Object.entries(value ?? {}));
  const names = rows.map(([name]) => name.trim()).filter(Boolean);
  const twice = new Set(names).size < names.length;
  const change = (next: Array<[string, string]>) => {
    setRows(next);
    // An empty row is kept here and not in the step. One with only a place is in the step, where saving says it
    // needs a name.
    onChange(Object.fromEntries(next.filter(([name, path]) => name.trim() || path.trim())));
  };
  return (
    <div className="studioField">
      <span className="studioLabel" id="flow-entry-save">
        {say("从答复里保存下来的值", "Keep from its answer")}
      </span>
      <ul className="flowBranches flowValues" aria-labelledby="flow-entry-save">
        {rows.map(([name, path], index) => (
          <li key={index}>
            <input
              className="studioInput mono"
              aria-label={say(`保存 ${index + 1}：名字`, `Kept value ${index + 1}: name`)}
              aria-invalid={twice && names.filter((one) => one === name.trim()).length > 1 ? true : undefined}
              placeholder="status"
              maxLength={40}
              spellCheck={false}
              value={name}
              onChange={(event) =>
                change(rows.map((pair, at) => (at === index ? [event.currentTarget.value, pair[1]] : pair)))
              }
            />
            <ArrowRight size={14} aria-hidden="true" style={{ transform: "rotate(180deg)" }} />
            <input
              className="studioInput mono flowValueWide"
              aria-label={say(
                `保存 ${index + 1}：在答复里的位置`,
                `Kept value ${index + 1}: where it is in the answer`
              )}
              placeholder="order.status"
              maxLength={120}
              spellCheck={false}
              value={path}
              onChange={(event) =>
                change(rows.map((pair, at) => (at === index ? [pair[0], event.currentTarget.value] : pair)))
              }
            />
            <button
              type="button"
              className="studioButton"
              aria-label={say(`保存 ${index + 1}：删除`, `Kept value ${index + 1}: remove`)}
              onClick={() => change(rows.filter((_, at) => at !== index))}
            >
              <Trash size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {twice ? (
        <p className="studioHint flowNameRefused" role="alert">
          {say(
            "有两个值用了同一个名字：只会保存后面的那个。",
            "Two kept values have the same name: only the later one is kept."
          )}
        </p>
      ) : null}
      <div>
        <button
          type="button"
          className="studioButton"
          disabled={rows.length >= 8 || rows.some(([name, path]) => !name.trim() && !path.trim())}
          onClick={() => setRows([...rows, ["", ""]])}
        >
          <Plus size={14} aria-hidden="true" /> {say("保存一个值", "Keep a value")}
        </button>
      </div>
    </div>
  );
}

function StepName({
  steps,
  id,
  say,
  onRename
}: {
  steps: FlowStep[];
  id: string;
  say: (zh: string, en: string) => string;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState(id);
  const [refused, setRefused] = useState<ReturnType<typeof nameProblem>>(undefined);
  const commit = () => {
    const name = draft.trim().replace(/\s+/g, "_");
    if (name === id || !name) {
      setDraft(id);
      setRefused(undefined);
      return;
    }
    const problem = nameProblem(steps, id, name);
    setRefused(problem);
    if (problem) setDraft(name);
    else onRename(name);
  };
  return (
    <div className="studioField">
      <label className="studioLabel" htmlFor="flow-step-id">
        {say("名称", "Name")}
      </label>
      <input
        id="flow-step-id"
        className="studioInput mono"
        value={draft}
        maxLength={32}
        spellCheck={false}
        aria-invalid={refused ? true : undefined}
        aria-describedby="flow-step-id-hint"
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setRefused(undefined);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.stopPropagation();
            setDraft(id);
            setRefused(undefined);
          }
        }}
      />
      {refused ? (
        <p className="studioHint flowNameRefused" role="alert">
          {refused === "twice"
            ? say(
                `已经有一步叫 ${draft}，这一步仍然叫 ${id}。`,
                `Another step is called ${draft}. This step is still called ${id}.`
              )
            : refused === "start"
              ? say(
                  `main 是“开始”这一步的名称，这一步仍然叫 ${id}。`,
                  `main is the name of Start. This step is still called ${id}.`
                )
              : say(
                  `这个名称不能用，这一步仍然叫 ${id}。以字母开头，只用字母、数字、_ 和 -，最多 32 个字符。`,
                  `That cannot be a step's name, so this step is still called ${id}. Start with a letter and use letters, digits, _ and -, 32 characters at most.`
                )}
        </p>
      ) : null}
      <p className="studioHint" id="flow-step-id-hint">
        {say(
          "以字母开头，只用字母、数字、_ 和 -。客户端会在 agent.changed 事件里收到它。",
          "Starts with a letter; letters, digits, _ and - only. The client receives it in the agent.changed event."
        )}
      </p>
    </div>
  );
}

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
  /**
   * For the start: which of the two things it does by rule the editor shows, once that was chosen or one was
   * edited. Until then it is what is done when a conversation starts, unless only the other is written.
   */
  const [when, setWhen] = useState<{ step: string; key: EntryKey } | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [showProblems, setShowProblems] = useState(false);
  const [busy, setBusy] = useState(false);
  const [extraTool, setExtraTool] = useState("");
  // An arrow being drawn: from which step, and where the pointer is on the canvas.
  const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: string; pointer: [number, number]; origin: [number, number]; moved: boolean } | null>(null);

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
  const warnings = useMemo(() => (steps ? flowWarnings(steps) : []), [steps]);
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
    if (problem.field === "collect") {
      const texts: Record<string, string> = {
        start: say(
          `${step}：对话从这一步开始，没有转交，所以这里不能先问。`,
          `${step}: a conversation starts here with no handover, so nothing can be asked for first.`
        ),
        many: say(`${step}：最多先问 8 个值。`, `${step}: at most 8 values can be asked for first.`),
        name: say(
          `${step}：值的名字用小写字母、数字和下划线，以字母开头，不能叫 channel、agent 或 values。`,
          `${step}: a value's name is lower-case letters, digits and _, starting with a letter, and not channel, agent or values.`
        ),
        twice: say(`${step}：有两个值用了同一个名字。`, `${step}: two values have the same name.`),
        kept: say(
          `${step}：先问的一个值，名字和某一步从工具答复里保存的值相同。一个值要么问用户，要么从工具保存，不能两样都是。`,
          `${step}: a value asked for first has the name of one a step keeps from a tool's answer. A value is asked of the user or kept from a tool, not both.`
        ),
        types: say(
          `${step}：有一个值在前面的一步里是另一种类型。同一个名字只能是一种类型。`,
          `${step}: a value is of another type in an earlier step. One name is one type.`
        ),
        description: say(
          `${step}：每个值都要写明它是什么（最多 200 个字符），助手按它来问。`,
          `${step}: every value needs a few words on what it is (200 characters at most): the assistant asks by them.`
        )
      };
      return texts[problem.kind] ?? `${step}: collect`;
    }
    if (problem.field === "onEnter" || problem.field === "onStart") {
      // The start does two things by rule, and only one of them is on the screen: say which this is about.
      const step = !isStart(problem.step)
        ? nameOf(problem.step)
        : problem.field === "onStart"
          ? say("开始（对话开始时）", "Start (when a conversation starts)")
          : say("开始（对话被转交回来时）", "Start (when a conversation is handed back)");
      const texts: Record<string, string> = {
        notStart: say(
          `${step}：只有“开始”有对话开始时做的事。`,
          `${step}: only Start has something done when a conversation starts.`
        ),
        placeholder: say(
          `${step}：${problem.detail ?? "{{…}}"} 不是一个值的写法。写成 {{名字}}，名字用小写字母、数字和下划线。`,
          `${step}: ${problem.detail ?? "{{…}}"} is not a value. Write {{name}}, with a name of lower-case letters, digits and _.`
        ),
        valueName: say(
          `${step}：有一个分支要看的值没有写名字，或名字不对。`,
          `${step}: a branch reads a value whose name is missing or is not a name.`
        ),
        saveNoCall: say(
          `${step}：要保存工具答复里的内容，先选一个到达时调用的工具。`,
          `${step}: keeping parts of a tool's answer needs a tool to call on arriving.`
        ),
        saves: say(`${step}：最多保存 8 个值。`, `${step}: at most 8 values can be kept.`),
        save: say(
          `${step}：保存的每个值都要有名字（小写字母、数字、下划线，不能叫 channel、agent 或 values）和它在答复里的位置。`,
          `${step}: every kept value needs a name (lower-case letters, digits, _; not channel, agent or values) and where it is in the answer.`
        ),
        unknownValue: say(
          `${step}：用到了 ${problem.detail ?? "一个值"}，没有哪一步先问或保存它。`,
          `${step}: it uses ${problem.detail ?? "a value"}, which no step asks for or keeps.`
        ),
        say: say(
          `${step}：到达时说的话最多 500 个字符。`,
          `${step}: what is said on arriving can be 500 characters at most.`
        ),
        tool: say(`${step}：选一个到达时调用的工具。`, `${step}: choose the tool to call on arriving.`),
        notOffered: say(
          `${step}：到达时调用的工具不在这一步可以用的工具里。`,
          `${step}: the tool called on arriving is not one of the tools this step may use.`
        ),
        noCall: say(
          `${step}：带条件的分支要看工具的答复，先选一个到达时调用的工具。`,
          `${step}: a branch with a condition reads a tool's answer. Choose a tool to call on arriving first.`
        ),
        alwaysFirst: say(
          `${step}：“其余情况”的分支总会被走到，所以只能放在最后。`,
          `${step}: an "otherwise" branch is always taken, so it has to be the last one.`
        ),
        value: say(`${step}：有一个分支没有写比较的值。`, `${step}: a branch has no value to compare with.`),
        choices: say(`${step}：“是其中之一”最多写 16 个值。`, `${step}: "is one of" takes 16 values at most.`),
        branches: say(`${step}：最多 8 个分支。`, `${step}: a step has 8 branches at most.`),
        number: say(
          `${step}：“大于”和“小于”要和一个数字比较。`,
          `${step}: "is above" and "is below" compare with a number.`
        )
      };
      return texts[problem.kind] ?? `${step}: onEnter`;
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
    drag.current = { id: step.id, pointer: [event.clientX, event.clientY], origin: step.at, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSelected(step.id);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (!held) return;
    // A click with an unsteady hand is not a move.
    if (!held.moved && Math.hypot(event.clientX - held.pointer[0], event.clientY - held.pointer[1]) < DRAG_THRESHOLD) {
      return;
    }
    held.moved = true;
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
  // The start has two things it does by rule: on a conversation starting, and on one being handed back to it.
  const entryKey: EntryKey =
    !current || !isStart(current.id)
      ? "onEnter"
      : when?.step === current.id
        ? when.key
        : current.onStart || !current.onEnter
          ? "onStart"
          : "onEnter";
  const entry: FlowEntry = current?.[entryKey] ?? {};
  const branches = entry.next ?? [];
  // The call is made as this step, with the tools this step may use.
  const entryTools = current
    ? [...new Set([...(current.tools ?? tools), ...(entry.call?.tool ? [entry.call.tool] : [])])]
    : [];
  const others = current ? steps.filter((step) => step.id !== current.id).map((step) => step.id) : [];
  const patchEntry = (values: Partial<FlowEntry>) => {
    if (!current) return;
    // What is being edited stays on the screen, whatever becomes of the other.
    if (isStart(current.id)) setWhen({ step: current.id, key: entryKey });
    patch(current.id, { [entryKey]: { ...entry, ...values } });
  };
  const collect: FlowCollected[] = current?.collect ?? [];
  const patchCollect = (index: number, values: Partial<FlowCollected>) => {
    if (current) patch(current.id, { collect: collect.map((one, at) => (at === index ? { ...one, ...values } : one)) });
  };

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
            {arrows.map((arrow, index) => (
              <path
                key={`${arrow.from}>${arrow.to}${arrow.byRule ? `>rule${index}` : ""}`}
                className={`${arrow.from === selected ? "selected" : ""}${arrow.byRule ? " byRule" : ""}`.trim()}
                d={arrow.path}
                markerEnd="url(#flow-arrowhead)"
              />
            ))}
            {linking && linkFrom ? (
              <path className="drawing" d={curve(linkFrom, [linking.x, linking.y - NODE.height / 2 + 10]).path} />
            ) : null}
          </svg>
          {arrows
            .map((arrow, index) => ({ arrow, index }))
            .filter(({ arrow }) => arrow.when)
            .map(({ arrow, index }) => (
              <span
                key={`${arrow.from}>${arrow.to}${arrow.byRule ? `>rule${index}` : ""}`}
                className={`flowCondition${arrow.from === selected ? " selected" : ""}${arrow.byRule ? " byRule" : ""}`}
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
                  <StepName
                    key={current.id}
                    steps={steps}
                    id={current.id}
                    say={say}
                    onRename={(name) => {
                      change(renameStep(steps, current.id, name));
                      setSelected(name);
                    }}
                  />
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

              {isStart(current.id) ? null : (
                <fieldset className="flowFieldset">
                  <legend className="studioLabel">
                    {say(
                      "转交到这一步之前，助手要先问清楚的",
                      "What the assistant has to find out before it hands over to this step"
                    )}
                  </legend>
                  <p className="studioHint">
                    {say(
                      "缺少必填的值时，转交会被拒绝，助手先向用户问清楚。问到的值可以写成 {{名字}}，用在下面的那句话和工具参数里。",
                      "A handover without a required value is refused, and the assistant asks the user first. What it finds out can be written as {{name}} in the sentence and the tool's arguments below."
                    )}
                  </p>
                  <ul className="flowBranches flowValues" aria-label={say("先问清楚的值", "Values to find out first")}>
                    {collect.map((value, index) => {
                      const named = (zh: string, en: string): string =>
                        say(`值 ${index + 1}：${zh}`, `Value ${index + 1}: ${en}`);
                      return (
                        <li key={index}>
                          <input
                            className="studioInput mono"
                            aria-label={named("名字", "name")}
                            placeholder="order_number"
                            maxLength={40}
                            spellCheck={false}
                            value={value.name}
                            onChange={(event) => patchCollect(index, { name: event.currentTarget.value })}
                          />
                          <input
                            className="studioInput flowValueWide"
                            aria-label={named("它是什么", "what it is")}
                            placeholder={say("订单号，按用户说的", "The number of the order, as the user said it")}
                            maxLength={200}
                            value={value.description}
                            onChange={(event) => patchCollect(index, { description: event.currentTarget.value })}
                          />
                          <select
                            className="studioInput"
                            aria-label={named("类型", "type")}
                            value={value.type ?? "text"}
                            onChange={(event) =>
                              patchCollect(index, { type: event.currentTarget.value as FlowCollected["type"] })
                            }
                          >
                            <option value="text">{say("文字", "text")}</option>
                            <option value="number">{say("数字", "number")}</option>
                            <option value="boolean">{say("是或否", "yes or no")}</option>
                          </select>
                          <label className="studioCheck">
                            <input
                              type="checkbox"
                              aria-label={named("必填", "required")}
                              checked={value.required !== false}
                              onChange={(event) => patchCollect(index, { required: event.currentTarget.checked })}
                            />
                            <span>{say("必填", "required")}</span>
                          </label>
                          <button
                            type="button"
                            className="studioButton"
                            aria-label={named("删除", "remove")}
                            onClick={() => patch(current.id, { collect: collect.filter((_, at) => at !== index) })}
                          >
                            <Trash size={14} aria-hidden="true" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <div>
                    <button
                      type="button"
                      className="studioButton"
                      disabled={collect.length >= 8}
                      onClick={() =>
                        patch(current.id, {
                          collect: [...collect, { name: "", description: "", type: "text", required: true }]
                        })
                      }
                    >
                      <Plus size={14} aria-hidden="true" /> {say("添加一个值", "Add a value")}
                    </button>
                  </div>
                </fieldset>
              )}

              <fieldset className="flowFieldset">
                <legend className="studioLabel">
                  {entryKey === "onStart"
                    ? say("对话开始时，中继自己做的事", "What the relay does itself when a conversation starts")
                    : say(
                        "对话到这一步时，中继自己做的事",
                        "What the relay does itself when a conversation comes here"
                      )}
                </legend>
                {isStart(current.id) ? (
                  <div className="studioField">
                    <label className="studioLabel" htmlFor="flow-entry-when">
                      {say("什么时候", "When")}
                    </label>
                    <select
                      id="flow-entry-when"
                      className="studioInput"
                      value={entryKey}
                      onChange={(event) =>
                        setWhen({
                          step: current.id,
                          key: event.currentTarget.value === "onStart" ? "onStart" : "onEnter"
                        })
                      }
                    >
                      <option value="onStart">{say("对话开始时", "A conversation starts")}</option>
                      <option value="onEnter">
                        {say("对话被转交回这一步时", "A conversation is handed back here")}
                      </option>
                    </select>
                  </div>
                ) : null}
                <p className="studioHint">
                  {entryKey === "onStart"
                    ? say(
                        "这些都不由模型决定，在模型接入之前完成：调用一个工具，按它的答复转到某一步，那句固定的话接在问候语后面说。工具慢，第一句话就来得晚。",
                        "No model decides any of this, and it is done before the model is connected: a tool call, on to a step by what it answered, and the fixed sentence said after the greeting. A slow tool makes the first word late."
                      )
                    : say(
                        "这些都不由模型决定：先说一句固定的话，再调用一个工具，然后按工具的答复转到下一步。它在对话被转交到这一步时发生。",
                        "No model decides any of this: a fixed sentence, then a tool call, then on to another step by what the tool answered. It happens when a conversation is handed to this step."
                      )}
                </p>
                <div className="studioField">
                  <label className="studioLabel" htmlFor="flow-entry-say">
                    {say("原样说这句话", "Say, in these words")}
                  </label>
                  <input
                    id="flow-entry-say"
                    className="studioInput"
                    value={entry.say ?? ""}
                    maxLength={500}
                    placeholder={say("请稍等，我查一下您的订单。", "One moment, I am looking up your order.")}
                    onChange={(event) => patchEntry({ say: event.currentTarget.value })}
                  />
                </div>
                <div className="studioField">
                  <label className="studioLabel" htmlFor="flow-entry-tool">
                    {say("然后调用这个工具", "Then call this tool")}
                  </label>
                  <select
                    id="flow-entry-tool"
                    className="studioInput"
                    value={entry.call?.tool ?? ""}
                    onChange={(event) =>
                      patchEntry({
                        call: event.currentTarget.value
                          ? { tool: event.currentTarget.value, arguments: {} }
                          : undefined,
                        // What was kept from the answer of a tool goes with the tool.
                        ...(event.currentTarget.value ? {} : { save: undefined })
                      })
                    }
                  >
                    <option value="">{say("不调用", "None")}</option>
                    {entryTools.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
                {entry.call ? (
                  <EntryArguments
                    key={`${current.id}:${entryKey}:${entry.call.tool}`}
                    value={entry.call.arguments}
                    say={say}
                    onChange={(value) => patchEntry({ call: { tool: entry.call!.tool, arguments: value } })}
                  />
                ) : null}
                {entry.call ? (
                  <SaveRows
                    key={`${current.id}:${entryKey}:${entry.call.tool}`}
                    value={entry.save}
                    say={say}
                    onChange={(save) => patchEntry({ save })}
                  />
                ) : null}
                <ul className="flowBranches" aria-label={say("到达后按规则转到哪一步", "Where it goes next by rule")}>
                  {branches.map((branch, index) => (
                    <BranchRow
                      key={`${current.id}:${entryKey}:${index}:${branches.length}`}
                      branch={branch}
                      position={index + 1}
                      targets={others}
                      say={say}
                      nameOf={nameOf}
                      onChange={(changed) =>
                        patchEntry({ next: branches.map((one, at) => (at === index ? changed : one)) })
                      }
                      onRemove={() => patchEntry({ next: branches.filter((_, at) => at !== index) })}
                    />
                  ))}
                </ul>
                <div>
                  <button
                    type="button"
                    className="studioButton"
                    disabled={others.length === 0 || branches.length >= 8}
                    onClick={() =>
                      patchEntry({
                        next: [
                          ...branches,
                          entry.call ? { to: others[0]!, if: { path: "", is: "" } } : { to: others[0]! }
                        ]
                      })
                    }
                  >
                    <Plus size={14} aria-hidden="true" /> {say("添加一个分支", "Add a branch")}
                  </button>
                </div>
              </fieldset>
            </div>
          </div>
        </div>
      ) : (
        <p className="flowNote">{say("选中一步来编辑它。", "Select a step to edit it.")}</p>
      )}

      {warnings.length > 0 ? (
        <ul className="flowWarnings">
          {warnings.map((warning) => (
            <li key={`${warning.step}:${warning.kind}`}>
              <button type="button" className="linkButton" onClick={() => setSelected(warning.step)}>
                {warning.kind === "ends"
                  ? say(
                      "“开始”没有通往任何一步的箭头，对话到不了其他步骤。",
                      "Start has no arrow to any step, so a conversation never reaches the other steps."
                    )
                  : say(
                      `从“开始”出发，没有箭头能走到 ${nameOf(warning.step)}。`,
                      `No arrows lead from Start to ${nameOf(warning.step)}, so a conversation never reaches it.`
                    )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

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
