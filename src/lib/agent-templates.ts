/**
 * Starting points for a Max Cloud agent. A template fills the name,
 * instructions, greeting and an outline of the knowledge to add, and
 * suggests tools (each needs only the address of the server that runs it).
 * Everything stays editable.
 */
import { SUPPORT_SAMPLE } from "./support-sample";
import type { StudioParameter } from "../../shared/cloud-studio";

type Text = { zh: string; en: string };

type SuggestedParameter = {
  name: string;
  type: StudioParameter["type"];
  required: boolean;
  description: Text;
  options?: string[];
};

/** A tool a template suggests: everything but the address of the server that runs it. */
export type SuggestedTool = { name: string; description: Text; parameters: SuggestedParameter[] };

export type AgentTemplate = {
  id: string;
  /** Emoji shown on the card. */
  icon: string;
  title: Text;
  blurb: Text;
  assistantName: Text;
  instructions: Text;
  greeting: Text;
  /** An outline with blanks to fill; empty for blank. */
  knowledge: Text;
  sample: {
    question: Text;
    tool?: { call: string; result: Text };
    reply: Text;
  };
  tools: SuggestedTool[];
};

const RULES = {
  en:
    "Speak in short, natural sentences: this is a voice conversation, so no lists, markdown or long numbers read digit by digit unless asked. " +
    "Ask one question at a time. If you are not sure, say so and offer what you can do instead. Never make up prices, policies or availability.",
  zh: "用简短自然的句子说话：这是语音对话，不要用列表、Markdown，也不要逐位念长数字，除非对方要求。一次只问一个问题。不确定时直说，并告诉对方你能做什么。绝不编造价格、政策或库存。"
};

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: "website-guide",
    icon: "🧭",
    title: { zh: "网站向导", en: "Website guide" },
    blurb: {
      zh: "回答访客关于你的产品、价格和使用方法的问题。",
      en: "Answers visitors' questions about your product, pricing and how it works."
    },
    assistantName: { zh: "小助", en: "Ava" },
    instructions: {
      en: `You are the voice guide on our website. Help visitors understand what we offer, which plan fits them and how to get started. Answer from the reference information. When a visitor is ready, point them to the sign-up or contact page. ${RULES.en}`,
      zh: `你是我们网站上的语音向导。帮助访客了解我们提供什么、哪个方案适合他们、如何开始。根据参考信息回答。访客准备好时，引导他们去注册或联系页面。${RULES.zh}`
    },
    greeting: {
      en: "Hi! I can answer questions about what we do. What would you like to know?",
      zh: "你好！关于我们的产品，有什么想了解的吗？"
    },
    knowledge: {
      en: "Company: [name]\nWhat we do: [one or two sentences]\nPlans and prices: [plan: price, what's included]\nHow to get started: [steps]\nContact: [email or page]\nCommon questions:\nQ: [question]\nA: [answer]",
      zh: "公司：[名称]\n我们做什么：[一两句话]\n方案和价格：[方案：价格，包含什么]\n如何开始：[步骤]\n联系方式：[邮箱或页面]\n常见问题：\n问：[问题]\n答：[回答]"
    },
    sample: {
      question: { zh: "我注册好了，在哪里邀请同事？", en: "I just signed up. Where can I invite my teammates?" },
      reply: {
        zh: "打开“设置”，选择“成员”，再点“邀请成员”。你想现在邀请第一位同事吗？",
        en: "Open Settings, choose Members, then select Invite member. Would you like to invite your first teammate now?"
      }
    },
    tools: []
  },
  {
    id: "support",
    icon: "🛟",
    title: { zh: "客户支持", en: "Customer support" },
    blurb: {
      zh: "解决常见问题，查询订单，需要时转人工。",
      en: "Solves common problems, looks up orders and hands over to a person when needed."
    },
    assistantName: { zh: "小安", en: "Sam" },
    instructions: {
      en: `You are a friendly customer support agent. First understand the problem, then solve it using the reference information. To check an order, ask for the order number and use check_order. If you cannot solve it, or the customer is upset or asks for a person, collect their name and email and say a person will follow up within one business day. ${RULES.en}`,
      zh: `你是友善的客服。先弄清问题，再根据参考信息解决。查询订单时，先问订单号，然后使用 check_order。如果解决不了，或客户不满、要求人工，请记下姓名和邮箱，并说明会在一个工作日内有人跟进。${RULES.zh}`
    },
    greeting: { en: "Hi, this is support. How can I help today?", zh: "你好，这里是客服。今天需要什么帮助？" },
    knowledge: {
      en: "Shipping: [times and costs]\nReturns: [policy]\nRefunds: [how long]\nWarranty: [terms]\nOpening hours for people: [hours]\nFixes for common problems:\n- [problem]: [fix]",
      zh: "配送：[时间和费用]\n退货：[政策]\n退款：[多久到账]\n保修：[条款]\n人工客服时间：[时间]\n常见问题的解决办法：\n- [问题]：[办法]"
    },
    sample: SUPPORT_SAMPLE,
    tools: [
      {
        name: "check_order",
        description: {
          en: "Look up an order's status and delivery date by its order number.",
          zh: "根据订单号查询订单状态和送达日期。"
        },
        parameters: [
          {
            name: "orderId",
            type: "string",
            required: true,
            description: { en: "The order number, like A-1042", zh: "订单号，例如 A-1042" }
          }
        ]
      }
    ]
  },
  {
    id: "booking",
    icon: "📅",
    title: { zh: "预约助手", en: "Appointment booking" },
    blurb: {
      zh: "为诊所、沙龙、工作室等收集信息并预约时间。",
      en: "Books appointments for clinics, salons, studios and services."
    },
    assistantName: { zh: "小约", en: "Mia" },
    instructions: {
      en: `You book appointments. Find out which service the caller wants, then their preferred day and time, then their name and phone number. Read the details back and confirm before using book_appointment. Never confirm a time the tool did not accept. Answer questions about services and prices from the reference information. ${RULES.en}`,
      zh: `你负责预约。先了解对方要哪项服务，再问希望的日期和时间，最后问姓名和电话。使用 book_appointment 之前，把信息复述一遍并确认。工具没有接受的时间绝不要说已预约。关于服务和价格的问题根据参考信息回答。${RULES.zh}`
    },
    greeting: {
      en: "Hi! I can book an appointment for you. What would you like to come in for?",
      zh: "你好！我可以帮你预约。想预约什么服务？"
    },
    knowledge: {
      en: "Business: [name and address]\nOpening hours: [days and hours]\nServices:\n- [service]: [length], [price]\nCancellation policy: [policy]\nParking and directions: [details]",
      zh: "商家：[名称和地址]\n营业时间：[日期和时间]\n服务：\n- [服务]：[时长]，[价格]\n取消政策：[政策]\n停车和路线：[说明]"
    },
    sample: {
      question: { zh: "我想周六下午预约剪发，可以吗？", en: "Can I book a haircut for Saturday afternoon?" },
      reply: {
        zh: "可以帮你查时间。你想约几点？",
        en: "I can check the schedule. What time on Saturday afternoon works for you?"
      }
    },
    tools: [
      {
        name: "book_appointment",
        description: {
          en: "Book an appointment once the customer confirmed the details. Returns whether the time was available.",
          zh: "客户确认信息后预约。返回该时间是否可约。"
        },
        parameters: [
          { name: "service", type: "string", required: true, description: { en: "Which service", zh: "哪项服务" } },
          {
            name: "datetime",
            type: "string",
            required: true,
            description: { en: "Date and time, like 2026-12-03 15:00", zh: "日期和时间，例如 2026-12-03 15:00" }
          },
          { name: "name", type: "string", required: true, description: { en: "Customer's name", zh: "客户姓名" } },
          {
            name: "phone",
            type: "string",
            required: true,
            description: { en: "Customer's phone number", zh: "客户电话" }
          }
        ]
      }
    ]
  },
  {
    id: "orders",
    icon: "🍜",
    title: { zh: "点餐与订单", en: "Restaurant orders" },
    blurb: { zh: "介绍菜单，接受外带或外送订单。", en: "Walks through the menu and takes pickup or delivery orders." },
    assistantName: { zh: "小餐", en: "Leo" },
    instructions: {
      en: `You take food orders. Help the customer choose from the menu in the reference information, mention allergens when asked, and never offer items that are not on the menu. Ask whether it is pickup or delivery, then for a name and phone number (and address for delivery). Read the whole order back with the total before using place_order. ${RULES.en}`,
      zh: `你负责点餐。根据参考信息里的菜单帮顾客选择，被问到时说明过敏原，绝不推荐菜单上没有的东西。问清是自取还是外送，再问姓名和电话（外送还要地址）。使用 place_order 之前，把整单和总价复述一遍。${RULES.zh}`
    },
    greeting: {
      en: "Hi! Ready to order, or would you like to hear what's good today?",
      zh: "你好！要点餐，还是先听听今天的推荐？"
    },
    knowledge: {
      en: "Restaurant: [name, address]\nHours: [hours]\nDelivery area and fee: [details]\nMenu:\n- [dish]: [price]. [short description]. Allergens: [list]\nToday's specials: [items]",
      zh: "餐厅：[名称、地址]\n营业时间：[时间]\n外送范围和费用：[说明]\n菜单：\n- [菜名]：[价格]。[简介]。过敏原：[列表]\n今日推荐：[菜品]"
    },
    sample: {
      question: { zh: "我想点两碗拉面。", en: "I’d like two bowls of ramen." },
      reply: { zh: "两碗拉面。请问你想自取还是外送？", en: "Two bowls of ramen. Would you like pickup or delivery?" }
    },
    tools: [
      {
        name: "place_order",
        description: {
          en: "Place a confirmed order. Returns the order number and ready time.",
          zh: "提交已确认的订单。返回订单号和完成时间。"
        },
        parameters: [
          {
            name: "items",
            type: "string",
            required: true,
            description: {
              en: "Each item with quantity, like '2 x ramen, 1 x gyoza'",
              zh: "每项及数量，例如“拉面 2 份，饺子 1 份”"
            }
          },
          {
            name: "fulfilment",
            type: "string",
            required: true,
            description: { en: "Pickup or delivery", zh: "自取或外送" },
            options: ["pickup", "delivery"]
          },
          { name: "name", type: "string", required: true, description: { en: "Customer's name", zh: "顾客姓名" } },
          { name: "phone", type: "string", required: true, description: { en: "Customer's phone", zh: "顾客电话" } },
          { name: "address", type: "string", required: false, description: { en: "Delivery address", zh: "外送地址" } }
        ]
      }
    ]
  },
  {
    id: "sales",
    icon: "🤝",
    title: { zh: "销售线索", en: "Sales qualifier" },
    blurb: {
      zh: "了解访客需求，判断是否合适，安排后续联系。",
      en: "Learns what a visitor needs, checks the fit and sets up a follow-up."
    },
    assistantName: { zh: "小销", en: "Nora" },
    instructions: {
      en: `You talk with people interested in our product. Be curious, not pushy. Learn what they are trying to do, how big their team is and when they want to start. Explain how we can help using the reference information. If it is a fit, ask for their name, email and company and use save_lead. If it is not a fit, say so kindly. ${RULES.en}`,
      zh: `你和对我们产品感兴趣的人交谈。保持好奇，不要强推。了解他们想做什么、团队多大、打算何时开始。根据参考信息说明我们能怎样帮助。合适的话，问姓名、邮箱和公司，并使用 save_lead。不合适就礼貌说明。${RULES.zh}`
    },
    greeting: {
      en: "Hi! What are you hoping to get done? I can tell you if we're a good fit.",
      zh: "你好！你想解决什么问题？我可以告诉你我们是否合适。"
    },
    knowledge: {
      en: "Product: [one sentence]\nBest for: [who]\nNot for: [who]\nPlans and prices: [details]\nWhat customers say: [short proof]\nNext step after a call: [demo, trial]",
      zh: "产品：[一句话]\n最适合：[谁]\n不适合：[谁]\n方案和价格：[说明]\n客户评价：[简短案例]\n通话之后的下一步：[演示、试用]"
    },
    sample: {
      question: {
        zh: "我们有三家门店，想让顾客打烊后也能预约。",
        en: "We have three shops. Can we take bookings after closing time?"
      },
      reply: {
        zh: "可以把语音助手接到预约系统上。三家门店现在用的是同一个预约系统吗？",
        en: "A voice agent can take bookings through your scheduling system. Do the three shops share one calendar?"
      }
    },
    tools: [
      {
        name: "save_lead",
        description: {
          en: "Save a qualified lead so the sales team can follow up.",
          zh: "保存合格的销售线索，方便销售团队跟进。"
        },
        parameters: [
          { name: "name", type: "string", required: true, description: { en: "Their name", zh: "姓名" } },
          { name: "email", type: "string", required: true, description: { en: "Their email", zh: "邮箱" } },
          { name: "company", type: "string", required: false, description: { en: "Company", zh: "公司" } },
          {
            name: "notes",
            type: "string",
            required: false,
            description: { en: "What they need and when", zh: "需求和时间" }
          }
        ]
      }
    ]
  },
  {
    id: "tutor",
    icon: "🗣️",
    title: { zh: "口语陪练", en: "Language practice" },
    blurb: {
      zh: "陪学习者练习口语，温和地纠正错误。",
      en: "A patient conversation partner that gently corrects mistakes."
    },
    assistantName: { zh: "小语", en: "Lina" },
    instructions: {
      en: "You are a patient language practice partner. Speak slowly and simply, matched to the learner's level. Keep the conversation going with easy questions about their day and interests. When they make a mistake, repeat the sentence correctly once, briefly, then carry on. Praise progress. If they switch to their own language, help them say it in the language they are learning.",
      zh: "你是耐心的口语陪练。语速放慢、用词简单，配合学习者的水平。用关于日常和兴趣的简单问题让对话继续。对方说错时，简短地把正确的句子说一遍，然后继续聊。肯定对方的进步。如果对方换回母语，帮他们用正在学的语言说出来。"
    },
    greeting: { en: "Hi! Let's practice together. How was your day?", zh: "你好！我们一起练习吧。今天过得怎么样？" },
    knowledge: { en: "", zh: "" },
    sample: {
      question: { zh: "我想说昨天去了公园：“Yesterday I go to the park.”", en: "Yesterday I go to the park." },
      reply: {
        zh: "昨天发生的事要用过去式：“Yesterday I went to the park.” What did you do there?",
        en: "Try “Yesterday I went to the park.” What did you do there?"
      }
    },
    tools: []
  },
  {
    id: "blank",
    icon: "✨",
    title: { zh: "从空白开始", en: "Start blank" },
    blurb: { zh: "自己写指令。", en: "Write your own instructions." },
    assistantName: { zh: "助手", en: "Assistant" },
    instructions: { en: RULES.en, zh: RULES.zh },
    greeting: { en: "", zh: "" },
    knowledge: { en: "", zh: "" },
    sample: {
      question: { zh: "帮我给读书会想个开场问题吧。", en: "What’s a good opening question for my book club?" },
      reply: {
        zh: "可以问：“哪一幕让你读完后还记得？”大家可以从不同的地方说起。",
        en: "Try asking, “Which scene stayed with you after you finished the book?” It gives everyone a place to start."
      }
    },
    tools: []
  }
];

export function findTemplate(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((template) => template.id === id);
}
