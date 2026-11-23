// What becomes of a Max Cloud conversation when its session ends: kept in
// the project's history, analysed, sent to the project's own server, or none
// of these.

import { studioAnalysisConfig } from "../../shared/cloud-studio";
import { createLogger } from "../logger";
import { analyseProjectConversation, analysisUsesProjectKey, type ConversationAnalysis } from "./analysis";
import { cloudSecretKeys } from "./context";
import { projectWebhooks } from "./conversation-webhook";
import { saveConversation, type ConversationRecorder } from "./conversations";
import { projectStudio, projectWebhookSecret } from "./customers";
import { decryptModelKey } from "./secrets";
import { liveProject, setConversationAnalysis } from "./store";

const log = createLogger("cloud");

/** A conversation whose analysis is under way: it is still owed its result in the history and its webhook. */
type Analysing = { done: Promise<void>; stop(): void };
const analysing = new Set<Analysing>();

export function cloudConversationEnded(
  input: {
    customerId: string;
    projectId: string;
    source: string;
    testRevision?: string;
    sessionId: string;
    seconds: number;
    endedAt: number;
    /** The project kept transcripts when the session started. */
    keep: boolean;
    recorder: ConversationRecorder;
  },
  webhooks: Pick<typeof projectWebhooks, "ended"> = projectWebhooks,
  analyse: typeof analyseProjectConversation = analyseProjectConversation
): void {
  if (input.source === "test" && input.testRevision !== undefined) return;
  // Each on its own: a history that cannot be written does not hold the webhook back, nor the other way round.
  let savedId: string | undefined;
  if (input.keep) {
    try {
      savedId = saveConversation({
        customerId: input.customerId,
        projectId: input.projectId,
        source: input.source,
        seconds: input.seconds,
        recorder: input.recorder
      });
    } catch (error) {
      log.warn("conversation could not be saved", {
        projectId: input.projectId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const turns = input.recorder.turns();

  /** Sends the conversation to the project's server, with what the analysis made of it when there is one. */
  const send = (analysis?: ConversationAnalysis): void => {
    try {
      // The project as it is now: an address changed or taken away while this conversation ran is the one that
      // counts, and a project that was deleted has none.
      const project = liveProject(input.projectId, input.customerId);
      const url = project ? projectStudio(project).conversationWebhook : "";
      if (!project || !url) return;
      webhooks.ended({
        projectId: project.id,
        url,
        secret: projectWebhookSecret(project),
        backend: project.backend,
        source: input.source,
        sessionId: input.sessionId,
        startedAt: input.recorder.startedAt,
        endedAt: input.endedAt,
        seconds: input.seconds,
        turns,
        ...(analysis?.result ? { analysis: analysis.result } : {}),
        ...(analysis?.error ? { analysisError: analysis.error } : {})
      });
    } catch (error) {
      log.warn("conversation could not be sent to the project's server", {
        projectId: input.projectId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  };

  // Kept, and owed to the project's server, whatever becomes of the analysis: `finish` runs once.
  let finished = false;
  const finish = (analysis: ConversationAnalysis): void => {
    if (finished) return;
    finished = true;
    analysing.delete(entry);
    if (analysis.error)
      log.warn("a conversation was not analysed", { projectId: input.projectId, why: analysis.error });
    if (savedId) {
      try {
        setConversationAnalysis(savedId, input.customerId, JSON.stringify(analysis));
      } catch (error) {
        log.warn("a conversation's analysis could not be saved", {
          projectId: input.projectId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    send(analysis);
  };
  const stopper = new AbortController();
  const entry: Analysing = {
    done: Promise.resolve(),
    stop() {
      stopper.abort();
      finish({ at: input.endedAt, error: "not analysed: the relay was stopping" });
    }
  };

  let waiting: Promise<ConversationAnalysis> | undefined;
  try {
    const project = liveProject(input.projectId, input.customerId);
    const studio = project ? projectStudio(project) : undefined;
    const config = studio ? studioAnalysisConfig(studio) : undefined;
    // Only what somebody said is analysed, and only when the result has somewhere to go.
    const said = turns.some((turn) => turn.speaker === "user");
    if (project && studio && config && said && (savedId || studio.conversationWebhook)) {
      // The project's own key is read only when it is the one that will be used.
      const ownKey = analysisUsesProjectKey();
      const modelKey = !ownKey
        ? ""
        : project.model_key_enc
          ? decryptModelKey(project.model_key_enc, cloudSecretKeys(), project.id)
          : null;
      waiting =
        modelKey === null
          ? Promise.resolve({ at: input.endedAt, error: "not analysed: the project has no model key" })
          : modelKey === undefined
            ? Promise.resolve({ at: input.endedAt, error: "not analysed: the project's model key could not be read" })
            : analyse(
                {
                  projectId: project.id,
                  backend: project.backend,
                  modelKey,
                  config,
                  turns,
                  ...(studio.language ? { language: studio.language } : {})
                },
                { signal: stopper.signal }
              );
    }
  } catch (error) {
    log.warn("a conversation's analysis could not be started", {
      projectId: input.projectId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
  if (!waiting) {
    send();
    return;
  }
  // The project's server is sent the conversation once, with its analysis: it waits for it (half a minute at
  // most, and no longer than the relay runs).
  analysing.add(entry);
  entry.done = waiting
    .catch((error: unknown): ConversationAnalysis => {
      return { at: input.endedAt, error: error instanceof Error ? error.message : "the analysis failed" };
    })
    .then(finish);
}

/**
 * For a relay that is stopping: analyses under way get this long to finish, and the conversations still waiting
 * then are kept and sent without one, with the reason. The deliveries themselves are `projectWebhooks.drain`'s.
 */
export async function settleConversationAnalyses(timeoutMs: number): Promise<void> {
  if (analysing.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled([...analysing].map((entry) => entry.done)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    })
  ]);
  if (timer) clearTimeout(timer);
  for (const entry of [...analysing]) entry.stop();
}
