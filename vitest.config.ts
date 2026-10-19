import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The screen-stream suites draw on a surface, so they need a DOM; the
    // rest of the package is happy in one.
    environment: "jsdom",
  },
});
