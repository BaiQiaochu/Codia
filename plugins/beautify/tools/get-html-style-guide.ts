import {
  HTML_STYLE_GUIDE_SECTIONS,
  HTML_STYLE_GUIDE_VERSION,
  REQUIRED_SECTIONS,
  buildHtmlStyleGuideRouter,
  buildHtmlStyleGuideSection,
  getReadSections,
  markSectionRead,
  missingRequiredSections,
  sessionTrackingKey,
} from "../lib/html-style-guide.ts";
import { isBeautifyEnabledForAgentConfig } from "../lib/availability.ts";

export const name = "get-html-style-guide";
export const description = "Read the Codia Beautify style guide for full-page HTML before generating unstylized web pages, reports, dashboards, or typeset articles.";

export const promptGuidelines = [
  "Call beautify_get-html-style-guide before generating full-page HTML when the user has not supplied a brand or style.",
  "First call with no arguments to get the router, then fetch sections one by one: color and typography are mandatory.",
  "Do not generate HTML from router text alone; it deliberately contains no concrete values.",
  "This tool returns guidance only. Write and save the HTML yourself with regular file output.",
].join("\n");

export { isBeautifyEnabledForAgentConfig as isEnabledForAgentConfig };

export const parameters = {
  type: "object",
  properties: {
    section: {
      type: "string",
      enum: HTML_STYLE_GUIDE_SECTIONS,
      description: "Style guide section to read. Omit it to get the router.",
    },
  },
};

function textResult(text: string, details: Record<string, any>): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, any>;
} {
  return {
    content: [{ type: "text", text }],
    details: { version: HTML_STYLE_GUIDE_VERSION, ...details },
  };
}

export async function execute(input: any = {}, ctx?: any) {
  const trackingKey = sessionTrackingKey(ctx);
  const section = typeof input?.section === "string" ? input.section.trim() : "";

  if (!section) {
    return textResult(buildHtmlStyleGuideRouter(), { kind: "router" });
  }

  const text = buildHtmlStyleGuideSection(section);
  if (text === null) {
    return textResult(
      `Unknown HTML style guide section "${section}". Valid sections: ${HTML_STYLE_GUIDE_SECTIONS.join(", ")}.`,
      { kind: "invalid-section", valid: HTML_STYLE_GUIDE_SECTIONS },
    );
  }

  const missing = missingRequiredSections(trackingKey);
  if (!REQUIRED_SECTIONS.includes(section) && missing.length > 0) {
    return textResult(
      `Read required sections first before "${section}": ${missing.join(", ")}.`,
      { kind: "must-read-first", missingRequired: missing },
    );
  }

  markSectionRead(trackingKey, section);
  return textResult(text, {
    kind: "section",
    section,
    readSections: getReadSections(trackingKey),
  });
}
