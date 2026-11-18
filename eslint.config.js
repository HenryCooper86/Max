import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "android/**/build/**", "ios/build/**", "public/pcm-worklet.js", ".venv/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node.js scripts (examples). No `globals` dependency: list what they use.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        fetch: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly"
      }
    }
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  }
);
