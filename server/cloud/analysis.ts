// Analysis of a Max Cloud project's conversations: once one has ended, a chat
// model reads the transcript and writes a summary, a sentiment, a pass or
// fail against the project's own rule, and the fields the project asked for
// (shared/analysis.ts, server/conversation-analysis.ts).
//
// By default the model is the project's own vendor's, called with the
// project's own model key: the same account that pays for the voice pays for
// the few thousand tokens of an analysis. An operator who would rather run
// one model for every project names it with CLOUD_ANALYSIS_LLM_BASE_URL.

import type { AnalysisConfig, AnalysisResult } from "../../shared/analysis";
import type { CloudBackend } from "../../shared/cloud-studio";
import { analyzeConversation, type AnalysisModel } from "../conversation-analysis";
import type { ConversationTurn } from "./conversations";

/** Analyses under way at once. Each holds a transcript and a request for up to half a minute. */
const MAX_AT_ONCE = 24;

/** Each vendor's OpenAI-compatible chat endpoint, and a small model of theirs that does this well. */
const VENDORS: Record<CloudBackend, { baseUrl: string; model: string; setting: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", setting: "CLOUD_ANALYSIS_MODEL_OPENAI" },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.8-flash",
    setting: "CLOUD_ANALYSIS_MODEL_GEMINI"
  },
  grok: { baseUrl: "https://api.x.ai/v1", model: "grok-4.3", setting: "CLOUD_ANALYSIS_MODEL_GROK" }
};

/** What is kept with a conversation, and sent with it: the result, or why there is none. */
export type ConversationAnalysis = { at: number; result?: AnalysisResult; error?: string };

/** The model that analyses a project's conversations. */
export function projectAnalysisModel(
  backend: CloudBackend,
  modelKey: string,
  env: NodeJS.ProcessEnv = process.env
): AnalysisModel {
  const get = (name: string) => env[name]?.trim() || undefined;
  const own = get("CLOUD_ANALYSIS_LLM_BASE_URL");
  if (own) {
    // The operator's own model: it gets the operator's key or none, never a customer's.
    return {
      baseUrl: own.replace(/\/+$/, ""),
      apiKey: get("CLOUD_ANALYSIS_LLM_API_KEY") ?? "",
      model: get("CLOUD_ANALYSIS_LLM_MODEL") ?? VENDORS.openai.model
    };
  }
  const vendor = VENDORS[backend];
  return { baseUrl: vendor.baseUrl, apiKey: modelKey, model: get(vendor.setting) ?? vendor.model };
}

let running = 0;

/**
 * Analyses one conversation. Always resolves: to the result, or to the reason
 * there is none, in words the project's owner can be shown (never the vendor's
 * own text, which may quote the request).
 */
export async function analyseProjectConversation(
  input: {
    backend: CloudBackend;
    modelKey: string;
    config: AnalysisConfig;
    turns: readonly ConversationTurn[];
    language?: string;
  },
  options: { request?: typeof fetch; clock?: () => number; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<ConversationAnalysis> {
  const clock = options.clock ?? Date.now;
  if (running >= MAX_AT_ONCE) return { at: clock(), error: "not analysed: too many analyses were under way" };
  running += 1;
  try {
    const result = await analyzeConversation(
      input.turns,
      input.config,
      projectAnalysisModel(input.backend, input.modelKey, options.env),
      {
        ...(options.request ? { request: options.request } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(input.language ? { language: input.language } : {})
      }
    );
    return { at: clock(), result };
  } catch (error) {
    return { at: clock(), error: error instanceof Error ? error.message : "the analysis failed" };
  } finally {
    running -= 1;
  }
}
