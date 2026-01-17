import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["app/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    exclude: ["node_modules", "build", ".react-router"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["app/services/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.test.tsx"],
    },
  },
});
