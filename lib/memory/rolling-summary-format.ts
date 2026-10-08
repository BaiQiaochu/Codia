export const MAX_ROLLING_SUMMARY_FORMAT_REPAIRS = 1;

const FACT_TITLES = ["重要事实", "Key Facts"];
const TIMELINE_TITLES = ["事情经过", "Timeline"];
const EMPTY_FACT_MARKERS = new Set(["无", "none", "nothing", "n/a"]);

export const FACT_SECTION_TITLES = FACT_TITLES;
export const TIMELINE_SECTION_TITLES = TIMELINE_TITLES;

type ValidationResult = { ok: boolean; issues: string[] };

export function buildRollingSummaryFormatRequirements(locale = "zh-CN"): string {
  const isZh = String(locale || "").toLowerCase().startsWith("zh");
  if (isZh) {
    return [
      "## Rolling Summary Output Format",
      "最终答案必须只包含两个 Markdown 三级标题，标题文本和顺序固定：",
      "1. 第一行必须是 `### 重要事实`",
      "2. 第二个标题必须是 `### 事情经过`",
      "两个标题下的正文都必须使用无序列表；每一项以 `- ` 开头。",
      "如果某一节没有内容，也要输出一项：`- 无`。",
      "不要输出前言、后记、XML 标签或代码块。",
    ].join("\n");
  }
  return [
    "## Rolling Summary Output Format",
    "The final answer must contain only two Markdown level-3 headings, with fixed text and order:",
    "1. The first line must be `### Key Facts`",
    "2. The second heading must be `### Timeline`",
    "The body under both headings must use unordered list items beginning with `- `.",
    "If a section has no content, output one item: `- None`.",
    "Do not output preamble, conclusion, XML tags, or code fences.",
  ].join("\n");
}

export function buildRollingSummaryRepairPrompt(locale = "zh-CN"): string {
  return [
    "Repair the rolling summary format without adding new facts.",
    buildRollingSummaryFormatRequirements(locale),
    "Keep the original language. Preserve useful content, but output only the repaired summary.",
  ].join("\n\n");
}

export function buildRollingSummaryRepairInput({
  locale = "zh-CN",
  issues = [],
  summaryText = "",
}: {
  locale?: string;
  issues?: string[];
  summaryText?: string;
} = {}): string {
  return [
    buildRollingSummaryFormatRequirements(locale),
    "",
    "Validation issues:",
    ...(issues.length ? issues.map((issue) => `- ${issue}`) : ["- unknown format issue"]),
    "",
    "Draft summary:",
    summaryText,
  ].join("\n");
}

export function validateRollingSummaryFormat(text: string): ValidationResult {
  const source = String(text || "").trim();
  const issues: string[] = [];
  if (!source) return { ok: false, issues: ["summary is empty"] };

  const fact = findSection(source, FACT_TITLES);
  const timeline = findSection(source, TIMELINE_TITLES);
  if (!fact) issues.push("missing fact section heading: 重要事实 / Key Facts");
  if (!timeline) issues.push("missing timeline section heading: 事情经过 / Timeline");
  if (fact && timeline && timeline.index <= fact.index) {
    issues.push("timeline section must appear after fact section");
  }
  if (fact && timeline && timeline.level > fact.level) {
    issues.push("timeline heading must not be nested inside the fact section");
  }
  if (fact) {
    const body = extractSectionBody(source, fact);
    if (!body.trim()) {
      issues.push("fact section body is empty");
    }
  }

  return { ok: issues.length === 0, issues };
}

export function hasFactSectionHeading(text: string): boolean {
  return !!findSection(String(text || ""), FACT_TITLES);
}

export function extractFactSection(text: string): string {
  const source = String(text || "");
  const heading = findSection(source, FACT_TITLES);
  if (!heading) return "";
  return extractSectionBody(source, heading).trim();
}

export function isEmptyFactSection(text: string): boolean {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return true;
  return lines.every((line) => {
    const item = line.replace(/^[-*+][ \t]+/, "").trim().toLowerCase();
    return EMPTY_FACT_MARKERS.has(item);
  });
}

function findSection(markdown: string, titles: string[]) {
  const wanted = new Set(titles.map(normalizeTitle));
  const lines = markdown.split(/\r?\n/);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const heading = parseMarkdownHeading(lines[i]);
    if (heading && wanted.has(normalizeTitle(heading.title))) {
      return { ...heading, line: i, index: offset };
    }
    offset += lines[i].length + 1;
  }
  return null;
}

function extractSectionBody(markdown: string, heading: any): string {
  const lines = markdown.split(/\r?\n/);
  const body: string[] = [];
  for (let i = heading.line + 1; i < lines.length; i++) {
    const next = parseMarkdownHeading(lines[i]);
    if (next && next.level <= heading.level) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

function parseMarkdownHeading(line: string) {
  const match = /^(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(String(line || ""));
  if (!match) return null;
  return {
    level: match[1].length,
    title: match[2].replace(/[ \t]+#+[ \t]*$/, "").trim(),
  };
}

function normalizeTitle(title: string): string {
  return String(title || "").trim().toLowerCase();
}
