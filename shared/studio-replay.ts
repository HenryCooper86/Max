import { STUDIO_TOOL_NAME } from "./cloud-studio";

/** A saved regression case contains only the text and simulated tool outputs approved by the owner. */
export type ReplayCaseInput = {
  prompt: string;
  expected: string;
  fixtures: Record<string, unknown>;
};

export type ReplayCase = ReplayCaseInput & { id: string; version: number };

export type ReplayRun = {
  revision: string;
  caseId: string;
  caseVersion: number;
  answer: string;
  passed: boolean;
  tools: { name: string; mocked: boolean }[];
};

export type ReplayCheckOutcome =
  { status: "passed" | "failed"; answer: string; missingTools: string[] } | { status: "error"; message: string };

export type ReplayCheck = Pick<ReplayCase, "id" | "version" | "prompt" | "expected"> & {
  outcome: ReplayCheckOutcome | null;
  stale: boolean;
};

export const REPLAY_LIMITS = { prompt: 4000, expected: 500, fixtures: 10, fixtureBytes: 8000, cases: 50 } as const;

/** Fixture keys are project tool names; avoid special keys when constructing their JSON map. */
export function isReplayToolName(name: string): boolean {
  return STUDIO_TOOL_NAME.test(name) && name !== "constructor" && name !== "prototype";
}
