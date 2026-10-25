import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLEARANCE_AI: "" },
  },
});
