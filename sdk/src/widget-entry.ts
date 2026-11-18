/**
 * Entry for the standalone script build (`voice-agent.iife.js`). Registers the
 * `<voice-agent>` element, auto-mounts from the loading script's `data-*`
 * attributes, and exposes everything as `window.VoiceAgentKit`.
 */

import { defineVoiceAgentElement, mountFromScript } from "./widget.js";

const loader = typeof document === "undefined" ? null : (document.currentScript as HTMLScriptElement | null);

defineVoiceAgentElement();
mountFromScript(loader);

export * from "./index.js";
export { VoiceAgentElement, defineVoiceAgentElement, mountFromScript } from "./widget.js";
