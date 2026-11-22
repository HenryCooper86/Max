import { lazy, Suspense, useMemo, useRef } from "react";
import type { ApiResult } from "../../lib/api-client";
import type { FlowStep } from "../../lib/flow";
import type { ProjectFlow } from "../api";
import { useSay } from "../hooks";
import type { StudioTabProps } from "./types";

// The canvas is the relay's own flow builder. It is a chunk of its own: most projects are one agent.
const FlowBuilder = lazy(() =>
  import("../../components/admin/FlowBuilder").then((module) => ({ default: module.FlowBuilder }))
);

type Host = Pick<StudioTabProps, "session" | "updateStudio" | "onProjectChanged">;

/**
 * What the canvas loads from and saves to: the project's flow, in place of
 * the relay's own. `host` is read at each call, so a new login is used.
 */
export function projectFlowApi(projectId: string, host: () => Host) {
  const failed = (error: unknown): ApiResult<ProjectFlow> => ({
    ok: false,
    error: { kind: "invalid", message: host().session.fail(error) }
  });
  return {
    fetchStudioFlow: async (): Promise<ApiResult<ProjectFlow>> => {
      try {
        const { api, token } = host().session;
        return { ok: true, data: await api.projectFlow(token, projectId) };
      } catch (error) {
        return failed(error);
      }
    },
    saveStudioFlow: async (steps: FlowStep[]): Promise<ApiResult<ProjectFlow>> => {
      try {
        const { api, token } = host().session;
        const { project, ...flow } = await api.saveProjectFlow(token, projectId, steps);
        // The Studio's own draft must not put the old flow back at its next Save.
        host().onProjectChanged(project);
        host().updateStudio({ flow: project.studio.flow });
        return { ok: true, data: flow };
      } catch (error) {
        return failed(error);
      }
    }
  };
}

/**
 * The project's flow: several agents, each with its own instructions and
 * tools, and the handovers between them. Saved on its own, apart from the
 * Studio's Save: the canvas has its own unsaved state and its own button.
 */
export function FlowTab({ session, project, draft, updateStudio, onProjectChanged, goTo }: StudioTabProps) {
  const say = useSay();
  // The canvas loads once. What it calls reads the session and the callbacks as they are then.
  const latest = useRef<Host>({ session, updateStudio, onProjectChanged });
  latest.current = { session, updateStudio, onProjectChanged };
  const projectId = project.id;
  const api = useMemo(() => projectFlowApi(projectId, () => latest.current), [projectId]);
  const toolsUnsaved = JSON.stringify(draft.studio.tools) !== JSON.stringify(project.studio.tools);

  return (
    <div className="cxsPanel cxsFlow">
      <p className="cxMuted">
        {say(
          "大多数助手不需要流程，这里可以保持原样。流程把一次对话分给几个各有分工的智能体（比如订单、退款、人工），可用的工具就是“工具”里已保存的那些。流程用自己的“保存流程”按钮保存，和工作室的保存分开。",
          "Most agents need no flow, and this can stay as it is. A flow splits a conversation between several agents with a job each (orders, refunds, a person), and the tools a step can use are the ones saved under Tools. A flow is saved with its own Save the flow button, apart from the Studio's Save."
        )}
      </p>
      {toolsUnsaved ? (
        <p className="cxWarn" role="status">
          {say(
            "工具有未保存的更改：流程里只能选用已保存的工具。",
            "Your tools have unsaved changes: a step can only use tools that are saved."
          )}{" "}
          <button type="button" className="linkButton" onClick={() => goTo("tools")}>
            {say("去工具", "Go to Tools")}
          </button>
        </p>
      ) : null}
      <Suspense fallback={<p className="cxMuted">{say("加载中…", "Loading…")}</p>}>
        {/* A lost login is dealt with by the console itself, in session.fail. */}
        <FlowBuilder key={projectId} api={api} onAuthenticationExpired={() => undefined} />
      </Suspense>
    </div>
  );
}
