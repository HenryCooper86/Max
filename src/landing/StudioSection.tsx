import { useLanguage } from "../components/LanguageToggle";
import { SUPPORT_SAMPLE as sample } from "../lib/support-sample";
import { localized } from "../lib/i18n";
import { CONSOLE_PATH } from "../lib/routes";
import { ScreenRecording } from "./ScreenRecording";

export function StudioSection() {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const code = language === "en-US" ? "en" : "zh";
  return (
    <section className="siteSection" aria-labelledby="studio">
      <header className="sectionHead" data-reveal="">
        <h2 id="studio">{say("在 Studio 里测试你的网站助手", "Test your website agent in Studio")}</h2>
        <p>
          {say(
            "按下麦克风提问，看助手查询订单并给出回答。每个模板还带有一段脚本示例，无需模型密钥，也不占用通话分钟数。",
            "Press the mic, ask a question, and watch the agent look up the order and answer. Every template also includes a scripted sample that needs no model key and uses no minutes."
          )}
        </p>
      </header>
      <div className="siteStudioLayout" data-reveal="">
        <figure className="siteStudioSample">
          <ScreenRecording
            key={code}
            src={`/video/studio-test-${code}.mp4`}
            poster={`/video/studio-test-${code}.jpg`}
            label={say(
              "在 Max Studio 里测试助手查询订单的录屏，模型和订单数据为模拟",
              "Screen recording of testing an order lookup in the Max Studio, with a simulated model and order data"
            )}
          />
          <figcaption>
            {say(
              "Studio 界面录屏。模型回复和订单查询为模拟。",
              "Recorded in the Studio. The model and order lookup are simulated."
            )}
          </figcaption>
          <details>
            <summary>{say("查看文字记录", "Read the transcript")}</summary>
            <dl>
              <dt>{say("访客提问", "Visitor question")}</dt>
              <dd>{say(sample.question.zh, sample.question.en)}</dd>
              <dt>{say("模拟订单查询", "Simulated order lookup")}</dt>
              <dd>
                <code>{sample.tool.call}</code>
                <br />
                {say(sample.tool.result.zh, sample.tool.result.en)}
              </dd>
              <dt>{say("助手回复", "Agent reply")}</dt>
              <dd>{say(sample.reply.zh, sample.reply.en)}</dd>
            </dl>
          </details>
        </figure>
        <div className="siteStudioWorkflow">
          <div>
            <h3>{say("发布经过测试的版本", "Publish the draft you tested")}</h3>
            <p>
              {say(
                "访客继续使用线上版本时，你可以修改草稿并连接模型进行测试。查看改动，发布刚刚测试的版本，需要时可恢复上一个线上版本。",
                "While visitors use the live agent, edit a draft and test it with your model. Review the changes, publish that exact revision, or restore the previous live version."
              )}
            </p>
          </div>
          <div>
            <h3>{say("发布前回放已保存的测试", "Run saved replay checks before publishing")}</h3>
            <p>
              {say(
                "把答错的那一轮对话保存为测试，隐去个人信息，再写下回答应包含的短语。在「发布」旁选择「运行全部」，用模拟工具响应逐项测试当前草稿。展开结果即可对照预期短语和实际回答，或查看运行错误。",
                "Turn a missed answer into a test. Redact the question and set an expected phrase. Choose Run all beside Publish to check the draft with simulated tool responses. Open a result to compare the phrase with the actual answer or see why the run stopped."
              )}
            </p>
            <p>
              {say(
                "修改用例后需重新运行该项测试。保存新版本后需重新运行全部测试。回放结果供发布时参考。发布前仍需对该草稿完成交互测试。",
                "Edit a case and Studio marks it for another run. Save a new revision and all cases need another run. Replay results guide your decision. Publishing requires an interactive test of that revision."
              )}
            </p>
          </div>
          <div>
            <h3>{say("检查网站安装卡在哪一步", "Find out where website setup stopped")}</h3>
            <p>
              {say(
                "在已发布的网站上开始一次对话，再刷新「安装诊断」。查看 Max 最近收到的网站请求或会话活动，以及下一步该检查什么。例如，如果网站来源被拒绝，请核对已发布版本允许的来源。",
                "Start a conversation on your site, then refresh Installation diagnostics. See the last website activity Max recorded and what to check next. If the widget’s origin was rejected, check the allowed origins in the published configuration."
              )}
            </p>
          </div>
          <div>
            <h3>{say("确认访客收到了回答", "Verify the first website conversation")}</h3>
            <p>
              {say(
                "访客首次在网站上得到回答后，安装清单才会标记为完成。管理员可以查看过去 30 天新建项目中完成这一步的比例，以及成功项目从创建到首次对话所用的中位时间。",
                "The checklist marks installation complete when a visitor gets their first answer on your site. Administrators can see the share of projects created in the last 30 days that reached this point and the median time it took them."
              )}
            </p>
          </div>
        </div>
      </div>
      <div className="startActions">
        <a className="siteButton" href={CONSOLE_PATH}>
          {say("打开 Max Cloud 控制台", "Open the Max Cloud console")}
        </a>
      </div>
    </section>
  );
}
