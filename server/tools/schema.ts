import type { ToolParameters, ToolSpec } from "./index";

/**
 * Validation shared by every way a tool reaches the relay: the config file,
 * a code module and a client's `session.start`. A tool the model cannot use
 * correctly is worse than no tool, so a bad declaration is dropped with a
 * reason rather than passed upstream to fail mid-conversation.
 */

const TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
export const MAX_TOOL_DESCRIPTION = 1024;
const MAX_TOOL_PARAMETERS_BYTES = 8 * 1024;
export const MAX_CLIENT_TOOLS = 32;
/** Tool output reaching the model is capped: a whole web page would drown the reply. */
export const MAX_TOOL_OUTPUT_CHARS = 16 * 1024;

const EMPTY_PARAMETERS: ToolParameters = { type: "object", properties: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Returns the reason a declaration is unusable, or the clean spec. */
export function toolSpecFrom(raw: unknown): { spec?: ToolSpec; problem?: string } {
  if (!isRecord(raw)) return { problem: "a tool must be an object" };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!TOOL_NAME.test(name)) return { problem: `invalid tool name ${JSON.stringify(raw.name ?? "")}` };
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (!description) return { problem: `tool ${name} needs a description` };
  if (description.length > MAX_TOOL_DESCRIPTION)
    return { problem: `tool ${name}: description is longer than ${MAX_TOOL_DESCRIPTION} characters` };
  let parameters = EMPTY_PARAMETERS;
  if (raw.parameters !== undefined && raw.parameters !== null) {
    if (!isRecord(raw.parameters)) return { problem: `tool ${name}: parameters must be a JSON Schema object` };
    const type = raw.parameters.type;
    if (type !== undefined && type !== "object")
      return { problem: `tool ${name}: parameters must describe an object (type: "object")` };
    let encoded: string;
    try {
      encoded = JSON.stringify(raw.parameters);
    } catch {
      return { problem: `tool ${name}: parameters are not JSON` };
    }
    if (Buffer.byteLength(encoded) > MAX_TOOL_PARAMETERS_BYTES)
      return { problem: `tool ${name}: parameters are larger than ${MAX_TOOL_PARAMETERS_BYTES / 1024} KiB` };
    parameters = { type: "object", ...(JSON.parse(encoded) as ToolParameters) };
  }
  return { spec: { name, description, parameters } };
}

/** Clean specs from a client's `session.start.tools`. Throws on anything malformed:
 *  a client that sends a broken tool list has a bug its developer should see. */
export function clientToolSpecsFrom(raw: unknown): ToolSpec[] {
  if (!Array.isArray(raw)) throw new Error("Invalid tools: expected an array");
  if (raw.length > MAX_CLIENT_TOOLS) throw new Error(`Invalid tools: at most ${MAX_CLIENT_TOOLS}`);
  const seen = new Set<string>();
  const specs: ToolSpec[] = [];
  for (const item of raw) {
    const { spec, problem } = toolSpecFrom(item);
    if (!spec) throw new Error(`Invalid tools: ${problem}`);
    if (seen.has(spec.name)) throw new Error(`Invalid tools: duplicate tool ${spec.name}`);
    seen.add(spec.name);
    specs.push(spec);
  }
  return specs;
}

/** What the model sees as a tool's result: text, capped. */
export function toolOutputText(output: unknown): string {
  let text: string;
  if (typeof output === "string") text = output;
  else if (output === undefined) text = '{"ok":true}';
  else {
    try {
      text = JSON.stringify(output) ?? '{"ok":true}';
    } catch {
      text = String(output);
    }
  }
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}…[truncated]` : text;
}

/** The result the model sees when a tool failed. */
export function toolErrorText(error: string): string {
  return JSON.stringify({ error: error.slice(0, 500) });
}

/** Parses the model's argument string. Models occasionally emit an empty string
 *  for "no arguments"; anything else that is not a JSON object is an error. */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") throw new Error("tool arguments must be a JSON object");
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("tool arguments must be a JSON object");
  return parsed;
}
