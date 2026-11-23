import type { ReactNode } from "react";
import type { Project, StudioRelease } from "../api";
import type { FlowEntry, FlowStep } from "../../lib/flow";
import { useSay } from "../hooks";

type Say = ReturnType<typeof useSay>;
type HiddenChange = (before: Project, after: Project, say: Say) => string[];
type Field = [labelZh: string, labelEn: string, value?: (project: Project) => unknown, hiddenChanges?: HiddenChange];

function endpointHost(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return "";
  }
}

function endpointChanged(before: string, after: string, say: Say): string[] {
  return before && after && before !== after && endpointHost(before) === endpointHost(after)
    ? [say("端点地址已更改，主机相同。", "The endpoint address changed on the same host.")]
    : [];
}

function toolEndpointChanges(before: Project, after: Project, say: Say): string[] {
  const previousByName = new Map(before.studio.tools.map(({ name, url }) => [name, url]));
  return after.studio.tools.flatMap(({ name, url }) =>
    endpointChanged(previousByName.get(name) ?? "", url, say).map((change) => `${name}: ${change}`)
  );
}

function visibleFlowEntry(entry?: FlowEntry) {
  if (!entry) return undefined;
  const { say, call, save, next } = entry;
  return { say, call: call && { tool: call.tool }, save, next };
}

function visibleFlow(steps: Project["studio"]["flow"]) {
  return (steps as FlowStep[]).map(
    ({ id, description, instructions, tools, handoffs, collect, onEnter, onStart, at }) => ({
      id,
      description,
      instructions,
      tools,
      handoffs,
      collect,
      onEnter: visibleFlowEntry(onEnter),
      onStart: visibleFlowEntry(onStart),
      at
    })
  );
}

function flowArgumentChanges(before: Project, after: Project, say: Say): string[] {
  const previousById = new Map((before.studio.flow as FlowStep[]).map((step) => [step.id, step]));
  return (after.studio.flow as FlowStep[]).flatMap((step) => {
    const previous = previousById.get(step.id);
    return (["onStart", "onEnter"] as const).flatMap((event) => {
      const previousArgs = previous?.[event]?.call?.arguments;
      const currentArgs = step[event]?.call?.arguments;
      if (JSON.stringify(previousArgs) === JSON.stringify(currentArgs)) return [];
      return [
        event === "onStart"
          ? say(`${step.id} 启动时的工具参数已更改。`, `Startup tool arguments changed for ${step.id}.`)
          : say(`${step.id} 进入时的工具参数已更改。`, `Entry tool arguments changed for ${step.id}.`)
      ];
    });
  });
}

const fields: Record<string, Field> = {
  name: ["项目名称", "Project name", (p) => p.name],
  backend: ["模型提供商", "Model provider", (p) => p.backend],
  assistantName: ["助手名称", "Agent name", (p) => p.assistantName],
  instructions: ["指令", "Instructions", (p) => p.instructions],
  greeting: ["问候语", "Greeting", (p) => p.greeting],
  modelKey: ["模型密钥", "Model key"],
  tracesHeaders: ["追踪请求头", "Trace request headers"],
  "studio.template": ["模板", "Template", (p) => p.studio.template],
  "studio.voice": ["声音", "Voice", (p) => p.studio.voice],
  "studio.language": ["语言", "Language", (p) => p.studio.language],
  "studio.knowledge": ["知识", "Knowledge", (p) => p.studio.knowledge],
  "studio.tools": [
    "工具",
    "Tools",
    (p) => p.studio.tools.map(({ url, ...tool }) => ({ ...tool, host: endpointHost(url) })),
    toolEndpointChanges
  ],
  "studio.publicEmbed": ["网站嵌入", "Website embed", (p) => p.studio.publicEmbed],
  "studio.widget": ["组件外观", "Widget appearance", (p) => p.studio.widget],
  "studio.keepConversations": ["保留对话", "Conversation retention", (p) => p.studio.keepConversations],
  "studio.conversationWebhook": [
    "对话回调",
    "Conversation webhook",
    (p) => endpointHost(p.studio.conversationWebhook),
    (before, after, say) => endpointChanged(before.studio.conversationWebhook, after.studio.conversationWebhook, say)
  ],
  "studio.flow": ["流程", "Flow", (p) => visibleFlow(p.studio.flow), flowArgumentChanges],
  "studio.analysis": ["对话分析", "Conversation analysis", (p) => p.studio.analysis],
  "studio.traces": [
    "追踪设置",
    "Tracing",
    (p) => ({ host: endpointHost(p.studio.traces.endpoint), content: p.studio.traces.content }),
    (before, after, say) => endpointChanged(before.studio.traces.endpoint, after.studio.traces.endpoint, say)
  ]
};

