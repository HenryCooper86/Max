import fs from "node:fs";
import path from "node:path";
import { USAGE, parseArgs } from "./args";
import { resolveModelSettings } from "./model";
import { buildReport, formatFailure, formatRunLine, formatSummary, summarize } from "./report";
import { runAll, type RunOptions } from "./run";
import { loadScenarios } from "./scenario";

/**
 * `agent-test`: plays scenarios against a running relay over the real /agent
 * WebSocket in text mode and reports which assertions held. See
 * examples/agent-tests for scenario files.
 *
 *   tsx scripts/agent-test/cli.ts --relay ws://localhost:8787 examples/agent-tests
 */

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const parsed = parseArgs(argv, env);
  if ("error" in parsed) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  const { options } = parsed;
  // The token must never be printed, even inside an error message from a library.
  const secrets = [options.token, options.llmApiKey, env.AGENT_TEST_LLM_API_KEY, env.OPENAI_API_KEY].filter(
    (secret): secret is string => Boolean(secret)
  );
  const scrub = (text: string) => secrets.reduce((out, secret) => out.split(secret).join("***"), text);

  const loaded = loadScenarios(options.paths);
  if (loaded.problems.length) {
    console.error(`Scenario problems (${loaded.problems.length}):`);
    for (const problem of loaded.problems) console.error(`  ${problem}`);
    return 2;
  }
  const filter = options.filter?.toLowerCase();
  const scenarios = filter ? loaded.scenarios.filter((s) => s.name.toLowerCase().includes(filter)) : loaded.scenarios;
  if (!scenarios.length) {
    console.error(filter ? `No scenario name contains "${options.filter}".` : "No scenarios found.");
    return 2;
  }

  const model = resolveModelSettings(
    {
      ...(options.llmBaseUrl ? { llmBaseUrl: options.llmBaseUrl } : {}),
      ...(options.llmApiKey ? { llmApiKey: options.llmApiKey } : {}),
      ...(options.llmModel ? { llmModel: options.llmModel } : {}),
      local: options.local
    },
    env
  );
  if (model.problem) {
    console.error(model.problem);
    return 2;
  }
  const needsModel = scenarios.some(
    (s) => s.kind === "simulated" || s.turns.some((turn) => turn.expect.judge !== undefined)
  );
  if (needsModel && !model.settings) {
    console.error(
      "Warning: some scenarios need a chat model and none is configured; they will fail. Pass --local or set OPENAI_API_KEY."
    );
  }

  const runOptions: RunOptions = {
    relayUrl: options.relay,
    ...(options.token ? { token: options.token } : {}),
    ...(options.tokenUrl ? { tokenUrl: options.tokenUrl } : {}),
    ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
    ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    ...(model.settings
      ? {
          userModel: model.settings,
          judgeModel: options.judgeModel ? { ...model.settings, model: options.judgeModel } : model.settings
        }
      : {}),
    ...(options.verbose ? { log: (line: string) => console.log(`    ${scrub(line)}`) } : {})
  };

  const repeated = options.repeat > 1;
  const results = await runAll(scenarios, runOptions, {
    repeat: options.repeat,
    concurrency: options.concurrency,
    onResult(result) {
      console.log(scrub(formatRunLine(result, repeated)));
      if (!result.pass) for (const line of formatFailure(result)) console.log(scrub(line));
    }
  });

  console.log("");
  const summary = summarize(results);
  for (const line of formatSummary(summary, repeated)) console.log(line);
  if (options.report) {
    const file = path.resolve(options.report);
    fs.writeFileSync(
      file,
      `${JSON.stringify(buildReport(results, { relay: options.relay, repeat: options.repeat }), null, 2)}\n`
    );
    console.log(`Report: ${file}`);
  }
  return summary.allPassed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 2;
    }
  );
}
