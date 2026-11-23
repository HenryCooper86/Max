import { MAX_MONTHLY_MINUTES_CAP } from "../../../shared/cloud-studio";
import { useEffect, useState } from "react";
import type { Project } from "../api";
import { useSay } from "../hooks";
import { minutesCapFromDraft, type StudioTabProps } from "./types";

type Confirm = "none" | "rotate" | "delete" | "removeModelKey";

/** Studio → Settings: the project's name, its monthly minutes limit, its API key and deleting it. */
export function SettingsTab({
  session,
  project,
  draft,
  update,
  onProjectChanged,
  release,
  refreshRelease,
  onKeyRotated,
  onDeleted
}: StudioTabProps & {
  onKeyRotated: (project: Project, apiKey: string) => void;
  onDeleted: (project: Project) => void;
}) {
  const say = useSay();
  const [confirm, setConfirm] = useState<Confirm>("none");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const id = `cxs-${project.id}-name`;
  const capId = `cxs-${project.id}-minutes-cap`;
  const liveCap = project.monthlyMinutesCap?.toString() ?? "";
  const [cap, setCap] = useState(liveCap);
  useEffect(() => setCap(liveCap), [liveCap]);
  const minutes = minutesCapFromDraft(cap);
  const capInvalid = minutes === undefined;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (caught) {
      setError(session.fail(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cxsPanel">
      <label className="cxField" htmlFor={id}>
        <span>{say("项目名称", "Project name")}</span>
        <input id={id} maxLength={60} required value={draft.name} onChange={(e) => update({ name: e.target.value })} />
        <small>{say("只有你能看到。", "Only you see this.")}</small>
      </label>

      <label className="cxField" htmlFor={capId}>
        <span>{say("每月分钟上限", "Monthly minutes limit")}</span>
        <input
          id={capId}
          type="text"
          inputMode="numeric"
          placeholder={say("不限", "No limit")}
          aria-invalid={capInvalid ? true : undefined}
          aria-describedby={`${capId}-hint`}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
        />
        <small id={`${capId}-hint`}>
          {say(
            "这个项目每个自然月（UTC）最多通话多少分钟，包括网站嵌入、你的后端和测试。用完后新对话会被拒绝、进行中的对话会结束，直到下个月或你调高上限。留空表示不限，只受余额限制。",
            "How many minutes this project may talk per calendar month (UTC), counting the website embed, your backend and tests. Once they are used, new conversations are refused and open ones end, until the next month or until you raise the limit. Leave it empty for no limit other than your balance."
          )}
        </small>
      </label>
      <button
        type="button"
        className="siteButton secondary small"
        disabled={busy || capInvalid || minutes === (project.monthlyMinutesCap ?? null)}
        onClick={() =>
          void run(async () => {
            if (minutes === undefined) return;
            const answer = await session.api.updateProject(session.token, project.id, { monthlyMinutesCap: minutes });
            onProjectChanged(answer.project);
          })
        }
      >
        {say("立即应用上限", "Apply limit now")}
      </button>
      {capInvalid ? (
        <p className="cxError" role="alert">
          {say(
            `请填写 1 至 ${MAX_MONTHLY_MINUTES_CAP.toLocaleString("zh-CN")} 之间的整数分钟；不限请留空。`,
            `Enter a whole number from 1 to ${MAX_MONTHLY_MINUTES_CAP.toLocaleString("en-US")}, or leave it empty for no limit.`
          )}
        </p>
      ) : null}

      <div className="cxSubsection">
        <h4>{say("项目密钥", "Project key")}</h4>
        <p className="cxMuted">
          {say(
            `以 ${project.keyPrefix}… 开头。你的后端用它换取会话令牌；用“一行代码”嵌入时不需要它。`,
            `Starts with ${project.keyPrefix}…. Your backend uses it to get session tokens; the one-line embed doesn't need it.`
          )}
        </p>
      </div>

      <div className="cxDanger">
        {confirm === "none" ? (
          <div className="cxRow">
            <button type="button" className="siteButton secondary small" onClick={() => setConfirm("rotate")}>
              {say("更换项目密钥", "Rotate key")}
            </button>
            {project.hasModelKey || release?.draft?.project.hasModelKey || release?.previousRevision ? (
              <button type="button" className="siteButton secondary small" onClick={() => setConfirm("removeModelKey")}>
                {say("移除模型密钥", "Remove model key")}
              </button>
            ) : null}
            <button type="button" className="siteButton secondary small" onClick={() => setConfirm("delete")}>
              {say("删除项目", "Delete project")}
            </button>
          </div>
        ) : (
          <div role="group" aria-label={say("确认", "Confirm")}>
            <p>
              {confirm === "removeModelKey"
                ? say(
                    "立即移除已保存的模型密钥？新对话将无法开始，已保存的草稿及回退版本将被清除。",
                    "Remove the stored model key now? New conversations will stop working. The saved draft and rollback revision will be discarded."
                  )
                : confirm === "rotate"
                  ? say("旧密钥会立刻失效。确定要更换吗？", "The old key stops working immediately. Rotate it?")
                  : say(
                      "项目、它的对话记录和密钥都会被删除。确定吗？",
                      "This deletes the project, its conversations and its key. Delete it?"
                    )}
            </p>
            <div className="cxRow">
              <button
                type="button"
                className="siteButton small cxDangerButton"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (confirm === "removeModelKey") {
                      const result = await session.api.updateProject(session.token, project.id, { modelKey: "" });
                      setConfirm("none");
                      onProjectChanged(result.project);
                      await refreshRelease();
                    } else if (confirm === "rotate") {
                      const result = await session.api.rotateKey(session.token, project.id);
                      setConfirm("none");
                      onKeyRotated(result.project, result.apiKey);
                    } else {
                      await session.api.deleteProject(session.token, project.id);
                      onDeleted(project);
                    }
                  })
                }
              >
                {confirm === "removeModelKey"
                  ? say("是，移除密钥", "Yes, remove key")
                  : confirm === "rotate"
                    ? say("是，更换", "Yes, rotate")
                    : say("是，删除", "Yes, delete")}
              </button>
              <button type="button" className="siteButton quiet small" onClick={() => setConfirm("none")}>
                {say("取消", "Cancel")}
              </button>
            </div>
          </div>
        )}
        <p className="cxError" aria-live="polite">
          {error}
        </p>
      </div>
    </div>
  );
}
