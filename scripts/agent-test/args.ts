/** Command-line parsing for `agent-test`, kept apart from the CLI so it can be tested without running anything. */

type CliOptions = {
  relay: string;
  token?: string;
  tokenUrl?: string;
  paths: string[];
  repeat: number;
  concurrency: number;
  report?: string;
  filter?: string;
  local: boolean;
  judgeModel?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  turnTimeoutMs?: number;
  settleMs?: number;
  verbose: boolean;
};

export type ParsedArgs = { options: CliOptions; help: false } | { help: true } | { error: string };

export const USAGE = `Usage: tsx scripts/agent-test/cli.ts --relay ws://localhost:8787 [--token T | --token-url URL] <files or directories…>
         [--repeat N] [--concurrency N] [--report report.json] [--filter substring] [--local]
         [--judge-model M] [--turn-timeout-ms N] [--settle-ms N] [--verbose]

  --relay URL            relay base URL (ws, wss, http or https). Default: $RELAY_URL
  --token T              relay or session token, sent as a Bearer header. Default: $RELAY_AUTH_TOKEN
  --token-url URL        POST here before each connection; it must answer { "token": "…" }
  --repeat N             run every scenario N times (default 1), with a pass rate per scenario
  --concurrency N        sessions open at once (default 1)
  --report FILE          write every run's transcript, tool activity, assertions and latencies as JSON
  --filter TEXT          only scenarios whose name contains TEXT
  --local                use Ollama on localhost:11434 (qwen3:8b) when no other model is configured
  --judge-model M        model for the judge only
  --llm-base-url URL     OpenAI-compatible base URL. Default: $AGENT_TEST_LLM_BASE_URL
  --llm-api-key KEY      Default: $AGENT_TEST_LLM_API_KEY
  --llm-model M          Default: $AGENT_TEST_LLM_MODEL (else gpt-4o-mini with $OPENAI_API_KEY)
  --turn-timeout-ms N    fail a turn with no complete reply after N ms (default 30000)
  --settle-ms N          quiet time to wait for a follow-up reply (default 400)
  --verbose              print every relay event

Exit code: 0 all runs passed, 1 a run failed, 2 usage or scenario-file error.`;

const VALUE_FLAGS = [
  "relay",
  "token",
  "token-url",
  "repeat",
  "concurrency",
  "report",
  "filter",
  "judge-model",
  "llm-base-url",
  "llm-api-key",
  "llm-model",
  "turn-timeout-ms",
  "settle-ms"
] as const;
const BOOLEAN_FLAGS = ["local", "verbose", "help"] as const;

/** `http(s)://` becomes `ws(s)://`, and a trailing slash or `/agent` is dropped, so any form of the relay's address works. */
export function normalizeRelayUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  // A token in the query string would be lost when "/agent" is appended; ask for --token instead.
  if (url.search || url.hash) return undefined;
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined;
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/agent$/, "");
  return url.toString().replace(/\/$/, "");
}

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined> = {}): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      paths.push(arg);
      continue;
    }
    const [name = "", inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      flags.add(name);
    } else if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        return { error: `--${name} needs a value` };
      }
      values.set(name, value);
    } else {
      return { error: `unknown option --${name}` };
    }
  }
  if (flags.has("help")) return { help: true };

  const integer = (name: string, fallback: number | undefined, min: number): number | undefined | { error: string } => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min)
      return { error: `--${name} must be a whole number of at least ${min}` };
    return value;
  };
  const repeat = integer("repeat", 1, 1);
  const concurrency = integer("concurrency", 1, 1);
  const turnTimeoutMs = integer("turn-timeout-ms", undefined, 1);
  const settleMs = integer("settle-ms", undefined, 0);
  for (const value of [repeat, concurrency, turnTimeoutMs, settleMs]) {
    if (typeof value === "object") return value;
  }

  const rawRelay = values.get("relay") ?? env.RELAY_URL;
  if (!rawRelay) return { error: "--relay is required (or set RELAY_URL), e.g. --relay ws://localhost:8787" };
  const relay = normalizeRelayUrl(rawRelay);
  if (!relay)
    return {
      error:
        "--relay must be a ws://, wss://, http:// or https:// URL without a query string (pass the token with --token)"
    };
  const token = values.get("token") ?? env.RELAY_AUTH_TOKEN;
  const tokenUrl = values.get("token-url");
  if (values.has("token") && tokenUrl) return { error: "use --token or --token-url, not both" };
  if (!paths.length) return { error: "name at least one scenario file or directory" };

  const optional = <K extends keyof CliOptions>(key: K, value: CliOptions[K] | undefined) =>
    value === undefined ? {} : { [key]: value };
  return {
    help: false,
    options: {
      relay,
      paths,
      repeat: repeat as number,
      concurrency: concurrency as number,
      local: flags.has("local"),
      verbose: flags.has("verbose"),
      // An explicit --token-url wins over a token that only came from the environment.
      ...(tokenUrl ? {} : optional("token", token)),
      ...optional("tokenUrl", tokenUrl),
      ...optional("report", values.get("report")),
      ...optional("filter", values.get("filter")),
      ...optional("judgeModel", values.get("judge-model")),
      ...optional("llmBaseUrl", values.get("llm-base-url")),
      ...optional("llmApiKey", values.get("llm-api-key")),
      ...optional("llmModel", values.get("llm-model")),
      ...optional("turnTimeoutMs", turnTimeoutMs as number | undefined),
      ...optional("settleMs", settleMs as number | undefined)
    }
  };
}
