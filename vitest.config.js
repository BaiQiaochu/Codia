import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { defineConfig } from "vitest/config";

const cwd = process.cwd();
const realCwd = fs.realpathSync(cwd);

export default defineConfig({
  resolve: {
    preserveSymlinks: true,
    alias: {
      "@codia/plugin-components": path.resolve(cwd, "packages/plugin-components/src/index.ts"),
      "@codia/plugin-protocol": path.resolve(cwd, "packages/plugin-protocol/src/index.ts"),
      "@codia/plugin-runtime": path.resolve(cwd, "packages/plugin-runtime/src/index.ts"),
      "@codia/plugin-sdk": path.resolve(cwd, "packages/plugin-sdk/src/index.ts"),
      "@codia/plugin-components": path.resolve(cwd, "packages/plugin-components/src/index.ts"),
      "@codia/plugin-protocol": path.resolve(cwd, "packages/plugin-protocol/src/index.ts"),
      "@codia/plugin-runtime": path.resolve(cwd, "packages/plugin-runtime/src/index.ts"),
      "@codia/plugin-sdk": path.resolve(cwd, "packages/plugin-sdk/src/index.ts"),
    },
  },
  server: {
    fs: {
      allow: [cwd, realCwd],
    },
  },
  test: {
    root: ".",
    testTimeout: 10_000,
    include: [
      "tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "plugins/**/tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "desktop/src/react/**/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "desktop/src/react/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-server/**",
      "**/dist-renderer/**",
      "**/dist-server-bundle/**",
      "**/dist-folder/**",
      "**/coverage/**",
      "**/codia-0.*/**",
      "**/codia-main1.6/**",
      "**/hermes-agent-main/**",
    ],
    server: {
      deps: {
        inline: ["electron-updater", /desktop\/auto-updater/],
      },
    },
  },
});
