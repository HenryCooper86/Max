// The package ships no types. This is the part of its synchronous build that
// server/noise-suppression.ts uses.
declare module "@jitsi/rnnoise-wasm/dist/rnnoise-sync.js" {
  const createRNNWasmModuleSync: () => {
    ready?: Promise<unknown>;
    HEAPF32: Float32Array;
    _malloc(bytes: number): number;
    _free(pointer: number): void;
    _rnnoise_create(): number;
    _rnnoise_destroy(state: number): void;
    _rnnoise_process_frame(state: number, output: number, input: number): number;
  };
  export default createRNNWasmModuleSync;
}
