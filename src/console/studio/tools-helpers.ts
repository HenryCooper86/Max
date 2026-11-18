import { STUDIO_LIMITS, type StudioParameter, type StudioTool } from "../../../shared/cloud-studio";
import type { SuggestedTool } from "../../lib/agent-templates";

/** Lowercase, spaces and dashes to underscores, drop anything a tool name cannot hold. */
export function sanitizeToolName(raw: string): string {
  let name = raw
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^[^a-z]+/, "");
  name = name.slice(0, 48);
  return name;
}

export function blankTool(existing: StudioTool[]): StudioTool {
  let n = existing.length + 1;
  const taken = new Set(existing.map((tool) => tool.name));
  while (taken.has(`tool_${n}`)) n += 1;
  return { name: `tool_${n}`, description: "", url: "", parameters: [] };
}

export function blankParameter(existing: StudioParameter[]): StudioParameter {
  let n = existing.length + 1;
  const taken = new Set(existing.map((parameter) => parameter.name));
  while (taken.has(`value${n}`)) n += 1;
  return { name: `value${n}`, type: "string", description: "", required: false, options: [] };
}

/** A template's suggested tool as a tool that only lacks its address. */
export function toolFromSuggestion(suggestion: SuggestedTool, language: "zh" | "en"): StudioTool {
  return {
    name: suggestion.name,
    description: suggestion.description[language],
    url: "",
    parameters: suggestion.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      description: parameter.description[language],
      required: parameter.required,
      options: [...(parameter.options ?? [])]
    }))
  };
}

export function parseOptions(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, STUDIO_LIMITS.enumValues);
}

/** Sample values typed in the test form, turned into what the tool expects. Empty optional values are left out. */
export function coerceSampleArgs(
  parameters: StudioParameter[],
  values: Record<string, string>
): { args: Record<string, unknown>; missing: string[]; invalid: string[] } {
  const args: Record<string, unknown> = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const parameter of parameters) {
    const raw = (values[parameter.name] ?? "").trim();
    if (!raw) {
      if (parameter.type === "boolean" && !parameter.required) continue;
      if (parameter.required) missing.push(parameter.name);
      continue;
    }
    if (parameter.type === "number") {
      const value = Number(raw);
      if (Number.isFinite(value)) args[parameter.name] = value;
      else invalid.push(parameter.name);
    } else if (parameter.type === "boolean") {
      args[parameter.name] = ["true", "yes", "1", "on"].includes(raw.toLowerCase());
    } else {
      args[parameter.name] = raw;
    }
  }
  return { args, missing, invalid };
}

function sampleValue(parameter: StudioParameter): unknown {
  if (parameter.options.length > 0 && parameter.type === "string") return parameter.options[0];
  if (parameter.type === "number") return 1;
  if (parameter.type === "boolean") return true;
  return "example";
}

/** The JSON body Max sends to a tool's address, built from the tool (or a sample). */
export function exampleRequest(tool?: StudioTool): string {
  const args: Record<string, unknown> = {};
  for (const parameter of tool?.parameters ?? []) args[parameter.name] = sampleValue(parameter);
  if (!tool) args.orderId = "A-1042";
  return JSON.stringify(
    {
      tool: tool?.name || "check_order",
      callId: "call_8f2c1",
      arguments: args,
      session: { id: "4b1e9a", language: "en" }
    },
    null,
    2
  );
}

export const EXPRESS_EXAMPLE = `import crypto from "node:crypto";
import express from "express";

const app = express();
const SECRET = process.env.MAX_SIGNING_SECRET; // whsec_...

// Keep the raw body: the signature is computed over it.
app.post("/my-tool", express.raw({ type: "application/json" }), (req, res) => {
  const timestamp = req.get("x-voice-agent-timestamp") ?? "";
  const signature = req.get("x-voice-agent-signature") ?? "";
  const expected =
    "sha256=" + crypto.createHmac("sha256", SECRET).update(timestamp + "." + req.body.toString()).digest("hex");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  const tooOld = Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000;
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || tooOld) {
    return res.status(401).json({ error: "bad signature" });
  }

  const { tool, arguments: args } = JSON.parse(req.body.toString());
  // Do the work here, then answer with JSON the agent can read.
  res.json({ result: "Order " + args.orderId + " ships tomorrow." });
});

app.listen(3000);
`;

export function truncateJson(value: unknown, max = 2000): string {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** A tool is testable only when the saved project holds exactly this tool. */
export function savedUnchanged(tool: StudioTool, saved: StudioTool[]): boolean {
  const json = JSON.stringify(tool);
  return saved.some((item) => JSON.stringify(item) === json);
}
