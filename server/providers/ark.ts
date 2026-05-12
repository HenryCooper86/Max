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
  "You are Horizon, an AI voice agent for a motorcycle helmet. Keep replies short, clear, hands-free, and safety-first. If the rider asks for a risky action while riding, give a safer alternative.";

export async function askArk(riderText: string) {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) {
    throw new Error("ARK_API_KEY is required for Ark command mode");
  }

  const baseUrl = process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3";
  const model = process.env.ARK_MODEL ?? "doubao-seed-1-6-250615";
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
