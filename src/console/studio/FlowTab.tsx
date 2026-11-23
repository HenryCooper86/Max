import { lazy, Suspense, useMemo, useRef } from "react";
import type { ApiResult } from "../../lib/api-client";
import type { FlowStep } from "../../lib/flow";
import type { StudioFlow } from "../../lib/studio-api";
import { useSay } from "../hooks";
import type { StudioTabProps } from "./types";

// The canvas is the relay's own flow builder. It is a chunk of its own: most projects are one agent.
const FlowBuilder = lazy(() =>
  import("../../components/admin/FlowBuilder").then((module) => ({ default: module.FlowBuilder }))
);

type Host = Pick<StudioTabProps, "draft" | "updateStudio">;

export function projectFlowApi(host: () => Host) {
  const result = (steps: FlowStep[]): ApiResult<StudioFlow> => ({
    ok: true,
    data: {
      ok: true,
      steps,
      tools: host()
        .draft.studio.tools.map((tool) => tool.name)
        .sort(),
      problems: []
    }
  });
  return {
    fetchStudioFlow: async () => {
      const steps = host().draft.studio.flow as FlowStep[];
      return result(steps.some((step) => step.id === "main") ? steps : [{ id: "main" }, ...steps]);
    },
    saveStudioFlow: async (steps: FlowStep[]) => {
      host().updateStudio({ flow: steps });
      return result(steps);
    }
  };
}

export function FlowTab({ project, release, draft, updateStudio }: StudioTabProps) {
  const say = useSay();
  const latest = useRef<Host>({ draft, updateStudio });
  latest.current = { draft, updateStudio };
  const api = useMemo(() => projectFlowApi(() => latest.current), []);
  return (
    <div className="cxsPanel cxsFlow">
      <p className="cxMuted">
        {say(
          "流程让多个智能体分工处理同一次对话。编辑后点击“应用到草稿”，再测试并发布。步骤可使用草稿中的工具。",
          "A flow lets several agents handle different parts of a conversation. Apply your flow to the draft, then test and publish it. Steps can use tools from the draft."
        )}
      </p>
      <Suspense fallback={<p className="cxMuted">{say("加载中…", "Loading…")}</p>}>
        <FlowBuilder
          key={JSON.stringify([project.id, release?.liveRevision, draft.studio.flow])}
          draftMode
          api={api}
          onAuthenticationExpired={() => undefined}
        />
      </Suspense>
    </div>
  );
}
