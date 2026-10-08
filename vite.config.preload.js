import { defineConfig } from "vite";

// Electron sandboxed preload can only require Electron/built-in modules at
// runtime. Bundle our preload and inline local helpers so window.platform is
// always exposed in main/settings/splash windows.
export default defineConfig({
  build: {
    lib: {
      entry: "desktop/preload.cjs",
      formats: ["cjs"],
      fileName: () => "preload.bundle.cjs",
    },
    outDir: "desktop",
    emptyOutDir: false,
    rollupOptions: {
      external: ["electron"],
    },
    target: "node24",
    minify: "esbuild",
    sourcemap: false,
  },
  resolve: {
    conditions: ["node", "import", "module", "require", "default"],
    mainFields: ["main", "module"],
  },
});
