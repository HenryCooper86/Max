import type { InstallSignalKind } from "../../../shared/studio-install";
import { useSay } from "../hooks";
import type { StudioTabProps } from "./types";

const guidance: Record<InstallSignalKind, [string, string]> = {
  disabled: [
    "组件请求已到达，但线上版本未启用网站嵌入。启用后测试并发布草稿。",
    "The widget reached Max, but embedding is off in the live version. Enable it, test the draft and publish."
  ],
  origin: [
    "组件请求已到达，但来源不在允许列表中。核对网站的协议、主机和端口，然后发布修改。",
    "Max received a widget request from a missing or unlisted origin. Check the site's scheme, hostname and port in the allowed origins, then publish any changes."
  ],
  modelKey: [
    "线上模型密钥不可用。请在助手设置中检查密钥、测试并发布。",
    "The live model key is unavailable. Check the key in Agent, test the draft and publish."
  ],
  busy: [
    "请求已到达，但已达到会话或请求上限。关闭闲置会话，稍后重试。",
    "The request reached Max and hit a session or request limit. Close idle sessions and try again shortly."
  ],
  balance: [
    "账户可用分钟数不足。请检查控制台余额。",
    "There are too few account minutes available. Check the console balance."
  ],
  monthlyLimit: [
    "已达项目的每月分钟上限，或该用户的每月分钟上限。请在设置中检查上限。",
    "The project, or the user this session is for, has reached a monthly minutes limit. Review the limits in Settings."
  ],
  unavailable: [
    "Max 未能启动网站会话。请重新连接并重新检查。",
    "Max could not start the website session. Reconnect and check again."
  ],
  tokenIssued: [
    "Max 已向组件发放令牌。若会话未连接，请检查浏览器的网络或内容安全策略是否允许连接中继。",
    "Max issued a widget token. If the session does not connect, check whether the browser's network or content security policy allows connections to the relay."
  ],
  connected: [
    "网站会话已连接。请等待模型就绪并提问。",
    "A website session connected. Wait for the agent to be ready, then ask a question."
  ],
  ready: [
    "助手已就绪。请在网站上提问并等待回复。",
    "The agent is ready. Ask a question on the website and wait for the reply."
  ],
  waitingForAnswer: [
    "已收到访客的问题，正在等待助手回答。",
    "Max received the visitor's question and is waiting for an answer."
  ],
  providerError: [
    "模型连接报告了错误。请检查线上配置的模型密钥和提供商的服务状态。",
    "The model connection reported an error. Check the live model credentials and provider availability."
  ],
  closed: [
    "网站会话在确认回答前结束。请重新连接，提问并等待助手回答。",
    "The website session ended before Max confirmed an answer. Reconnect, ask a question and let the agent reply."
  ],
  answered: ["Max 已确认一次成功的网站对话。", "Max confirmed a successful website conversation."]
};

export function InstallDiagnostics({
  release,
  project,
  releaseBusy,
  refreshRelease
}: Pick<StudioTabProps, "release" | "project" | "releaseBusy" | "refreshRelease">) {
  const say = useSay();
  const signal = release?.installSignal;
  const first = project.firstWebsiteConversationAt ?? release?.project.firstWebsiteConversationAt;
  return (
    <section className="cxsInstallHero" aria-label={say("安装诊断", "Installation diagnostics")}>
      <h3>{say("安装诊断", "Installation diagnostics")}</h3>
      {release && release.installSignal !== undefined ? (
        <>
          {signal ? (
            <p>
              {say("最近记录的网站活动", "Last recorded website activity")} ·{" "}
              <time dateTime={new Date(signal.at).toISOString()}>{new Date(signal.at).toLocaleString()}</time>
              <br />
              {say(...guidance[signal.kind])}
            </p>
          ) : (
            <p>
              {say(
                "尚未记录到网站请求。请在已发布的网站上打开组件并开始对话。若仍无记录，请检查嵌入代码中的项目 ID 和中继地址。",
                "No website request has been recorded since diagnostics began. Open the widget on your published site and start a conversation. If nothing appears, check the project ID and relay address in the snippet."
              )}
            </p>
          )}
          {first != null && (
            <p>
              {say("首次成功的网站对话", "First successful website conversation")} ·{" "}
              <time dateTime={new Date(first).toISOString()}>{new Date(first).toLocaleString()}</time>
            </p>
          )}
        </>
      ) : (
        <p>{say("安装诊断暂不可用。", "Installation diagnostics are unavailable.")}</p>
      )}
      <button
        type="button"
        className="siteButton quiet small"
        disabled={releaseBusy && !release}
        onClick={() => void refreshRelease()}
      >
        {say("刷新诊断", "Refresh diagnostics")}
      </button>
    </section>
  );
}
