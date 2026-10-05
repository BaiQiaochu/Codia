const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const FONTS_CSS_FILENAME = "new-warm-paper-fonts.css";
const GSAP_PDF_FONT_FAMILIES = ["EB Garamond", "Noto Serif SC", "JetBrains Mono"];

const SYNTHETIC_FONT_PATTERNS = Object.freeze({
  "EB Garamond": /^ebgaramond-.*\.woff2$/i,
  "Noto Serif SC": /^notoserifsc-.*\.woff2$/i,
  "JetBrains Mono": /^jetbrainsmono-.*\.woff2$/i,
});

function defaultThemesDirCandidates() {
  return [
    path.join(__dirname, "themes"),
    path.join(__dirname, "..", "dist-renderer", "themes"),
  ];
}

function hasFontSource(dir) {
  return fs.existsSync(path.join(dir, FONTS_CSS_FILENAME)) || fs.existsSync(path.join(dir, "fonts"));
}

function locateThemesDir(candidates = defaultThemesDirCandidates()) {
  for (const dir of candidates) {
    if (hasFontSource(dir)) return dir;
  }
  throw new Error(
    `PDF font css or fonts directory not found; looked in: ${candidates.join(", ")}. ` +
    "Run build:renderer or check packaged resources.",
  );
}

function extractFontFaceBlocks(css) {
  return css.match(/@font-face\s*\{[^}]*\}/g) || [];
}

function familyOf(block) {
  const match = block.match(/font-family:\s*(['"]?)([^;'"]+)\1\s*;/);
  return match ? match[2].trim() : null;
}

function rewriteFontUrls(block, fontsDirUrl) {
  return block.replace(
    /url\(\s*(['"]?)\.\/fonts\/([^)'"]+)\1\s*\)/g,
    (_match, _quote, file) => `url('${fontsDirUrl}/${file}')`,
  );
}

function cssFromFontFaceFile(themesDir, families) {
  const cssPath = path.join(themesDir, FONTS_CSS_FILENAME);
  if (!fs.existsSync(cssPath)) return null;
  const css = fs.readFileSync(cssPath, "utf-8");
  const blocks = extractFontFaceBlocks(css);
  if (blocks.length === 0) return null;

  const fontsDirUrl = pathToFileURL(path.join(themesDir, "fonts")).href;
  const wanted = new Set(families);
  const selected = blocks
    .filter((block) => wanted.has(familyOf(block)))
    .map((block) => rewriteFontUrls(block, fontsDirUrl));
  return selected;
}

function syntheticBlocksFromBundledFonts(themesDir, families) {
  const fontsDir = path.join(themesDir, "fonts");
  if (!fs.existsSync(fontsDir)) return [];
  const files = fs.readdirSync(fontsDir).filter((file) => file.toLowerCase().endsWith(".woff2"));
  const fontsDirUrl = pathToFileURL(fontsDir).href;
  const blocks = [];

  for (const family of families) {
    const pattern = SYNTHETIC_FONT_PATTERNS[family];
    const familyFiles = pattern ? files.filter((file) => pattern.test(file)).sort() : [];
    for (const file of familyFiles) {
      blocks.push([
        "@font-face {",
        `  font-family: '${family}';`,
        "  font-style: normal;",
        "  font-weight: 400;",
        "  font-display: swap;",
        `  src: url('${fontsDirUrl}/${file}') format('woff2');`,
        "}",
      ].join("\n"));
    }
  }

  return blocks;
}

function buildFontInjectionCss({ themesDir = locateThemesDir(), families = GSAP_PDF_FONT_FAMILIES } = {}) {
  const blocks = cssFromFontFaceFile(themesDir, families) || syntheticBlocksFromBundledFonts(themesDir, families);
  const covered = new Set(blocks.map(familyOf));
  const missing = families.filter((family) => !covered.has(family));
  if (missing.length > 0) {
    throw new Error(`PDF font source at ${themesDir} is missing families: ${missing.join(", ")}`);
  }
  return blocks.join("\n");
}

module.exports = {
  FONTS_CSS_FILENAME,
  GSAP_PDF_FONT_FAMILIES,
  buildFontInjectionCss,
  locateThemesDir,
};
