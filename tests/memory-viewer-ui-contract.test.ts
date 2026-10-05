import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf-8");
}

describe("memory viewer UI contract", () => {
  it("keeps the memory viewer within the visible viewport and scrolls the body", () => {
    const css = read("desktop/src/react/settings/Settings.module.css");

    expect(css).toContain("max-height: min(70vh, calc(100dvh - var(--space-xl) - var(--space-xl)))");
    expect(css).toContain("overflow: hidden");
    expect(css).toContain("min-height: 0");
    expect(css).toContain("overscroll-behavior: contain");
  });

  it("renders Mermaid diagrams in compiled memory markdown", () => {
    const source = read("desktop/src/react/settings/overlays/CompiledMemoryViewer.tsx");

    expect(source).toContain("useMermaidDiagrams");
    expect(source).toContain("ref={contentRef}");
    expect(source).toContain("[content, loading]");
  });
});
