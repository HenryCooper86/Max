import { CopyButton } from "./CopyButton";
import { useSay } from "./hooks";
import { mintTokenSnippet, widgetSnippet } from "./snippetText";

function Snippet({ title, code }: { title: string; code: string }) {
  return (
    <div className="cxSnippet">
      <div className="cxRow spread">
        <h4>{title}</h4>
        <CopyButton text={code} />
      </div>
      <pre className="cxCode" tabIndex={0}>
        {code}
      </pre>
    </div>
  );
}

export function Snippets({ origin }: { origin: string }) {
  const say = useSay();
  return (
    <section className="cxSubsection" aria-labelledby="cx-snippets">
      <h3 id="cx-snippets">{say("加到你的网站", "Add it to your site")}</h3>
      <Snippet
        title={say("1. 在你的后端换取会话令牌", "1. Mint a session token from your backend")}
        code={mintTokenSnippet(origin)}
      />
      <Snippet title={say("2. 在页面里放上组件", "2. Put the widget on your page")} code={widgetSnippet(origin)} />
      <p className="cxMuted">
        {say(
          "/api/voice-token 是你自己的后端接口，它去调用上面第 1 步。",
          "/api/voice-token is your own backend route, calling step 1 above."
        )}
      </p>
    </section>
  );
}
