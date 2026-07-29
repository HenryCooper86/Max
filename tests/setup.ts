// Deterministic, non-secret credentials for the mocked Doubao transport.
// Production never loads this file; Vitest does via vite.config.ts.
process.env.DOUBAO_API_KEY ||= "vitest-doubao-api-key";

// Same reasoning for the vision (Ark) credential: server/providers/doubao.ts
// builds its describeFrame() describer once, at module scope, from these vars
// at import time. Without a key/model configured here, describeFrame always
// takes its "not configured" short-circuit and never calls fetch — which
// would make any test that exercises the real camera.frame path (mocking
// fetch instead) trivially pass regardless of whether the code under test
// actually avoids blocking on it.
process.env.ARK_API_KEY ||= "vitest-ark-api-key";
process.env.ARK_MODEL ||= "vitest-ark-vision-model";
