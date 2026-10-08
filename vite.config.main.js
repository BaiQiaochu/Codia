import { defineConfig } from "vite";
import { builtinModules } from "module";

const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

export default defineConfig({
  build: {
    ssr: "desktop/main.cjs",
    // Output to the same directory as source; this preserves __dirname semantics.
    // main.cjs uses __dirname extensively for preload, assets, locales, etc.
    outDir: "desktop",
    emptyOutDir: false,
    rollupOptions: {
      external: [
        "electron",
        ...nodeBuiltins,

        // ws uses optional native addons and should be resolved by Electron at runtime.
        "ws",

      ],
      output: {
        format: "cjs",
        entryFileNames: "main.bundle.cjs",
        codeSplitting: false,
      },
    },
    target: "node24",
    minify: "esbuild",
    sourcemap: false,
  },

  ssr: {
    external: [
      "electron",
      ...nodeBuiltins,
      "ws",
    ],
    noExternal: true,
  },

  // Force Node.js resolution to prevent ws and similar packages from resolving browser stubs.
  resolve: {
    conditions: ["node", "import", "module", "require", "default"],
    mainFields: ["main", "module"],
  },
});
