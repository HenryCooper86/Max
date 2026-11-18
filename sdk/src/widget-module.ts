/**
 * Entry for bundlers: `import "max-voice-agent/widget"` registers the
 * `<voice-agent>` element. Browser only: custom elements do not exist during
 * server-side rendering, so import it from client code.
 */

import { defineVoiceAgentElement } from "./widget.js";

defineVoiceAgentElement();

export { VoiceAgentElement, defineVoiceAgentElement } from "./widget.js";
