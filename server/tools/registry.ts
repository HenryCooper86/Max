import path from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../logger";
import type { ToolDefinition } from "./index";
import { toolSpecFrom } from "./schema";
import { webhookToolFrom } from "./webhook";

/**
 * The relay's own tools: webhook tools from `assistant.config.json` and code
 * tools from its `toolsModule`. Loaded once at startup (and again when the
 * Studio saves a new config); every session reads the current set.
 */

const log = createLogger("tools");

let installed: ToolDefinition[] = [];
let problems: string[] = [];

export type ServerToolSource = {
  /** Raw `tools` array from the config file. */
  tools?: unknown;
  /** Absolute path of the `toolsModule`, already resolved against the config file. */
  modulePath?: string;
};

function isTool(value: unknown): value is ToolDefinition {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as ToolDefinition).name === "string" &&
    typeof (value as ToolDefinition).handler === "function"
  );
}

/** Imports a code-tools module. Its default export (or a named `tools` export)
 *  must be an array of tool definitions. */
export async function loadToolsModule(modulePath: string): Promise<{ tools: ToolDefinition[]; problems: string[] }> {
  const found: string[] = [];
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(pathToFileURL(path.resolve(modulePath)).href)) as Record<string, unknown>;
  } catch (error) {
    return {
      tools: [],
      problems: [`toolsModule ${modulePath} failed to load: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
  const exported = loaded.default ?? loaded.tools;
  if (!Array.isArray(exported)) {
    return { tools: [], problems: [`toolsModule ${modulePath} must export an array of tools (export default [...])`] };
  }
  const tools: ToolDefinition[] = [];
  for (const candidate of exported) {
    if (!isTool(candidate)) {
      found.push(`toolsModule ${modulePath}: every entry needs a name and a handler function`);
      continue;
    }
    const { spec, problem } = toolSpecFrom(candidate);
    if (!spec) {
      found.push(`toolsModule ${modulePath}: ${problem}`);
      continue;
    }
    tools.push({ ...candidate, ...spec });
  }
  return { tools, problems: found };
}

/** Builds the tool set from a config source. Bad entries are skipped with a
 *  reason; one broken tool must not take the others (or the relay) down. */
export async function buildServerTools(
  source: ServerToolSource
): Promise<{ tools: ToolDefinition[]; problems: string[] }> {
  const tools: ToolDefinition[] = [];
  const found: string[] = [];
  const names = new Set<string>();
  const add = (tool: ToolDefinition) => {
    if (names.has(tool.name)) {
      found.push(`tool ${tool.name} is defined twice; the first definition is used`);
      return;
    }
    names.add(tool.name);
    tools.push(tool);
  };
  if (source.modulePath) {
    const fromModule = await loadToolsModule(source.modulePath);
    fromModule.tools.forEach(add);
    found.push(...fromModule.problems);
  }
  if (source.tools !== undefined) {
    if (!Array.isArray(source.tools)) found.push("tools must be an array");
    else {
      for (const entry of source.tools) {
        const { tool, problem } = webhookToolFrom(entry);
        if (tool) add(tool);
        else if (problem) found.push(problem);
      }
    }
  }
  return { tools, problems: found };
}

/** Loads and installs the relay's tools, logging what was found. */
export async function installServerTools(source: ServerToolSource): Promise<void> {
  const built = await buildServerTools(source);
  installed = built.tools;
  problems = built.problems;
  for (const problem of problems) log.warn(problem);
  if (installed.length) log.info("tools ready", { tools: installed.map((tool) => tool.name) });
}

/** The relay's current tools. */
export function serverTools(): readonly ToolDefinition[] {
  return installed;
}

/** Problems found the last time tools were loaded (for /health and startup). */
export function serverToolProblems(): readonly string[] {
  return problems;
}

/** Test seam. */
export function setServerToolsForTests(tools: ToolDefinition[] = []): void {
  installed = tools;
  problems = [];
}
