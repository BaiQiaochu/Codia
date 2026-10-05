import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf-8");
}

describe("preview editor status contract", () => {
  it("reports markdown editor selection and total character counts", () => {
    const editor = read("desktop/src/react/components/PreviewEditor.tsx");
    const panel = read("desktop/src/react/components/PreviewPanel.tsx");
    const css = read("desktop/src/react/components/Preview.module.css");

    expect(editor).toContain("export interface ArtifactEditorStats");
    expect(editor).toContain("onStatsChange?:");
    expect(editor).toContain("getEditorStats");
    expect(panel).toContain("markdownEditorStatus");
    expect(panel).toContain("onStatsChange={handleEditorStatsChange}");
    expect(css).toContain(".markdownEditorStatus");
  });

  it("ships localized markdown editor status text", () => {
    const expectations = [
      ["desktop/src/locales/en.json", "选中 {selected} 字"],
      ["desktop/src/locales/zh.json", "选中 {selected} 字"],
      ["desktop/src/locales/zh-TW.json", "選中 {selected} 字"],
      ["desktop/src/locales/ja.json", "選択 {selected} 文字"],
      ["desktop/src/locales/ko.json", "선택 {selected}자"],
    ];

    for (const [relPath, text] of expectations) {
      const locale = read(relPath);
      expect(locale).toContain('"preview.markdownEditorStatus"');
      expect(locale).toContain(text);
    }
  });
});
