import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/health": {
        target: "http://localhost:8787"
      },
      "/testing": {
        target: "http://localhost:8787"
      },
      "/agent": {
        target: "ws://localhost:8787",
        ws: true
      }
    }
  }
});
