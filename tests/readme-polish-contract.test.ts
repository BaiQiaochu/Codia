import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

function readRoot(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

describe("G-SAP README polish contract", () => {
  it("keeps the upstream polished documentation structure with G-SAP branding", () => {
    const readme = readRoot("README.md");

    expect(readme).toContain("<h1 align=\"center\">G-SAP</h1>");
    expect(readme).toContain("## G-SAP 是什么");
    expect(readme).toContain("## 功能特性");
    expect(readme).toContain("## 快速开始");
    expect(readme).toContain("## 平台支持");
    expect(readme).toContain("## 开发");
    expect(readme).toContain("## 链接");
    expect(readme).toContain("记忆");
    expect(readme).toContain("多 Agent");
    expect(readme).toContain("插件系统");
    expect(readme).toContain("工作流");
    expect(readme).not.toMatch(/OpenHanako|HanaAgent|\bHanako\b|\bHana\b|liliMozi/i);
  });
});
