import { createContext, useContext } from "react";
import { DEFAULT_ASSISTANT, type AssistantIdentity } from "../lib/assistant";

const AssistantContext = createContext<AssistantIdentity>(DEFAULT_ASSISTANT);

/** Supplies the relay-configured assistant identity to every surface. */
export const AssistantProvider = AssistantContext.Provider;

/** The configured assistant, or the built-in Max helmet assistant when no
 *  provider is mounted (old relays, isolated component tests). */
export function useAssistant(): AssistantIdentity {
  return useContext(AssistantContext);
}
