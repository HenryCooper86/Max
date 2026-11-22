import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createHybridSearch,
  knowledgeConfigFrom,
  knowledgeTool,
  loadKnowledge,
  type KnowledgeIndex
} from "../knowledge";
import { cacheDirFromEnv } from "../knowledge-cache";
import { embedKnowledgePassages, type EmbedJobOptions } from "../knowledge-embed-job";
import { embeddingModelFromEnv, embedTexts, maxPassagesFromEnv, type EmbeddingModel } from "../knowledge-embeddings";
import { createLogger } from "../logger";
import type { ToolDefinition } from "./index";
import { loadMcpTools, mcpServerFrom, type McpServerConfig } from "./mcp";
import { toolSpecFrom } from "./schema";
import { webhookToolFrom } from "./webhook";

/**
 * The relay's own tools: code tools from the `toolsModule`, webhook tools,
 * the knowledge-base search and the tools of remote MCP servers, all declared
 * in `assistant.config.json`. Loaded once at startup (and again when the
 * Studio saves a new config); every session reads the current set.
 */

const log = createLogger("tools");

let installed: ToolDefinition[] = [];
let problems: string[] = [];
/** Bumped on every install, so a retry of an older config never lands. */
let generation = 0;
/** Ends what was started for the tools now installed. */
const closeInstalled: Array<() => void> = [];
let retryTimer: NodeJS.Timeout | undefined;

const MAX_MCP_SERVERS = 8;
const MCP_RETRY_MS = [15_000, 60_000, 300_000];
type EmbedJobTuning = Partial<
  Pick<EmbedJobOptions, "concurrency" | "batchSize" | "attempts" | "backoffMs" | "saveEvery">
>;

/** Embeds the passages after the build has returned, then swaps the tool's searcher. The swap
 *  happens in the caller's closure, so a job from a replaced build only touches its own tool.
 *  Above `limit` passages nothing is embedded and the whole index stays on keyword search. */
