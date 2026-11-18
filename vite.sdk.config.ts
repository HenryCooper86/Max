import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const entry = (file: string) => fileURLToPath(new URL(`./sdk/src/${file}`, import.meta.url));

/**
 * Builds the embeddable SDK into `dist/sdk/`, beside (never over) the app build.
 *
 * Two passes, selected by Vite's mode:
 * - default: ESM modules `voice-agent.js`, `react.js` and `widget.js` (React stays external).
 * - `iife`: the one-file script `voice-agent.iife.js` exposing `window.VoiceAgentKit`.
 */
export default defineConfig(({ mode }) => {
  const iife = mode === "iife";
  return {
    publicDir: false,
    build: {
      outDir: "dist/sdk",
      // The app build owns dist/, and the two SDK passes share dist/sdk.
      emptyOutDir: false,
      target: "es2022",
      minify: true,
      sourcemap: true,
      lib: iife
        ? {
            entry: entry("widget-entry.ts"),
            name: "VoiceAgentKit",
            formats: ["iife" as const],
            fileName: () => "voice-agent.iife.js"
          }
        : {
            entry: { "voice-agent": entry("index.ts"), react: entry("react.ts"), widget: entry("widget-module.ts") },
            formats: ["es" as const],
            fileName: (_format: string, name: string) => `${name}.js`
          },
      rollupOptions: iife
        ? {}
        : {
            external: ["react", "react/jsx-runtime"],
            // voice-agent.js and react.js share one core chunk; a stable name keeps stale hashes out of dist/sdk.
            output: { chunkFileNames: "core.js" }
          }
    }
  };
});
