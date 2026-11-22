// The compiled libopus module inside the `opusscript` package. It ships no
// types; server/webrtc/opus.ts describes the part it uses.
declare module "opusscript/build/opusscript_native_wasm.js" {
  const createModule: () => unknown;
  export default createModule;
}
