import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

describe("desktop welcome title contract", () => {
  it("keeps the retired oversized workspace question out of the welcome screen", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "desktop", "src", "react", "components", "WelcomeScreen.tsx"),
      "utf-8",
    );

    expect(source).not.toContain("What should we work on?");
    expect(source).not.toContain("t('welcome.title')");
    expect(source).toContain('className={styles.codiaHero}');
    expect(source).toContain("<FolderPicker");
  });

  it("keeps the main welcome title Chinese in the fallback locale", () => {
    const zh = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "desktop", "src", "locales", "zh.json"),
      "utf-8",
    ));
    const en = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "desktop", "src", "locales", "en.json"),
      "utf-8",
    ));

    expect(en.welcome.title).toBe(zh.welcome.title);
    expect(en.welcome.messages).toEqual(zh.welcome.messages);
    expect(en.welcome.memoryOn).toBe(zh.welcome.memoryOn);
    expect(en.welcome.memoryOff).toBe(zh.welcome.memoryOff);
    expect(en.welcome.title).toMatch(/[\u4e00-\u9fff]/);
  });
});
