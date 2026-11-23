// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { ReplayCase, ReplayCaseInput } from "../shared/studio-replay";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { ApiError } from "../src/console/api";
import type { Session } from "../src/console/hooks";
import { mayLeaveSection } from "../src/lib/section-leave";
import { ReplayChecks } from "../src/console/studio/ReplayChecks";
import type { ReplayCheck } from "../shared/studio-replay";
import { ReplayCases } from "../src/console/studio/ReplayCases";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

const saved: ReplayCase = { id: "case-1", version: 1, prompt: "Private prompt", expected: "yes", fixtures: {} };

async function setup(seed: ReplayCase | null = null) {
  const api = {
    replayCases: vi.fn(async () => ({ cases: seed ? [] : [saved] })),
    createReplayCase: vi.fn(async (_token: string, _projectId: string, input: ReplayCaseInput) => ({
      testCase: { ...saved, ...input }
    })),
    updateReplayCase: vi.fn(
      async (_token: string, _projectId: string, id: string, input: ReplayCaseInput & { version: number }) => ({
        testCase: { ...input, id, version: input.version + 1 }
      })
    ),
    deleteReplayCase: vi.fn(async () => ({ ok: true })),
    runReplayCase: vi.fn<Session["api"]["runReplayCase"]>(async () => ({
      run: {
        revision: "draft-1",
        caseId: saved.id,
        caseVersion: saved.version,
        answer: "Yes",
        passed: false,
        tools: [{ name: "lookup", mocked: false }]
      }
    }))
  };
  const session = { api, token: "token", fail: String } as unknown as Session;
  const consumed = vi.fn();
  const refreshDraft = vi.fn();
  const focus = vi.fn();
  const draw = (revision: string) => (
    <LanguageProvider>
      <ReplayCases
        session={session}
        projectId="p1"
        revision={revision}
        canReplay
        seed={seed}
        onSeedConsumed={consumed}
        onDraftMayBeStale={refreshDraft}
      />
    </LanguageProvider>
  );
  await act(async () => {
    renderer = create(draw("draft-1"), { createNodeMock: ({ type }) => (type === "textarea" ? { focus } : null) });
  });
  const root = renderer!.root;
  return {
    api,
    consumed,
    refreshDraft,
    focus,
    text: () => JSON.stringify(renderer!.toJSON()),
    click: (label: string) =>
      act(async () =>
        root
          .findAllByType("button")
          .find((node) => node.props.children === label)!
          .props.onClick()
      ),
    changePrompt: (value: string) =>
      act(async () => root.findAllByType("textarea")[0]!.props.onChange({ target: { value } })),
    submit: () => act(async () => root.findByType("form").props.onSubmit({ preventDefault() {} })),
    replaceDraft: () => act(async () => renderer!.update(draw("draft-2")))
  };
}

it("keeps a seeded prompt local until its redacted version is saved", async () => {
  const page = await setup(saved);
  expect(page.consumed).toHaveBeenCalledTimes(1);
  expect(page.focus).toHaveBeenCalledTimes(1);
  expect(page.api.createReplayCase).not.toHaveBeenCalled();
  await page.changePrompt("Redacted");
  await page.submit();
  expect(page.api.createReplayCase).toHaveBeenCalledWith("token", "p1", {
    prompt: "Redacted",
    expected: "yes",
    fixtures: {}
  });
});

it("shows missing fixture failures and removes an old result when the saved draft changes", async () => {
  const page = await setup();
  await page.click("运行");
  expect(page.api.runReplayCase).toHaveBeenCalledWith(
    "token",
    "p1",
    saved.id,
    {
      version: 1,
      revision: "draft-1"
    },
    expect.any(AbortSignal)
  );
  expect(page.text()).toContain("缺少模拟响应");
  expect(page.text()).toContain("Yes");
  await page.replaceDraft();
  expect(page.text()).not.toContain("Yes");
});

it("discards a cancelled history seed without sending its contents", async () => {
  const page = await setup(saved);
  await page.click("取消");
  expect(page.text()).not.toContain(saved.prompt);
  expect(page.api.createReplayCase).not.toHaveBeenCalled();
});

it("refreshes the library and draft after a stale replay request", async () => {
  const page = await setup();
  page.api.runReplayCase.mockRejectedValueOnce(new ApiError("request", "Draft changed", 409));
  await page.click("运行");
  expect(page.api.replayCases).toHaveBeenCalledTimes(2);
  expect(page.refreshDraft).toHaveBeenCalledOnce();
  expect(page.text()).toContain("用例或草稿版本已更改");
});

it("requires a saved edit and confirmed, versioned deletion", async () => {
  const page = await setup();
  await page.click("编辑");
  await page.changePrompt("Changed");
  await page.click("运行");
  expect(page.api.runReplayCase).not.toHaveBeenCalled();
  await page.submit();
  expect(page.api.updateReplayCase).toHaveBeenCalledWith("token", "p1", saved.id, {
    prompt: "Changed",
    expected: "yes",
    fixtures: {},
    version: 1
  });
  await page.click("删除");
  expect(page.api.deleteReplayCase).not.toHaveBeenCalled();
  await page.click("确认删除");
  expect(page.api.deleteReplayCase).toHaveBeenCalledWith("token", "p1", saved.id, 2);
  expect(page.text()).not.toContain("Changed");
});

