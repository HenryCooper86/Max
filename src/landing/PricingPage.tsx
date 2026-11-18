import { useLanguage } from "../components/LanguageToggle";
import { Mascot } from "../components/Mascot";
import { localized } from "../lib/i18n";
import { BILLING_GUIDE_URL, PLANS, PRICING_FAQ, type Plan } from "../lib/pricing";

function PlanCard({ plan }: { plan: Plan }) {
  const { language } = useLanguage();
  const say = (text: { zh: string; en: string }) => localized(language, text.zh, text.en);
  const headingId = `plan-${plan.id}`;
  return (
    <article className={`planCard${plan.featured ? " featured" : ""}`} aria-labelledby={headingId}>
      <header>
        <h2 id={headingId}>
          {say(plan.name)}
          {plan.badge ? <span className="planBadge">{say(plan.badge)}</span> : null}
        </h2>
        <p className="planSummary">{say(plan.summary)}</p>
      </header>
      <p className="planPrice">
        <strong>{say(plan.price)}</strong>
        <span>{say(plan.priceNote)}</span>
      </p>
      <ul className="planFeatures">
        {plan.features.map((feature) => (
          <li key={feature.en}>{say(feature)}</li>
        ))}
      </ul>
      <a className={`siteButton${plan.featured ? "" : " secondary"}`} href={plan.cta.href} rel="noreferrer noopener">
        {say(plan.cta.label)}
      </a>
    </article>
  );
}

/** What Max costs: free to self-host, a hosted Cloud, and Enterprise help. */
export function PricingPage() {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  return (
    <div className="pricingPage">
      <header className="buildIntro">
        <h1>{say("价格", "Pricing")}</h1>
        <p>
          {say(
            "Max 免费、开源。只有当你希望我们替你运行它，或需要我们随时提供支持时，才需要付费。",
            "Max is free and open source. You pay only if you want us to run it for you, or to have us on call."
          )}
        </p>
      </header>

      <div className="planGrid">
        {PLANS.map((plan) => (
          <PlanCard key={plan.id} plan={plan} />
        ))}
      </div>

      <section className="pricingFaq" aria-labelledby="pricing-faq">
        <h2 id="pricing-faq">{say("常见问题", "Questions")}</h2>
        <dl>
          {PRICING_FAQ.map((item) => (
            <div key={item.question.en}>
              <dt>{localized(language, item.question.zh, item.question.en)}</dt>
              <dd>{localized(language, item.answer.zh, item.answer.en)}</dd>
            </div>
          ))}
        </dl>
        <p className="pricingFootnote">
          {say("向自己的客户收费？请看", "Charging your own customers? Read")}{" "}
          <a className="siteTextLink" href={BILLING_GUIDE_URL} rel="noreferrer noopener">
            {say("用量与计费指南", "the usage and billing guide")}
          </a>
          .
        </p>
      </section>
      {/* The bird keeps visitors company here too, as on every public page. */}
      <Mascot
        className="siteBird"
        mood="ready"
        followCursor
        restOver="a, button, .planCard, .pricingFaq dt, .siteHeader"
      />
    </div>
  );
}
