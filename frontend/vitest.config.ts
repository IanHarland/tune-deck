import { defineConfig } from "vitest/config";

// Tests target src/core/ — the portable, framework-free layer that a future
// Expo app reuses verbatim (see CLAUDE.md). Keeping the suite pointed there is
// deliberate: it's where the business logic lives, and it's the code that has
// to survive the UI being rewritten.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
