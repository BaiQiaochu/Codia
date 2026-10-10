import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, "skills2set");

describe("preset skills contract", () => {
  it("matches the restored codia preset skill set after debranding", () => {
    const names = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(names).toEqual(expect.arrayContaining([
      "codia-plugin-creator",
      "office-documents",
      "quiet-musing",
      "skill-creator",
      "user-guide",
    ]));
    expect(names).toContain("codia-plugin-creator");
    expect(fs.existsSync(path.join(SKILLS_DIR, "codia-plugin-creator", "scripts", "create_codia_plugin.py"))).toBe(true);
    expect(fs.existsSync(path.join(SKILLS_DIR, "codia-plugin-creator", "scripts", "create_codia_plugin.py"))).toBe(true);
  });
});
