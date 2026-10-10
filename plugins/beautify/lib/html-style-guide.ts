export const HTML_STYLE_GUIDE_VERSION = "2026-06-10";

const SECTION_TEXT = new Map<string, string>([
  ["color", [
    "Codia full-page HTML color guidance.",
    "",
    "Use a calm editorial palette with #537D96 as the primary accent and #F8F4ED as the warm paper surface.",
    "Keep body text on high-contrast neutrals, reserve the accent for active controls and key highlights, and avoid one-note monochrome screens.",
  ].join("\n")],
  ["typography", [
    "Codia full-page HTML typography guidance.",
    "",
    "Use EB Garamond for editorial serif moments, Noto Serif SC for Chinese serif text, system-ui for utilitarian UI, and JetBrains Mono for code.",
    "Use tabular-nums for counters, metadata, dates, and finance-like values. Do not scale font-size with viewport width.",
  ].join("\n")],
  ["layout", [
    "Codia full-page HTML layout guidance.",
    "",
    "Use stable responsive constraints: minmax grids, fixed toolbar heights, predictable gaps, and touch targets of at least 44px.",
    "Let the primary content appear in the first viewport and leave a hint of the next section on both mobile and desktop.",
  ].join("\n")],
  ["components", [
    "Codia full-page HTML component guidance.",
    "",
    "Use semantic buttons, inputs, tabs, menus, sliders, and toggles. Provide visible focus-visible states for every interactive element.",
    "Avoid putting cards inside cards. Use cards only for repeated items, modals, and genuinely framed tools.",
  ].join("\n")],
  ["imagery", [
    "Codia full-page HTML imagery guidance.",
    "",
    "Use real or generated bitmap imagery that reveals the product, place, person, document, or workflow state.",
    "Icons should use a consistent stroke width and should clarify controls rather than decorate the page.",
  ].join("\n")],
  ["motion", [
    "Codia full-page HTML motion guidance.",
    "",
    "Use short transitions for state changes and progressive disclosure. Respect prefers-reduced-motion.",
    "Do not rely on motion to communicate essential state.",
  ].join("\n")],
  ["anti-patterns", [
    "Codia full-page HTML anti-patterns.",
    "",
    "Avoid glassmorphism, decorative gradient blobs, oversized marketing heroes for tools, hidden scroll traps, and text that overlaps controls.",
    "Do not generate a card-heavy landing page when the requested output is an app, report, dashboard, or usable tool.",
  ].join("\n")],
]);

export const HTML_STYLE_GUIDE_SECTIONS = [...SECTION_TEXT.keys()];
export const REQUIRED_SECTIONS = ["color", "typography"];

const MAX_TRACKED_SESSIONS = 200;
const readSectionsBySession = new Map<string, Set<string>>();

export function sessionTrackingKey(ctx: any): string {
  const sessionPath = ctx && typeof ctx.sessionPath === "string" ? ctx.sessionPath : "";
  return sessionPath || "__no_session__";
}

export function markSectionRead(trackingKey: string, section: string): void {
  let read = readSectionsBySession.get(trackingKey);
  if (!read) {
    if (readSectionsBySession.size >= MAX_TRACKED_SESSIONS) {
      const oldest = readSectionsBySession.keys().next().value;
      if (oldest !== undefined) readSectionsBySession.delete(oldest);
    }
    read = new Set<string>();
    readSectionsBySession.set(trackingKey, read);
  }
  read.add(section);
}

export function getReadSections(trackingKey: string): string[] {
  return [...(readSectionsBySession.get(trackingKey) || [])];
}

export function missingRequiredSections(trackingKey: string): string[] {
  const read = readSectionsBySession.get(trackingKey) || new Set<string>();
  return REQUIRED_SECTIONS.filter((section) => !read.has(section));
}

export function resetHtmlStyleGuideTracking(): void {
  readSectionsBySession.clear();
}

export function buildHtmlStyleGuideRouter(): string {
  return [
    "Codia full-page HTML style guide router.",
    "",
    "Call beautify_get-html-style-guide with one section at a time.",
    `Sections: ${HTML_STYLE_GUIDE_SECTIONS.join(", ")}.`,
    "Read color and typography first. The router intentionally omits concrete color values.",
  ].join("\n");
}

export function buildHtmlStyleGuideSection(section: string): string | null {
  return SECTION_TEXT.get(section) || null;
}
