// A Max Cloud project's flow: the relay's agents and handoffs
// (docs/conversations.md), with the project's own tools as the only tools.

import type { ProjectStudio } from "../../shared/cloud-studio";
import { checkFlow } from "../flow";

/** The names the conversation uses for its own tools: a project tool by one of them would take its place. */
const OWN_TOOLS = ["transfer_to_agent", "end_session"];

/**
 * A project's flow as it is saved: checked by the rules of the relay's own
 * flows, and naming only tools the project has. Returns the steps to store
 * (none when the flow is the start alone with nothing written in it), or what
 * is wrong in words for the person editing it.
 */
export function checkedProjectFlow(
  studio: Pick<ProjectStudio, "flow" | "tools">
): { flow: Record<string, unknown>[] } | { error: string } {
  if (studio.flow.length === 0) return { flow: [] };
  const checked = checkFlow(studio.flow);
  if ("problems" in checked) return { error: checked.problems.slice(0, 5).join(" ") };
  const agents = checked.agents ?? [];
  if (agents.length === 0) return { flow: [] };
  const taken = studio.tools.find((tool) => OWN_TOOLS.includes(tool.name));
  if (taken) {
    return {
      error: `A project with a flow cannot have a tool called ${taken.name}: the conversation has one of its own.`
    };
  }
  // What a step does by rule is done by the relay, so it must be a tool the relay runs: one of the project's.
  // A step's own list may also name a tool the app declares when it connects, which is not known here.
  const known = new Set(studio.tools.map((tool) => tool.name));
  for (const agent of agents) {
    for (const [entry, when] of [
      [agent.onStart, "when a conversation starts"],
      [agent.onEnter, "when the conversation is handed to it"]
    ] as const) {
      const tool = entry?.call?.tool;
      if (tool && !known.has(tool)) {
        return {
          error: `${agent.id}: ${when} it calls ${tool}, and this project has no tool by that name. Add it under Tools and save, or take the call out of the step.`
        };
      }
    }
  }
  return { flow: agents as unknown as Record<string, unknown>[] };
}
