import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the "@/*" -> "./src/*" path alias configured in
      // tsconfig.json, so tests can import application modules the same
      // way the Next.js app and worker process do.
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/workers/**/*.ts", "src/lib/**/*.ts"],
    },
  },
});
