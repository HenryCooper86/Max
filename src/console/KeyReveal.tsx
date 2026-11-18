import { CopyButton } from "./CopyButton";
import { useSay } from "./hooks";

/** A project key, shown once. */
export function KeyReveal({
  projectName,
  apiKey,
  onDismiss
}: {
  projectName: string;
  apiKey: string;
  onDismiss: () => void;
}) {
  const say = useSay();
  return (
    <section className="cxCard cxReveal" aria-labelledby="cx-reveal">
      <h3 id="cx-reveal">{say(`“${projectName}” 的密钥`, `API key for “${projectName}”`)}</h3>
      <p className="cxWarn">{say("现在就保存：之后不会再显示。", "Save it now — it won't be shown again.")}</p>
      <code className="cxCode" tabIndex={0}>
        {apiKey}
      </code>
      <div className="cxRow">
        <CopyButton text={apiKey} label={say("复制密钥", "Copy key")} />
        <button type="button" className="siteButton quiet small" onClick={onDismiss}>
          {say("我已保存", "I've saved it")}
        </button>
      </div>
    </section>
  );
}
