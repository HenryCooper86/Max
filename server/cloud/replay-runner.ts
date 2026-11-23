import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { studioToolParameters } from "../../shared/cloud-studio";
import type { ReplayCase, ReplayRun } from "../../shared/studio-replay";
import { projectAssistantProfile } from "../assistant";
import type { Logger } from "../logger";
import { createVoiceProvider } from "../providers/factory";
import type { AgentProvider } from "../providers/types";
import type { ToolDefinition } from "../tools";
import { cloudSessionEnded } from "./booking";
import { cloudSecretKeys, now } from "./context";
import { projectStudio, type Result } from "./customers";
import { admitCloudSession, CLOUD_CHECK_INTERVAL_MS, openCloudSession } from "./live";
import { draftRevisionProject } from "./revisions";
import { decryptModelKey } from "./secrets";
import { allowStudioTestAttempt } from "./sessions";

type Outcome = Result<{ run: ReplayRun }>;
const failure = (status: number, error: string): Outcome => ({ ok: false, status, error });
const stale = () => failure(409, "The draft changed. Refresh and replay the current draft.");
const upstreamFailure = () => failure(502, "The model could not complete this replay.");
const discard = () => {};
// The model and tools may include customer content in their diagnostic fields.
const quiet: Logger = { debug: discard, info: discard, warn: discard, error: discard };
let running = 0;

export async function runDraftReplay(
  customerId: string,
  projectId: string,
  revision: string,
  testCase: ReplayCase,
  signal?: AbortSignal
): Promise<Outcome> {
  const aborted = () => failure(499, "Replay cancelled.");
  if (signal?.aborted) return aborted();
  const row = draftRevisionProject(customerId, projectId, revision);
  if (!row) return stale();
  const apiKey = row.model_key_enc && decryptModelKey(row.model_key_enc, cloudSecretKeys(), projectId);
  if (!apiKey) return failure(409, "Add your model key and save the draft before replaying.");
  if (running >= 32 || !allowStudioTestAttempt(projectId)) return failure(429, "Too many replays. Try again shortly.");
  // A normal test session with no release-proof grant: its usage still counts.
  const grant = { projectId, customerId, keyHash: row.key_hash, source: "test" } as const;
  const refusal = admitCloudSession(grant, "studio-replay");
  if (refusal) return failure(refusal.code === 1013 ? 429 : 403, refusal.message);

  const sessionId = randomUUID();
  const meter = openCloudSession(sessionId, grant, "studio-replay");
  const studio = projectStudio(row);
  const tools: ReplayRun["tools"] = [];
  let provider: AgentProvider | undefined;
  let settled = false;
  let submitted = false;
  let attemptedCalls = 0;
  let resolve!: (result: Outcome) => void;
  const result = new Promise<Outcome>((done) => {
    resolve = done;
  });
  const finish = (outcome: Outcome) => {
    if (settled) return;
    settled = true;
    resolve(outcome);
  };
  const complete = (answer: string, passed: boolean) =>
    finish({
      ok: true,
      value: { run: { revision, caseId: testCase.id, caseVersion: testCase.version, answer, passed, tools } }
    });
  const missing = (name: string) => {
    if (!settled) {
      tools.push({ name: name.slice(0, 64), mocked: false });
      complete("", false);
    }
    return false;
  };
  const current = () => draftRevisionProject(customerId, projectId, revision)?.key_hash === row.key_hash;
  const onAbort = () => finish(aborted());
  const deadline = setTimeout(() => finish(failure(504, "The model did not finish the replay in time.")), 45_000);
  const check = setInterval(() => {
    try {
      const refused = meter.check();
      if (!current()) finish(stale());
      else if (refused) finish(failure(403, refused.message));
    } catch {
      finish(failure(503, "The draft could not be checked."));
    }
  }, CLOUD_CHECK_INTERVAL_MS);
  signal?.addEventListener("abort", onAbort, { once: true });
  running++;
  try {
    const definitions: ToolDefinition[] = studio.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: studioToolParameters(tool),
      handler() {
        if (settled || tools.length >= 32) {
          finish(failure(422, "The replay exceeded its tool call limit."));
          throw new Error("Replay stopped");
        }
        if (!Object.hasOwn(testCase.fixtures, tool.name)) {
          missing(tool.name);
          throw new Error("No simulated response configured");
        }
        tools.push({ name: tool.name, mocked: true });
        return testCase.fixtures[tool.name];
      }
    }));
    // The live provider writes wire frames here. No network client, recorder, or event sink is attached.
    const socket = { readyState: 1, OPEN: 1, bufferedAmount: 0, send: discard, close: () => finish(upstreamFailure()) };
    provider = createVoiceProvider(
      row.backend,
      socket as unknown as WebSocket,
      quiet,
      {
        serverEvent(payload) {
          if (settled) return;
          meter.observe(payload, provider?.upstreamUsable?.());
          const event = payload as { type?: string; state?: string; text?: string };
          if (event.type === "error" || event.state === "degraded" || event.state === "closed")
            finish(upstreamFailure());
          if (event.type === "transcript" && (event.text?.length ?? 0) > 8000)
            finish(failure(422, "The replay answer exceeded its length limit."));
        },
        serverAudio: discard,
        ttsFallback: discard
      },
      {
        apiKey,
        voice: studio.voice || undefined,
        serverTools: () => definitions,
        profile: projectAssistantProfile({
          name: row.assistant_name || "Assistant",
          instructions: row.instructions || undefined,
          greeting: row.greeting || undefined,
          language: studio.language,
          knowledge: studio.knowledge,
          flow: studio.flow
        })
      }
    );
    const active = provider;
    void active
      .start(
        { type: "session.start", sampleRate: 16000, channels: 1 },
        {
          channel: "web",
          sessionId,
          endSession: () => finish(upstreamFailure()),
          allowToolCall(name, kind) {
            if (settled) return false;
            if (++attemptedCalls > 32) {
              finish(failure(422, "The replay exceeded its tool call limit."));
              return false;
            }
            if (kind === "builtin") return true;
            return (kind === "external" && Object.hasOwn(testCase.fixtures, name)) || missing(name);
          },
          onTurnAnswer(answer) {
            if (!submitted || settled) return;
            if (answer.length > 8000) return finish(failure(422, "The replay answer exceeded its length limit."));
            complete(answer, answer.toLowerCase().includes(testCase.expected.toLowerCase()));
          }
        }
      )
      .then(async () => {
        if (settled) return;
        submitted = true;
        if (!active.textInput || (await active.textInput(testCase.prompt)) === false) finish(upstreamFailure());
      })
      .catch(() => finish(upstreamFailure()));
    const outcome = await result;
    return outcome.ok && !current() ? stale() : outcome;
  } catch {
    return upstreamFailure();
  } finally {
    settled = true;
    clearInterval(check);
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
    try {
      await provider?.close();
    } finally {
      running--;
      const endedAt = now();
      cloudSessionEnded({ sessionId, customerId, projectId, seconds: meter.close(endedAt), endedAt });
    }
  }
}
