// Deterministic, non-secret credentials for the mocked Doubao transport.
// Production never loads this file; Vitest does via vite.config.ts.
process.env.DOUBAO_API_KEY ||= "vitest-doubao-api-key";

// Same reasoning for the vision (Ark) credential: server/providers/doubao.ts
// builds its visionProvider once, at module scope, via
// selectVisionProvider({ ... }) at import time, which picks the real Ark
// provider only when both apiKey and model are present — otherwise it falls
// back to the mock provider, whose describe() never calls fetch. Without a
// key/model configured here, every session would silently get the mock
// provider, which would make any test that exercises the real
// camera.frame/vision.frames path (mocking fetch, or selectVisionProvider's
// return, instead) trivially pass regardless of whether the code under test
// actually avoids blocking on it.
process.env.ARK_API_KEY ||= "vitest-ark-api-key";
process.env.ARK_MODEL ||= "vitest-ark-vision-model";
