import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FONTS_CSS_FILENAME,
  GSAP_PDF_FONT_FAMILIES,
  buildFontInjectionCss,
  locateThemesDir,
} from "../desktop/src/office-pdf-fonts.cjs";

const SAMPLE_CSS = `@font-face {
  font-family: 'EB Garamond';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('./fonts/ebgaramond-aaa.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+2000-206F;
}
@font-face {
  font-family: 'Noto Serif SC';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('./fonts/notoserifsc-bbb.woff2') format('woff2');
  unicode-range: U+4E00-9FFF;
}
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('./fonts/jetbrainsmono-ccc.woff2') format('woff2');
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 300;
  src: url('./fonts/inter-ddd.woff2') format('woff2');
}`;

describe("office pdf font injection css", () => {
  let tempDir: string;
  let themesDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-pdf-fonts-"));
    themesDir = path.join(tempDir, "themes");
    fs.mkdirSync(path.join(themesDir, "fonts"), { recursive: true });
    fs.writeFileSync(path.join(themesDir, FONTS_CSS_FILENAME), SAMPLE_CSS, "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps only the G-SAP PDF font families and rewrites relative urls", async () => {
    const fontModule = await import("../desktop/src/office-pdf-fonts.cjs");
    const css = buildFontInjectionCss({ themesDir });
    const fontsDirUrl = pathToFileURL(path.join(themesDir, "fonts")).href;

    expect(GSAP_PDF_FONT_FAMILIES).toEqual(["EB Garamond", "Noto Serif SC", "JetBrains Mono"]);
    expect(fontModule).not.toHaveProperty("HANA_PDF_FONT_FAMILIES");
    expect(css).toContain("'EB Garamond'");
    expect(css).toContain("'Noto Serif SC'");
    expect(css).toContain("'JetBrains Mono'");
    expect(css).not.toContain("Inter");
    expect(css).toContain(`url('${fontsDirUrl}/ebgaramond-aaa.woff2')`);
    expect(css).not.toContain("url('./fonts/");
  });

  it("fails loudly when a required family is missing from css", () => {
    fs.writeFileSync(
      path.join(themesDir, FONTS_CSS_FILENAME),
      SAMPLE_CSS.replace(/'Noto Serif SC'/g, "'Other Serif'"),
      "utf-8",
    );

    expect(() => buildFontInjectionCss({ themesDir })).toThrow(/Noto Serif SC/);
  });

  it("locates the first themes directory containing a font css source", () => {
    const empty = path.join(tempDir, "empty");
    fs.mkdirSync(empty, { recursive: true });

    expect(locateThemesDir([empty, themesDir])).toBe(themesDir);
    expect(() => locateThemesDir([empty])).toThrow(/font css/i);
  });

  it("can synthesize injection css from the real bundled font files", () => {
    const realThemesDir = path.join(__dirname, "..", "desktop", "src", "themes");
    const css = buildFontInjectionCss({ themesDir: realThemesDir });

    for (const family of GSAP_PDF_FONT_FAMILIES) {
      expect(css).toContain(`'${family}'`);
    }
    expect(css).toContain("file://");
    expect(css).not.toContain("Hana");
  });

  it("ships the font injector with the PDF helper", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));

    expect(pkg.build.files).toContain("desktop/src/office-pdf-fonts.cjs");
    expect(pkg.build.files).toContain("desktop/src/office-pdf-helper.cjs");
  });
});
