import { defineConfig } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Build the shared theme bootstrap after the renderer build.
// vite.config.ts copies desktop/src/lib into dist-renderer/lib; this bundle
// then overwrites the legacy theme.js with the TypeScript implementation.
export default defineConfig({
  build: {
    outDir: "desktop/dist-renderer/lib",
    emptyOutDir: false,
    minify: true,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, "desktop/src/shared/theme.ts"),
      formats: ["iife"],
      name: "CodiaTheme",
      fileName: () => "theme.js",
    },
    rollupOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
});
