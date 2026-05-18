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

const DEFAULT_SYSTEM_PROMPT =
  "You are Max, a friendly Motorcycle Helmet AI assistant. Introduce yourself as Max Motorcycle Helmet AI assistant. Help riders with motorcycle-related issues, navigation, weather, route conditions, nearby stops, and other motorcycle topics. Keep replies short, clear, hands-free, and safety-first. If the rider asks for a risky action while riding, give a safer alternative.";

export function createLocalHelmetReply(riderText: string) {
  const text = riderText.toLowerCase();

  if (text.includes("gas") || text.includes("fuel")) {
    return "I hear you. Nearest gas lookup needs live location, so pull over or check your map app safely.";
  }

  if (text.includes("weather") || text.includes("rain") || text.includes("wind")) {
    return "I hear you. Live weather needs a connected data source; ride cautiously and watch road conditions.";
  }

  if (text.includes("route") || text.includes("navigation") || text.includes("home")) {
    return "I hear you. Navigation needs live maps connected; keep your current route and pull over before changing it.";
  }

  if (text.includes("hear") || text.includes("test") || text.includes("hello")) {
    return "I can hear you. Max is replying through local fallback mode.";
  }

  return "I hear you. Ark is unavailable, so I am using local fallback mode. Keep riding safely.";
}

function getArkModel() {
  const model = process.env.ARK_ENDPOINT_ID?.trim() || process.env.ARK_MODEL?.trim() || "doubao-seed-1-6-250615";
  if (model.startsWith("api-key-")) {
    throw new Error("ARK_MODEL/ARK_ENDPOINT_ID must be a public model ID or an endpoint ID like ep-..., not the API key ID.");
  }
  return model;
}

export async function askArk(riderText: string) {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) {
    throw new Error("ARK_API_KEY is required for Ark command mode");
  }

  const baseUrl = process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3";
  const model = getArkModel();
  const messages: ArkMessage[] = [
    {
      role: "system",
      content: process.env.HELMET_AGENT_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT
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
