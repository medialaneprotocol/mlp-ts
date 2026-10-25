import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Nothing in this package draws: the media class is opaque, so the
    // suites are about the transport's own rules and run in a plain node.
    environment: "node",
    // The budget suites measure real time per operation; a second worker
    // running beside them steals the very thing they assert on. Files run
    // one at a time so a measurement means what it says.
    fileParallelism: false,
  },
});