function display(value: unknown, say: Say): string {
  if (value === "" || value == null) return say("未设置", "Unset");
  if (typeof value === "boolean") return value ? say("开启", "On") : say("关闭", "Off");
  if (typeof value === "object") return JSON.stringify(value, undefined, 2);
  return String(value);
}

export function ReleasePanel({
  release,
  dirty,
  busy,
  conflict,
  refresh,
  publish,
  restore,
  goToTest,
  children
}: {
  children?: ReactNode;
  release: StudioRelease | null;
  dirty: boolean;
  busy: boolean;
  conflict: boolean;
  refresh: () => Promise<void>;
  publish: () => void;
  restore: () => void;
  goToTest: () => void;
}) {
  const say = useSay();
  const draft = release?.draft;
  return (
    <section className="cxsRelease" aria-label={say("版本管理", "Release management")} aria-busy={busy}>
      <div className="cxsReleaseBar">
        <div className="cxsReleaseStatus" role="status">
          {release ? (
            <>
              <span>
                <strong>{say("线上版本", "Live version")}</strong> <code>{release.liveRevision}</code>
              </span>
              <span>
                <strong>{say("草稿", "Draft")}</strong>{" "}
                {draft ? (
                  <>
                    <code>{draft.id}</code> · {draft.tested ? say("已测试", "Tested") : say("待测试", "Test required")}
                  </>
                ) : (
                  say("暂无已保存草稿", "No saved draft")
                )}
              </span>
            </>
          ) : (
            <span>
              {busy ? say("正在加载版本…", "Loading versions…") : say("版本状态不可用", "Versions unavailable")}
            </span>
          )}
        </div>
        <div className="cxRow">
          <button type="button" className="siteButton quiet small" disabled={busy} onClick={() => void refresh()}>
            {say("刷新版本", "Refresh versions")}
          </button>
          {draft && !draft.tested ? (
            <button type="button" className="siteButton secondary small" disabled={busy || conflict} onClick={goToTest}>
              {say("测试草稿", "Test draft")}
            </button>
          ) : null}
          {draft ? (
            <button
              type="button"
              className="siteButton small"
              disabled={busy || conflict || dirty || !draft.tested}
              onClick={publish}
            >
              {say("发布已测试草稿", "Publish tested draft")}
            </button>
          ) : null}
          {release?.previousRevision ? (
            <button type="button" className="siteButton secondary small" disabled={busy || conflict} onClick={restore}>
              {say("恢复上一版本", "Restore previous release")}
            </button>
          ) : null}
        </div>
      </div>
      {children}
      {draft && release ? (
        <details>
          <summary>{say("查看草稿更改", "Review draft changes")}</summary>
          <dl className="cxsReleaseChanges">
            {draft.changedFields.map((key) => {
              const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
              if (!field) return null;
              const [zh, en, value, hiddenChanges] = field;
              const before = value && display(value(release.project), say);
              const after = value && display(value(draft.project), say);
              const privateChanges = hiddenChanges?.(release.project, draft.project, say) ?? [];
              return (
                <div key={key}>
                  <dt>{say(zh, en)}</dt>
                  <dd>
                    {value && (before !== after || privateChanges.length > 0) ? (
                      <div className="cxsReleaseCompare">
                        <div>
                          <strong>{say("线上", "Live")}</strong>
                          <pre>{before}</pre>
                        </div>
                        <div>
                          <strong>{say("草稿", "Draft")}</strong>
                          <pre>{after}</pre>
                        </div>
                      </div>
                    ) : (
                      <span>
                        {value
                          ? say("配置已更改", "Configuration changed")
                          : say("密钥配置已更改", "Secret configuration changed")}
                      </span>
                    )}
                    {privateChanges.length ? (
                      <ul className="cxsReleasePrivateChanges">
                        {privateChanges.map((change) => (
                          <li key={change}>{change}</li>
                        ))}
                      </ul>
                    ) : null}
                  </dd>
                </div>
              );
            })}
          </dl>
        </details>
      ) : null}
    </section>
  );
}
