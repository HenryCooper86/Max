// What becomes of a Max Cloud conversation when its session ends: kept in
// the project's history, sent to the project's own server, both or neither.

import { createLogger } from "../logger";
import { projectWebhooks } from "./conversation-webhook";
import { saveConversation, type ConversationRecorder } from "./conversations";
import { projectStudio, projectWebhookSecret } from "./customers";
import { liveProject } from "./store";

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
  webhooks: Pick<typeof projectWebhooks, "ended"> = projectWebhooks
): void {
  // Each on its own: a history that cannot be written does not hold the webhook back, nor the other way round.
  if (input.keep) {
    try {
      saveConversation({
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
      turns: input.recorder.turns()
    });
  } catch (error) {
    log.warn("conversation could not be sent to the project's server", {
      projectId: input.projectId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
