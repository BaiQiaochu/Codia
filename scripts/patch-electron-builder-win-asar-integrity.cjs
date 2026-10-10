#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function resolveElectronWinPath() {
  return require.resolve("app-builder-lib/out/electron/electronWin.js", {
    paths: [root],
  });
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}

function retryHelperSource() {
  return `
/** @internal */
async function retryWinAsarIntegrityMutation(executablePath, action) {
    // CODIA_WIN_ASAR_INTEGRITY_RETRY: Windows Defender and indexers can briefly lock the freshly
    // renamed Electron executable before electron-builder writes INTEGRITY.
    const maxAttempts = Number(process.env.CODIA_WIN_ASAR_INTEGRITY_RETRY || 12);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await action();
        }
        catch (error) {
            const message = String((error === null || error === void 0 ? void 0 : error.message) || error || "");
            const code = String((error === null || error === void 0 ? void 0 : error.code) || "");
            const retryable = /^(EBUSY|EPERM|EACCES|UNKNOWN)$/i.test(code)
                || /resource busy|access is denied|unknown error|being used|open .*\\\\.exe/i.test(message);
            if (!retryable || attempt === maxAttempts) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, Math.min(5000, 250 * attempt)));
        }
    }
}
`;
}

function patchElectronWinSource(source) {
  const normalized = normalizeNewlines(source);
  if (
    normalized.includes("retryWinAsarIntegrityMutation")
    && normalized.includes("CODIA_WIN_ASAR_INTEGRITY_RETRY")
  ) {
    return { changed: false, source: normalized };
  }

  const requireMarker = 'const resedit_1 = require("resedit");\n';
  if (!normalized.includes(requireMarker)) {
    throw new Error("Cannot find electronWin.js resedit require marker");
  }

  let patched = normalized.replace(requireMarker, `${requireMarker}${retryHelperSource()}`);

  const functionStart = "async function addWinAsarIntegrity(executablePath, asarIntegrity) {\n";
  const bodyStart = "    const buffer = await (0, promises_1.readFile)(executablePath);\n";
  const writeLine = "    await (0, promises_1.writeFile)(executablePath, Buffer.from(executable.generate()));\n";

  const startIndex = patched.indexOf(functionStart);
  if (startIndex === -1) {
    throw new Error("Cannot find addWinAsarIntegrity function");
  }
  const bodyStartIndex = patched.indexOf(bodyStart, startIndex + functionStart.length);
  if (bodyStartIndex === -1) {
    throw new Error("Cannot find addWinAsarIntegrity body start");
  }
  const writeIndex = patched.indexOf(writeLine, bodyStartIndex);
  if (writeIndex === -1) {
    throw new Error("Cannot find addWinAsarIntegrity writeFile line");
  }

  patched = `${patched.slice(0, bodyStartIndex)}    await retryWinAsarIntegrityMutation(executablePath, async () => {\n${patched.slice(bodyStartIndex, writeIndex + writeLine.length)}    });\n${patched.slice(writeIndex + writeLine.length)}`;

  if (!patched.includes("retryWinAsarIntegrityMutation(executablePath")) {
    throw new Error("electronWin.js patch did not wrap integrity mutation");
  }
  return { changed: true, source: patched };
}

function main() {
  const target = resolveElectronWinPath();
  const before = fs.readFileSync(target, "utf8");
  const result = patchElectronWinSource(before);
  if (!result.changed) {
    console.log(`[patch-electron-builder-win-asar-integrity] already patched: ${target}`);
    return;
  }
  fs.writeFileSync(target, result.source.replace(/\n/g, "\r\n"));
  console.log(`[patch-electron-builder-win-asar-integrity] patched: ${target}`);
}

main();
