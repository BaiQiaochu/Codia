import { defineConfig } from "vite";
import fs from "fs";
import { builtinModules } from "module";

const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);
const serverEntry = fs.existsSync(new URL("./server/index.ts", import.meta.url))
  ? "server/index.ts"
  : "server/index.js";

export default defineConfig({
  build: {
    lib: {
      entry: serverEntry,
      formats: ["es"],
      fileName: () => "index.js",
    },
    outDir: "dist-server-bundle",
    rollupOptions: {
      external: [
        ...nodeBuiltins,
        "better-sqlite3",

        // ws is CJS and has optional native addons; keep it external.
        "ws",
        "node-pty",
        /^@earendil-works\//,
        "@silvia-odwyer/photon-node",
        "@larksuiteoapi/node-sdk",
        "whatsapp-web.js",
        "mammoth",
        "read-excel-file",
        "fsevents",

        // qrcode must resolve to its Node build at runtime, not the browser build.
        "qrcode",

        // jsdom reads package-local resources through __dirname.
        "jsdom",
      ],
      output: {
        // Keep the server in one file; splitting causes TDZ issues across shared/core/lib/hub.
        codeSplitting: false,
        // Some bundled CJS dependencies still call require("fs") from inside the ESM bundle.
        intro: 'import { createRequire as __gsapCreateRequire } from "node:module"; const require = __gsapCreateRequire(import.meta.url);',
      },
    },
    target: "node24",
    minify: "esbuild",
    sourcemap: false,
  },
  logLevel: "info",
});
