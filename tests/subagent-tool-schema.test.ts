import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadSubagentDef(locale) {
  const filePath = resolve(ROOT, "desktop", "src", "locales", `${locale}.json`);
  return JSON.parse(readFileSync(filePath, "utf8")).toolDef.subagent;
}

describe("subagent tool schema copy", () => {
  it("keeps zh/en descriptions concise", () => {
    const zh = loadSubagentDef("zh");
    const en = loadSubagentDef("en");

    expect(zh.description.length).toBeLessThan(180);
    expect(en.description.length).toBeLessThan(280);
  });

  it("does not duplicate generic background task polling rules", () => {
    for (const locale of ["zh", "zh-TW", "en"]) {
      const def = loadSubagentDef(locale);
      expect(def.description).not.toContain("check_pending_tasks");
      expect(def.description).not.toContain("最多查");
      expect(def.description).not.toContain("Check at most");
      expect(def.description).not.toContain("<hana-background-result>");
    }
  });

  it("uses current thread/id semantics for zh/en", () => {
    for (const locale of ["zh", "zh-TW", "en"]) {
      const def = loadSubagentDef(locale);
      expect(def.agentDesc).toMatch(/反引号|反引號|backticks/);
      expect(def.agentDesc).toMatch(/人格|persona/);
      expect(def.agentDesc).toMatch(/模型|model/);
      expect(def.agentDesc).not.toMatch(/括号|parentheses/);
      expect(def.labelDesc).toMatch(/展示|顯示|display/);
      expect(def.labelDesc).toMatch(/threadId|subagent_reply/);
      expect(def.instanceDesc).toMatch(/旧字段|舊欄位|[Ll]egacy/);
      expect(def.instanceDesc).not.toMatch(/临时线程|臨時執行緒|ephemeral thread|不留记忆|no memory/);
      expect(def.modelDesc).toMatch(/聊天模型|chat model/);
      expect(def.modelDesc).not.toMatch(/utility/);
    }
  });
});
