// What becomes of a Max Cloud conversation when its session ends: kept in
// the project's history, analysed, sent to the project's own server, or none
// of these.

import { studioAnalysisConfig } from "../../shared/cloud-studio";
import { createLogger } from "../logger";
import { analyseProjectConversation, type ConversationAnalysis } from "./analysis";
import { cloudSecretKeys } from "./context";
import { projectWebhooks } from "./conversation-webhook";
import { saveConversation, type ConversationRecorder } from "./conversations";
import { projectStudio, projectWebhookSecret } from "./customers";
import { decryptModelKey } from "./secrets";
import { liveProject, setConversationAnalysis } from "./store";

const log = createLogger("cloud");

export function cloudConversationEnded(
  input: {
    customerId: string;
    projectId: string;
    source: string;
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

  let waiting: Promise<ConversationAnalysis> | undefined;
  try {
    const project = liveProject(input.projectId, input.customerId);
    const studio = project ? projectStudio(project) : undefined;
    const config = studio ? studioAnalysisConfig(studio) : undefined;
    // Only what somebody said is analysed, and only when the result has somewhere to go.
    const said = turns.some((turn) => turn.speaker === "user");
    if (project && studio && config && said && (savedId || studio.conversationWebhook)) {
      const modelKey = project.model_key_enc
        ? decryptModelKey(project.model_key_enc, cloudSecretKeys(), project.id)
        : undefined;
      waiting =
        modelKey === undefined
          ? Promise.resolve({ at: input.endedAt, error: "not analysed: the project's model key could not be read" })
          : analyse({
              backend: project.backend,
              modelKey,
              config,
              turns,
              ...(studio.language ? { language: studio.language } : {})
            });
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
  // The project's server is sent the conversation once, with its analysis: it waits for it (half a minute at most).
  void waiting
    .catch((error: unknown): ConversationAnalysis => {
      return { at: input.endedAt, error: error instanceof Error ? error.message : "the analysis failed" };
    })
    .then((analysis) => {
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
    });
}
