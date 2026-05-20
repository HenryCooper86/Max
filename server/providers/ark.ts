import { SUPPORTED_LANGUAGE_MESSAGE, isSupportedLanguageText } from "../../shared/language";

type ArkMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ArkChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

export const DEFAULT_AGENT_SYSTEM_PROMPT =
  "你是 Max，一位友好、冷静、以安全为先的摩托车头盔 AI 助手。你的名字保持 Max，角色保持 Motorcycle Helmet AI assistant。默认使用中文回答；如果骑手明确使用英文，可以用英文回答；如果骑手明确使用日文，可以用日文回答。只允许中文、英文、日文三种语言，不要使用其他语言。如果骑手使用其他语言或要求你使用其他语言，请用中文简短说明：我只支持中文、English、日本語。帮助骑手处理摩托车相关问题、导航、天气、路况、附近停靠点和骑行安全事项。回答要简短、清晰、适合免手操作。骑行中遇到危险或分心请求时，给出更安全的替代方案。声音设定为中文女声。";

export function createLocalHelmetReply(riderText: string) {
  const text = riderText.toLowerCase();

  if (!isSupportedLanguageText(riderText)) {
    return SUPPORTED_LANGUAGE_MESSAGE;
  }

  if (text.includes("gas") || text.includes("fuel") || text.includes("加油") || text.includes("油站")) {
    return "收到。附近油站需要实时位置数据；请先保持骑行安全，必要时靠边后再查看地图。";
  }

  if (
    text.includes("weather") ||
    text.includes("rain") ||
    text.includes("wind") ||
    text.includes("天气") ||
    text.includes("下雨") ||
    text.includes("风")
  ) {
    return "收到。实时天气需要联网数据；请降低风险，注意风雨和路面变化。";
  }

  if (
    text.includes("route") ||
    text.includes("navigation") ||
    text.includes("home") ||
    text.includes("路线") ||
    text.includes("导航") ||
    text.includes("回家")
  ) {
    return "收到。导航需要实时地图连接；先保持当前路线，变更路线前请靠边确认。";
  }

  if (
    text.includes("hear") ||
    text.includes("test") ||
    text.includes("hello") ||
    text.includes("听见") ||
    text.includes("测试") ||
    text.includes("你好")
  ) {
    return "我听得到。Max 正在使用本地备用模式回复。";
  }

  return "收到。Ark 当前不可用，我会用本地备用模式简短回复。请保持骑行安全。";
}

function getArkModel() {
  const model = process.env.ARK_ENDPOINT_ID?.trim() || process.env.ARK_MODEL?.trim() || "doubao-seed-1-6-250615";
  if (model.startsWith("api-key-")) {
    throw new Error(
      "ARK_MODEL/ARK_ENDPOINT_ID must be a public model ID or an endpoint ID like ep-..., not the API key ID."
    );
  }
  return model;
}

export async function askArk(riderText: string) {
  if (!isSupportedLanguageText(riderText)) {
    return createLocalHelmetReply(riderText);
  }

  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) {
    throw new Error("ARK_API_KEY is required for Ark command mode");
  }

  const baseUrl = process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3";
  const model = getArkModel();
  const messages: ArkMessage[] = [
    {
      role: "system",
      content: process.env.HELMET_AGENT_SYSTEM_PROMPT ?? DEFAULT_AGENT_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: riderText
    }
  ];

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.4,
      max_tokens: 160
    })
  });

  const payload = (await response.json()) as ArkChatResponse;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `Ark request failed with HTTP ${response.status}`);
  }

  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("Ark returned an empty response");
  }

  return text;
}