async function embedInBackground(
  index: KnowledgeIndex,
  model: EmbeddingModel,
  settings: { request?: typeof fetch; limit: number; cacheDir?: string; job?: EmbedJobTuning },
  swap: (search: (query: string, limit: number) => Promise<ReturnType<KnowledgeIndex["search"]>>) => void
): Promise<void> {
  const { request, limit, cacheDir, job } = settings;
  try {
    if (index.size > limit) {
      log.warn(
        `knowledge has ${index.size} passages; embeddings are limited to ${limit} (KNOWLEDGE_MAX_PASSAGES), so keyword search is used`
      );
      return;
    }
    const texts = index.passageTexts();
    const embed = (ignoreCache: boolean) =>
      embedKnowledgePassages({
        model,
        texts,
        request,
        cacheDir,
        ignoreCache,
        ...job,
        log: { info: (message) => log.info(message), warn: (message) => log.warn(message) }
      });
    const matrix = await embed(false);
    if (!matrix) return;
    let rebuilt = false;
    const embedQuery = async (text: string) => {
      const vector = (await embedTexts(model, [text], { request, timeoutMs: 2000 }))[0]!;
      // Vectors read from the cache that do not fit the model: embed everything again once, and replace the cache.
      if (vector.length !== matrix.dimensions && !rebuilt) {
        rebuilt = true;
        log.warn("knowledge embedding cache: cached vectors do not fit the model, embedding everything again");
        void embed(true)
          .then((again) => {
            if (again) swap(searchWith(again));
          })
          .catch((error: unknown) => {
            log.warn(
              `knowledge embeddings failed, keyword search is used: ${error instanceof Error ? error.message : String(error)}`
            );
          });
      }
      return vector;
    };
    const searchWith = (vectors: typeof matrix) => {
      const hybrid = createHybridSearch(index, vectors, embedQuery, { log: (message) => log.warn(message) });
      return (query: string, max: number) => hybrid(query, max);
    };
    swap(searchWith(matrix));
  } catch (error) {
    log.warn(
      `knowledge embeddings failed, keyword search is used: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export type ServerToolSource = {
  /** Raw `tools` array from the config file. */
  tools?: unknown;
  /** Absolute path of the `toolsModule`, already resolved against the config file. */
  modulePath?: string;
  /** Raw `mcpServers` array from the config file. */
  mcpServers?: unknown;
  /** Raw `knowledge` key from the config file. */
  knowledge?: unknown;
  /** The config file's directory: relative knowledge paths resolve against it. */
  baseDir?: string;
};

type BuiltTools = {
  tools: ToolDefinition[];
  problems: string[];
  /** MCP servers that could not be reached: worth trying again later. */
  unreachable: McpServerConfig[];
  /** Ends what was started for these tools: the processes of MCP servers the relay runs itself. */
  close(): void;
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
  source: ServerToolSource,
  options: {
    request?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    maxEmbeddedPassages?: number;
    cacheDir?: string;
    embedJob?: EmbedJobTuning;
  } = {}
): Promise<BuiltTools> {
  const tools: ToolDefinition[] = [];
  const unreachable: McpServerConfig[] = [];
  const closers: Array<() => void> = [];
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
  const knowledge = knowledgeConfigFrom(source.knowledge, source.baseDir ?? process.cwd());
  if (knowledge.problem) found.push(knowledge.problem);
  if (knowledge.config) {
    const loaded = await loadKnowledge(knowledge.config);
    found.push(...loaded.problems.map((problem) => `knowledge: ${problem}`));
    if (loaded.index.size > 0) {
      let searcher: {
        search(
          query: string,
          limit: number
        ): ReturnType<KnowledgeIndex["search"]> | Promise<ReturnType<KnowledgeIndex["search"]>>;
      } = loaded.index;
      add(knowledgeTool(() => searcher, knowledge.config.maxResults));
      const embeddings = embeddingModelFromEnv(options.env ?? process.env);
      if (embeddings.problem) found.push(`knowledge: ${embeddings.problem}`);
      const env = options.env ?? process.env;
      const limit = maxPassagesFromEnv(env);
      if (limit.problem && embeddings.model) found.push(`knowledge: ${limit.problem}`);
      if (embeddings.model)
        void embedInBackground(
          loaded.index,
          embeddings.model,
          {
            request: options.request,
            limit: options.maxEmbeddedPassages ?? limit.value,
            cacheDir: options.cacheDir ?? cacheDirFromEnv(env),
            job: options.embedJob
          },
          (search) => {
            searcher = { search };
          }
        );
      log.info("knowledge base ready", { documents: loaded.index.sources.length, passages: loaded.index.size });
    } else found.push("knowledge: nothing to search was found, so the assistant has no knowledge base");
  }
  if (source.mcpServers !== undefined) {
    if (!Array.isArray(source.mcpServers)) found.push("mcpServers must be an array");
    else {
      if (source.mcpServers.length > MAX_MCP_SERVERS)
        found.push(`only the first ${MAX_MCP_SERVERS} MCP servers are used`);
      const servers: McpServerConfig[] = [];
      const seen = new Set<string>();
      for (const entry of source.mcpServers.slice(0, MAX_MCP_SERVERS)) {
        const { server, problem } = mcpServerFrom(entry);
        if (problem) found.push(problem);
        if (!server) continue;
        if (seen.has(server.name)) {
          found.push(`mcp server ${server.name} is defined twice; the first definition is used`);
          continue;
        }
        seen.add(server.name);
        servers.push(server);
      }
      // Together: one slow server must not hold the others (or startup) up.
      const loaded = await Promise.all(
        servers.map((server) => loadMcpTools(server, { ...options, onLog: mcpLog(server.name) }))
      );
      loaded.forEach((result, index) => {
        closers.push(result.close);
        result.tools.forEach(add);
        found.push(...result.problems);
        if (result.tools.length === 0 && result.problems.length > 0) unreachable.push(servers[index]!);
      });
    }
  }
  return { tools, problems: found, unreachable, close: () => closers.splice(0).forEach((close) => close()) };
}

/** What an MCP server run as a process writes to its own log, in the relay's. */
function mcpLog(name: string): (line: string) => void {
  return (line) => log.info(`mcp ${name}: ${line}`);
}

/** Tries the MCP servers that were down again, so a relay that started before
 *  its integrations picks their tools up without a restart. */
function retryUnreachable(servers: McpServerConfig[], mine: number, attempt: number): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  if (servers.length === 0) return;
  retryTimer = setTimeout(
    () => {
      retryTimer = undefined;
      void Promise.all(servers.map((server) => loadMcpTools(server, { onLog: mcpLog(server.name) }))).then((loaded) => {
        if (mine !== generation) {
          loaded.forEach((result) => result.close());
          return;
        }
        loaded.forEach((result) => closeInstalled.push(result.close));
        const still: McpServerConfig[] = [];
        const names = new Set(installed.map((tool) => tool.name));
        const added: ToolDefinition[] = [];
        loaded.forEach((result, index) => {
          const server = servers[index]!;
          if (result.tools.length === 0 && result.problems.length > 0) {
            still.push(server);
            return;
          }
          // The server answered: its old "not available" problem no longer holds.
          problems = problems.filter((problem) => !problem.startsWith(`${server.name} MCP server`));
          problems.push(...result.problems);
          for (const tool of result.tools) {
            if (names.has(tool.name)) continue;
            names.add(tool.name);
            added.push(tool);
          }
        });
        if (added.length) {
          installed = [...installed, ...added];
          log.info("MCP tools ready", { tools: added.map((tool) => tool.name) });
        }
        retryUnreachable(still, mine, attempt + 1);
      });
    },
    MCP_RETRY_MS[Math.min(attempt, MCP_RETRY_MS.length - 1)]
  );
  retryTimer.unref?.();
}

/** Loads and installs the relay's tools, logging what was found. */
export async function installServerTools(source: ServerToolSource): Promise<void> {
  const mine = (generation += 1);
  const built = await buildServerTools(source);
  if (mine !== generation) {
    built.close();
    return;
  }
  // The tools this replaces are gone from here on, and with them the processes started for them.
  closeInstalled.splice(0).forEach((close) => close());
  closeInstalled.push(built.close);
  installed = built.tools;
  problems = built.problems;
  for (const problem of problems) log.warn(problem);
  if (installed.length) log.info("tools ready", { tools: installed.map((tool) => tool.name) });
  retryUnreachable(built.unreachable, mine, 0);
}

/**
 * Ends what the relay's tools started: the MCP servers it runs as processes.
 * For shutdown: a process left running would keep the relay itself from exiting.
 */
export function closeServerTools(): void {
  generation += 1;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  closeInstalled.splice(0).forEach((close) => close());
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
  closeServerTools();
  installed = tools;
  problems = [];
}
