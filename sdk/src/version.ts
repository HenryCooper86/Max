/** This package's version, as published. A test keeps it equal to `sdk/package.json`. */
export const SDK_VERSION = "0.2.1";

/**
 * The wire protocol this SDK speaks. It changes only for a change that is not
 * backwards compatible, and a test keeps it equal to the relay's own
 * (`PROTOCOL_VERSION` in `shared/agent.ts`).
 */
export const PROTOCOL_VERSION = 1;