it("aborts replay on unmount and ignores a late stale failure", async () => {
  const page = await setup();
  let rejectRun: (failure: Error) => void = () => {};
  page.api.runReplayCase.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectRun = reject;
    })
  );
  await page.click("运行");
  const signal = page.api.runReplayCase.mock.calls[0]![4];
  expect(signal?.aborted).toBe(false);
  await act(async () => renderer?.unmount());
  renderer = undefined;
  expect(signal?.aborted).toBe(true);
  await act(async () => rejectRun(new ApiError("request", "Draft changed", 409)));
  expect(page.refreshDraft).not.toHaveBeenCalled();
});

it("cancels the obsolete request when the draft is replaced and allows another replay", async () => {
  const page = await setup();
  let rejectRun: (failure: Error) => void = () => {};
  page.api.runReplayCase.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectRun = reject;
    })
  );
  await page.click("运行");
  const signal = page.api.runReplayCase.mock.calls[0]![4];
  await page.replaceDraft();
  expect(signal?.aborted).toBe(true);
  await act(async () => rejectRun(new ApiError("request", "Draft changed", 409)));
  expect(page.refreshDraft).not.toHaveBeenCalled();
  page.api.runReplayCase.mockResolvedValueOnce({
    run: { revision: "draft-2", caseId: saved.id, caseVersion: 1, answer: "New answer", passed: true, tools: [] }
  });
  await page.click("运行");
  expect(page.text()).toContain("New answer");
});

it("keeps unsaved redactions when the owner declines to leave or replace the editor", async () => {
  const page = await setup(saved);
  vi.stubGlobal("confirm", () => false);
  try {
    await page.changePrompt("Anonymized prompt");
    expect(mayLeaveSection()).toBe(false);
    await page.click("新建用例");
    expect(page.text()).toContain("Anonymized prompt");
    expect(page.api.createReplayCase).not.toHaveBeenCalled();
    await page.submit();
    expect(mayLeaveSection()).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("runs the saved suite serially on one revision, keeps going after a timeout, and refreshes the publish summary", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<Session["api"]["runReplayCase"]>>>();
  const play = vi
    .fn<Session["api"]["runReplayCase"]>()
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new ApiError("request", "Model timed out", 504))
    .mockResolvedValueOnce({
      run: { caseId: "c", caseVersion: 3, revision: "draft-a", passed: false, answer: "Other answer", tools: [] }
    });
  const session = { api: { runReplayCase: play }, token: "token", fail: vi.fn() } as unknown as Session;
  const checks: ReplayCheck[] = ["a", "b", "c"].map((id, i) => ({
    id,
    version: i + 1,
    prompt: id,
    expected: "yes",
    outcome: null,
    stale: false
  }));
  const refresh = vi.fn(async () => {
    renderer!.update(
      draw(
        checks.map((c, i) => ({
          ...c,
          outcome:
            i === 1
              ? { status: "error", message: "Model timed out" }
              : { status: i === 0 ? "passed" : "failed", answer: i === 0 ? "yes" : "Other answer", missingTools: [] }
        }))
      )
    );
  });
  function draw(rows: ReplayCheck[]) {
    return (
      <ReplayChecks
        session={session}
        checks={rows}
        projectId="p"
        revision="draft-a"
        disabled={false}
        refresh={refresh}
      />
    );
  }
  await act(async () => {
    renderer = create(draw(checks));
  });
  const root = renderer!.root;
  expect(JSON.stringify(renderer!.toJSON())).toContain("账户分钟数");
  await act(async () => {
    root.findByType("button").props.onClick();
  });
  expect(play).toHaveBeenCalledTimes(1);
  await act(async () =>
    pending.resolve({
      run: { caseId: "a", caseVersion: 1, revision: "draft-a", passed: true, answer: "yes", tools: [] }
    })
  );
  expect(play.mock.calls.map(([, project, id, target]) => [project, id, target])).toEqual(
    checks.map((c) => ["p", c.id, { version: c.version, revision: "draft-a" }])
  );
  expect(refresh).toHaveBeenCalledOnce();
  const page = JSON.stringify(renderer!.toJSON());
  for (const value of ["1/3", "Model timed out", "Other answer", "实际回答"]) expect(page).toContain(value);
});

it("stops a paid suite when its release panel unmounts", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<Session["api"]["runReplayCase"]>>>();
  const play = vi.fn<Session["api"]["runReplayCase"]>().mockReturnValue(pending.promise);
  const session = { api: { runReplayCase: play }, token: "token", fail: vi.fn() } as unknown as Session;
  const first = { ...saved, outcome: null, stale: false };
  const refresh = vi.fn();
  await act(async () => {
    renderer = create(
      <ReplayChecks
        checks={[first, { ...first, id: "next" }]}
        session={session}
        projectId="p"
        revision="current"
        disabled={false}
        refresh={refresh}
      />
    );
  });
  await act(async () => {
    renderer!.root.findByType("button").props.onClick();
  });
  const signal = play.mock.calls[0]![4]!;
  await act(async () => {
    renderer!.unmount();
    renderer = undefined;
  });
  expect(signal.aborted).toBe(true);
  await act(async () => pending.reject(new ApiError("network", "Cancelled")));
  expect(play).toHaveBeenCalledTimes(1);
  expect(refresh).not.toHaveBeenCalled();
});
