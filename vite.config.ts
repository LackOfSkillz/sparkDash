import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    // Allow HMR when opened via LAN IP / Docker
    watch: {
      usePolling: process.env.CHOKIDAR_USEPOLLING === "1",
      // Nothing here is application source, and watching it is actively harmful. Audit
      // artifacts and captured telemetry are written INTO the repo while the dev server is
      // running, and any change under the watch root triggers a full page reload. Worse, if a
      // dev-server log lands in here the loop self-sustains: reload -> Vite logs the reload ->
      // that write is another watched change -> reload. Observed as the dashboard flashing
      // back to "No Sparks registered" about once a second.
      ignored: [
        "**/baseline-audit/**",
        "**/*.log",
        "**/*.jsonl",
        "**/config/sparks.json",
      ],
    },
    proxy: {
      "/api": "http://127.0.0.1:5555",
      "/ws": {
        target: "ws://127.0.0.1:5555",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});