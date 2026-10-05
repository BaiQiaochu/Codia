import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { describe, expect, it } from "vitest";
import { parseSkillMetadata } from "../lib/skills/skill-metadata.js";

const ORIGINAL_BUNDLED_SKILL_MAP = {
  "hana-plugin-creator": "gsap-plugin-creator",
  "office-documents": "office-documents",
  "quiet-musing": "quiet-musing",
  "skill-creator": "skill-creator",
  "user-guide": "user-guide",
};

const REQUIRED_BUNDLED_SKILLS = [
  "codex-cli-multiturn-tools",
  "gsap-plugin-creator",
  "office-documents",
  "quiet-musing",
  "research-platform",
  "skill-creator",
  "user-guide",
];

const PLUGIN_BUNDLED_SKILLS = [
  path.join("plugins", "image-gen", "skills", "image-gen-guide", "SKILL.md"),
];

describe("bundled skills", () => {
  it("ships the expected first-run skills with valid metadata", () => {
    const skillsRoot = path.join(process.cwd(), "skills2set");

    for (const skillName of REQUIRED_BUNDLED_SKILLS) {
      const skillFile = path.join(skillsRoot, skillName, "SKILL.md");
      expect(fs.existsSync(skillFile), `${skillName} SKILL.md`).toBe(true);

      const meta = parseSkillMetadata(fs.readFileSync(skillFile, "utf-8"), skillName);
      expect(meta.name).toBe(skillName);
      expect(meta.description, `${skillName} description`).toEqual(expect.any(String));
      expect(meta.description.trim().length, `${skillName} description length`).toBeGreaterThan(20);
      expect(meta.displayName, `${skillName} display name`).not.toBe(skillName);
      expect(meta.displayNames["zh-CN"], `${skillName} Chinese display name`).toEqual(expect.any(String));
      expect((meta.displayNames as Record<string, string>).en, `${skillName} English display name`).toEqual(expect.any(String));
      expect(meta.shortDescription.length, `${skillName} short description`).toBeGreaterThan(0);
    }
  });

  it("keeps the plugin creator debranded in the bundled namespace", () => {
    const skillsRoot = path.join(process.cwd(), "skills2set");

    expect(fs.existsSync(path.join(skillsRoot, "hana-plugin-creator"))).toBe(false);
    expect(fs.existsSync(path.join(skillsRoot, "gsap-plugin-creator", "SKILL.md"))).toBe(true);
  });

  it("contains every original bundled skill under the debranded names", () => {
    const skillsRoot = path.join(process.cwd(), "skills2set");
    const currentSkillNames = new Set(
      fs.readdirSync(skillsRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name),
    );

    expect([...currentSkillNames].sort()).toEqual(expect.arrayContaining(
      Object.values(ORIGINAL_BUNDLED_SKILL_MAP),
    ));
    expect(currentSkillNames.has("hana-plugin-creator")).toBe(false);
  });

  it("keeps bundled skill text free of legacy product branding", () => {
    const skillsRoot = path.join(process.cwd(), "skills2set");
    const legacyBrandPattern = /OpenHanako|openhanako|Hanako|hanako|Project Hana|project-hana|OH-Plugins|\bHana\b/;
    const offenders = [];
    const stack = [skillsRoot];

    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!/\.(?:md|yaml|yml|json|txt|py|js|ts|tsx|css|html)$/i.test(entry.name)) continue;
        const text = fs.readFileSync(fullPath, "utf-8");
        if (legacyBrandPattern.test(text)) {
          offenders.push(path.relative(skillsRoot, fullPath));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the synced original user guide feature coverage after debranding", () => {
    const userGuide = fs.readFileSync(
      path.join(process.cwd(), "skills2set", "user-guide", "SKILL.md"),
      "utf-8",
    );

    expect(userGuide).toContain("### 访问模式");
    expect(userGuide).toContain("### 远程接管桌面会话");
    expect(userGuide).toContain("### 图片和视频生成");
    expect(userGuide).toContain("### 电脑控制（实验性）");
    expect(userGuide).toContain("外部兼容技能");
    expect(userGuide).not.toMatch(/HanaAgent|Hanako|OpenHanako|Project Hana/);
  });

  it("ships plugin bundled skills with valid metadata", () => {
    for (const relativePath of PLUGIN_BUNDLED_SKILLS) {
      const skillFile = path.join(process.cwd(), relativePath);
      expect(fs.existsSync(skillFile), `${relativePath} exists`).toBe(true);

      const fallbackName = path.basename(path.dirname(skillFile));
      const meta = parseSkillMetadata(fs.readFileSync(skillFile, "utf-8"), fallbackName);
      expect(meta.name).toBe(fallbackName);
      expect(meta.description.trim().length).toBeGreaterThan(20);
    }
  });

  it("keeps the image generation skill synced with original lifecycle guidance and current parameters", () => {
    const guide = fs.readFileSync(
      path.join(process.cwd(), "plugins", "image-gen", "skills", "image-gen-guide", "SKILL.md"),
      "utf-8",
    );

    expect(guide).toContain("SessionFile");
    expect(guide).toContain("stage_files");
    expect(guide).toContain("<gsap-background-result>");
    expect(guide).toContain("`count`: concurrent generation count (1-4)");
    expect(guide).toContain("`images`: an ordered array of reference image paths");
    expect(guide).toContain("media Provider Registry");
    expect(guide).toContain("CLI wrapper");
    expect(guide).not.toMatch(/Hana Provider Registry|<hana-background-result>|HanaAgent|OpenHanako/);
  });

  it("keeps the original stronger plugin creator capability set under debranded names", () => {
    const skillText = fs.readFileSync(
      path.join(process.cwd(), "skills2set", "gsap-plugin-creator", "SKILL.md"),
      "utf-8",
    );
    const scriptText = fs.readFileSync(
      path.join(process.cwd(), "skills2set", "gsap-plugin-creator", "scripts", "create_gsap_plugin.py"),
      "utf-8",
    );

    expect(skillText).toContain("Provider contribution starter");
    expect(skillText).toContain("Plugin Dev Loop");
    expect(skillText).toContain("Marketplace Rules");
    expect(skillText).toContain("CLI-backed providers");
    expect(skillText).not.toMatch(/HanaAgent|Project Hana|Hana plugins|Hana plugin/);

    expect(scriptText).toContain('choices=["tool", "ui", "full", "provider"]');
    expect(scriptText).toContain("--dev-scenario");
    expect(scriptText).toContain("def create_provider_contribution");
    expect(scriptText).toContain('chat: {{ projection: "none" }}');
    expect(scriptText).toContain("choose_scaffold_template");
    expect(scriptText).toContain("@g-sap/plugin-runtime");
    expect(scriptText).toContain("@g-sap/plugin-sdk");
    expect(scriptText).toContain("@g-sap/plugin-components");
    expect(scriptText).toContain('const PROTOCOL = "gsap.plugin.ui"');
    expect(scriptText).toContain('ready: () => event("gsap.ready")');
    expect(scriptText).toContain("GsapThemeProvider");
    expect(scriptText).toContain("GSAP_BUS_SKIP");
    expect(scriptText).not.toContain("create_hana_plugin.py");
    expect(scriptText).not.toMatch(/@hana|hana\.plugin\.ui|hana\.ready|HanaThemeProvider|data-hana-|hana-css|hana-theme|HANA_BUS_SKIP/);
  });

  it("enables the document and Codex CLI context skills in the default agent template", () => {
    const configPath = path.join(process.cwd(), "lib", "config.example.yaml");
    const config = YAML.load(fs.readFileSync(configPath, "utf-8"));

    expect(config?.skills?.enabled).toEqual(expect.arrayContaining([
      "skill-creator",
      "office-documents",
      "codex-cli-multiturn-tools",
    ]));
  });
});
