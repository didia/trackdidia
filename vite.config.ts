import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    globals: true,
    css: true,
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    // Local-first calendar semantics; keep CI and laptops on the same wall clock.
    env: {
      TZ: "America/Toronto",
    },
    alias: {
      "@tauri-apps/plugin-opener": fileURLToPath(
        new URL("./src/test/mocks/tauri-plugin-opener.ts", import.meta.url),
      ),
    },
  },
});
