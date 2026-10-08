export { isOfficeEnabledForAgentConfig as isEnabledForAgentConfig } from "../lib/availability.ts";

export const name = "list-capabilities";

export const description = [
  "List the built-in Office tool capabilities. Use this before Office work when the user asks what formats are supported.",
  "This tool has no side effects.",
].join(" ");

export const parameters = {
  type: "object",
  properties: {},
};

export async function execute() {
  return {
    content: [{
      type: "text",
      text: "Office tools are available: read .docx/.xlsx/.xlsm/.pdf/text-like documents, and export static HTML to PDF with the desktop Chromium print engine. Editing docx/xlsx/pptx/pdf is intentionally left as future extension surface.",
    }],
    details: {
      capabilities: [
        {
          id: "read-document",
          tool: "office_read-document",
          supportedInputs: [".docx", ".xlsx", ".xlsm", ".pdf", ".txt", ".md", ".csv", ".tsv", ".html"],
          outputs: ["text", "markdown for pdf", "html for docx", "json for xlsx/xlsm"],
          sideEffects: false,
        },
        {
          id: "html-to-pdf",
          tool: "office_html-to-pdf",
          supportedInputs: ["inline html", "absolute htmlPath"],
          output: ".pdf SessionFile",
          engine: "Electron Chromium printToPDF",
          sideEffects: true,
        },
      ],
    },
  };
}
