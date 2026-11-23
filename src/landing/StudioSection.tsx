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
            <h3>{say("用答错的问题测试下一版", "Test the next draft against a missed answer")}</h3>
            <p>
              {say(
                "从出错的那一轮对话创建测试，编辑问题或隐去个人信息，再写下回答应包含的短语。重放时让工具返回模拟结果，对照实际回答检查修复效果。",
                "Save a failed turn as a test. Edit or redact the question, specify a phrase the answer should contain, and replay it against a draft with simulated tool responses."
              )}
            </p>
          </div>
          <div>
            <h3>{say("确认访客收到了回答", "Verify the first website conversation")}</h3>
            <p>
              {say(
                "复制嵌入代码后，安装清单会一直等待，直到网站访客第一次得到助手的回答。管理员还能看到过去 30 天新建项目中达成这一步的比例，以及成功项目从创建到首次对话所用的中位时间。",
                "After you copy the snippet, the install checklist stays open until a visitor gets an answer on your site. Administrators can see what percentage of projects created in the last 30 days reached that point and the median time it took those projects."
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
