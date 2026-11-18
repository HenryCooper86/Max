// What Max costs, in one place. The pricing page, the README and docs/pricing.md
// say the same thing; change it here first.

import { REPOSITORY_URL } from "./routes";

type Bilingual = { zh: string; en: string };

export type Plan = {
  id: "open-source" | "cloud" | "enterprise";
  name: Bilingual;
  price: Bilingual;
  /** Shown under the price: what the price is for. */
  priceNote: Bilingual;
  summary: Bilingual;
  features: Bilingual[];
  cta: { label: Bilingual; href: string };
  /** A short label beside the name, such as "Early access". */
  badge?: Bilingual;
  /** The plan to look at first. */
  featured?: boolean;
};

/** Where business conversations happen: the repository's public Discussions. */
export const CONTACT_URL = `${REPOSITORY_URL}/discussions/new?category=general`;

/** Max Cloud's price, used in the copy below. */
export const CLOUD_PRICE_PER_MINUTE_USD = 0.02;
const CLOUD_FREE_MINUTES_PER_MONTH = 1000;

export const PLANS: readonly Plan[] = [
  {
    id: "open-source",
    name: { zh: "开源版", en: "Open source" },
    price: { zh: "免费", en: "Free" },
    priceNote: { zh: "永久免费，MIT 许可", en: "Forever. MIT licensed." },
    summary: {
      zh: "自己部署整个工具包，所有功能都在里面。",
      en: "Run the whole kit yourself. Nothing is held back."
    },
    features: [
      { zh: "本仓库的全部内容", en: "Everything in this repository" },
      { zh: "部署在你自己的服务器或 Docker 上", en: "Host it on your own server or with Docker" },
      { zh: "所有语音后端、工具、SDK 和组件", en: "Every voice backend, tools, the SDK and the widget" },
      { zh: "可以用在商业产品里", en: "Use it in commercial products" },
      { zh: "GitHub 社区支持", en: "Community support on GitHub" }
    ],
    cta: { label: { zh: "开始使用", en: "Get started" }, href: `${REPOSITORY_URL}#quick-start` }
  },
  {
    id: "cloud",
    name: { zh: "Max Cloud", en: "Max Cloud" },
    price: { zh: "¥0.15 / 分钟", en: "¥0.15 / minute" },
    priceNote: {
      zh: `每月前 ${CLOUD_FREE_MINUTES_PER_MONTH.toLocaleString("en-US")} 分钟免费 · 约 $${CLOUD_PRICE_PER_MINUTE_USD}`,
      en: `First ${CLOUD_FREE_MINUTES_PER_MONTH.toLocaleString("en-US")} minutes every month free · about $${CLOUD_PRICE_PER_MINUTE_USD}`
    },
    summary: {
      zh: "我们运行中继服务，你使用自己的模型密钥。",
      en: "We run the relay. You bring your own model key."
    },
    features: [
      { zh: "托管中继：TLS、扩容和更新都由我们负责", en: "Hosted relay with TLS, scaling and updates handled" },
      {
        zh: "使用你自己的 OpenAI、Gemini 或 xAI 密钥，模型费用直接付给他们",
        en: "Your own OpenAI, Gemini or xAI key: model costs go straight to them"
      },
      { zh: "按用户的用量统计和上限", en: "Usage per user, with limits you set" },
      {
        zh: "同样的 SDK 和协议，随时可以改回自己部署",
        en: "Same SDK and protocol: move to self-hosting any time"
      }
    ],
    cta: { label: { zh: "免费开始", en: "Start free" }, href: "/console" },
    badge: { zh: "抢先体验", en: "Early access" },
    featured: true
  },
  {
    id: "enterprise",
    name: { zh: "企业版", en: "Enterprise" },
    price: { zh: "按需定价", en: "Custom" },
    priceNote: { zh: "年度合同", en: "Annual agreement" },
    summary: {
      zh: "给要把语音功能上线到生产环境的团队。",
      en: "For teams putting voice into production."
    },
    features: [
      { zh: "有服务等级协议（SLA）的优先支持", en: "Priority support with an SLA" },
      { zh: "协助部署在你自己的基础设施上", en: "Help deploying on your own infrastructure" },
      { zh: "定制工具、后端和集成", en: "Custom tools, backends and integrations" },
      { zh: "安全评审和团队培训", en: "Security review and team onboarding" }
    ],
    cta: { label: { zh: "联系我们", en: "Talk to us" }, href: CONTACT_URL }
  }
];

export type Question = { question: Bilingual; answer: Bilingual };

export const PRICING_FAQ: readonly Question[] = [
  {
    question: { zh: "Max 真的免费吗？", en: "Is Max really free?" },
    answer: {
      zh: "是的。Max 使用 MIT 许可：你可以使用、修改它，也可以销售基于它的产品，不用付费，只需保留许可声明。",
      en: "Yes. Max is MIT licensed: use it, change it and sell products built on it, with no fee. Just keep the license notice."
    }
  },
  {
    question: { zh: "怎么计算分钟？", en: "What counts as a minute?" },
    answer: {
      zh: "语音会话连接着的时间，按秒计费。一次 90 秒的会话算 1.5 分钟。",
      en: "The time a voice session is connected, billed by the second. A 90-second session counts as 1.5 minutes."
    }
  },
  {
    question: { zh: "为什么要用自己的模型密钥？", en: "Why bring my own model key?" },
    answer: {
      zh: "模型费用按服务商的价格直接付给服务商，我们的费用只覆盖托管。不加价，没有意外。",
      en: "Model costs go straight to your provider at their prices; our fee covers hosting only. No markup and no surprises."
    }
  },
  {
    question: { zh: "Max Cloud 现在可以用吗？", en: "Can I use Max Cloud today?" },
    answer: {
      zh: "可以。目前是抢先体验：在控制台注册就能开始，每月前 1,000 分钟免费。",
      en: "Yes, in early access. Sign up in the console and start right away; the first 1,000 minutes every month are free."
    }
  },
  {
    question: { zh: "怎么付款？", en: "How do I pay?" },
    answer: {
      zh: "用多少扣多少，没有订阅：先用每月的免费分钟，再从余额里扣。在线支付（微信支付、支付宝）开放之前，联系我们即可增加余额。",
      en: "Minutes are deducted as you use them; there is no subscription. Free minutes go first, then your balance. Until online payment (WeChat Pay, Alipay) opens, contact us to add balance."
    }
  },
  {
    question: { zh: "以后可以从 Cloud 改回自己部署吗？", en: "Can I move from Cloud to self-hosting later?" },
    answer: {
      zh: "可以。代码、SDK 和协议都一样，只要改一个地址。",
      en: "Yes. The code, the SDK and the protocol are the same; you change one URL."
    }
  },
  {
    question: { zh: "我可以向自己的客户收费吗？", en: "Can I charge my own customers?" },
    answer: {
      zh: "可以。中继会按用户统计用量、执行你设的上限，并把每次会话的用量发送到你的计费系统。",
      en: "Yes. The relay counts usage per user, enforces limits you set, and can send each session's usage to your billing system."
    }
  }
];

/** The guide to metering and billing your own customers. */
export const BILLING_GUIDE_URL = `${REPOSITORY_URL}/blob/main/docs/usage-and-billing.md`;
