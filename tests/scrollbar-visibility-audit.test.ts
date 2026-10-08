import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const CHECKED_DIRS = [
  "desktop/src/react/components",
  "desktop/src/react/settings",
];

function listCssFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listCssFiles(full);
    return entry.isFile() && entry.name.endsWith(".css") ? [full] : [];
  });
}

function findHiddenScrollbarRules(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const text = fs.readFileSync(file, "utf-8");
  const lines = text.split(/\r?\n/);
  const offenders = lines
    .map((line, index) => ({ rel, line: index + 1, text: line }))
    .filter(({ text }) => /scrollbar-width:\s*none/.test(text));

  const hiddenWebkitScrollbar = /::[-\w]*scrollbar[^{}]*\{[^{}]*display:\s*none\s*;/g;
  for (const match of text.matchAll(hiddenWebkitScrollbar)) {
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    offenders.push({ rel, line, text: match[0].replace(/\s+/g, " ").trim() });
  }

  return offenders;
}

describe("scrollbar visibility audit", () => {
  it("does not hide scrollbars in component or settings CSS", () => {
    const offenders = CHECKED_DIRS
      .flatMap((dir) => listCssFiles(path.join(ROOT, dir)))
      .flatMap(findHiddenScrollbarRules);

    expect(offenders).toEqual([]);
  });
});
