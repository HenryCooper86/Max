// Deterministic, non-secret credentials for the mocked Doubao transport.
// Production never loads this file; Vitest does via vite.config.ts.
process.env.DOUBAO_API_KEY ||= "vitest-doubao-api-key";
