import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { execute as readDocument } from "../plugins/office/tools/read-document.ts";
import { execute as listCapabilities } from "../plugins/office/tools/list-capabilities.ts";
import { renderHtmlToPdf } from "../plugins/office/lib/html-to-pdf.ts";
import { isOfficeEnabledForAgentConfig } from "../plugins/office/lib/availability.ts";

function escapePdfText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function makeTextPdf(pages: string[]) {
  const objects = [];
  const pageObjectIds = pages.map((_, index) => 4 + index * 2);
  const contentObjectIds = pages.map((_, index) => 5 + index * 2);

  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  for (let index = 0; index < pages.length; index += 1) {
    const pageId = pageObjectIds[index];
    const contentId = contentObjectIds[index];
    objects[pageId - 1] = [
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]",
      "/Resources << /Font << /F1 3 0 R >> >>",
      `/Contents ${contentId} 0 R >>`,
    ].join(" ");

    const lines = pages[index].split("\n");
    const commands = [
      "BT",
      "/F1 18 Tf",
      "72 720 Td",
      ...lines.flatMap((line, lineIndex) => [
        lineIndex === 0 ? "" : "0 -24 Td",
        `(${escapePdfText(line)}) Tj`,
      ]).filter(Boolean),
      "ET",
    ].join("\n");
    objects[contentId - 1] = `<< /Length ${Buffer.byteLength(commands, "utf-8")} >>\nstream\n${commands}\nendstream`;
  }

  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(chunks.join(""), "utf-8"));
    chunks.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(""), "utf-8");
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push("0000000000 65535 f \n");
  for (const offset of offsets.slice(1)) {
    chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return chunks.join("");
}

describe("office plugin tools", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-office-plugin-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports Office capabilities without side effects", async () => {
    const result = await listCapabilities();

    expect(result.content[0].text).toContain("Office tools are available");
    expect(result.details.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "read-document",
        tool: "office_read-document",
        supportedInputs: expect.arrayContaining([".pdf", ".xlsm"]),
      }),
      expect.objectContaining({ id: "html-to-pdf", tool: "office_html-to-pdf" }),
    ]));
  });

  it("is enabled by default and follows the per-agent office toggle", () => {
    expect(isOfficeEnabledForAgentConfig({})).toBe(true);
    expect(isOfficeEnabledForAgentConfig({ tools: { disabled: [] } })).toBe(true);
    expect(isOfficeEnabledForAgentConfig({ tools: { disabled: ["office"] } })).toBe(false);
  });

  it("reads text-like documents with maxChars limits", async () => {
    const filePath = path.join(tempDir, "notes.md");
    fs.writeFileSync(filePath, "# Title\n\nRevenue grew by 42 units.", "utf-8");

    const result = await readDocument({ filePath, maxChars: 12 });

    expect(result.details.office).toMatchObject({
      kind: "text",
      format: "text",
      filename: "notes.md",
      truncated: true,
    });
    expect(result.content[0].text).toContain("[Truncated at 12 characters]");
  });

  it("reads selected PDF pages as Markdown with pagination metadata", async () => {
    const filePath = path.join(tempDir, "travel.pdf");
    fs.writeFileSync(filePath, makeTextPdf([
      "Opening page alpha",
      "Second page beta\nE = mc^2",
    ]), "utf-8");

    const result = await readDocument({ filePath, pageRange: "2", maxChars: 2000 });

    expect(result.details.office).toMatchObject({
      kind: "pdf",
      format: "markdown",
      totalPages: 2,
      pages: [2],
      truncated: false,
    });
    expect(result.content[0].text).toContain("## Page 2");
    expect(result.content[0].text).toContain("Second page beta");
    expect(result.content[0].text).toContain("E = mc^2");
    expect(result.content[0].text).not.toContain("Opening page alpha");
    expect(result.details.office.warnings).toEqual(expect.arrayContaining(["math_may_be_degraded"]));
  });

  it("reports image-only PDFs as unsupported without OCR fallback", async () => {
    const filePath = path.join(tempDir, "blank.pdf");
    fs.writeFileSync(filePath, makeTextPdf([""]), "utf-8");

    const result = await readDocument({ filePath });

    expect(result.details.error).toMatchObject({
      code: "OFFICE_READ_FAILED",
      message: expect.stringContaining("no extractable text"),
    });
    expect(result.content[0].text).toContain("OCR is not supported");
  });

  it("renders HTML to PDF through the desktop helper contract and stages the output", async () => {
    let observedCommand = null;
    const fakeSpawn = vi.fn((command, args) => {
      observedCommand = { command, args };
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        const jobPath = args.at(-1);
        const job = JSON.parse(fs.readFileSync(jobPath, "utf-8"));
        fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });
        fs.writeFileSync(job.outputPath, "%PDF-1.4\n% office test\n", "utf-8");
        child.emit("close", 0);
      });
      return child;
    });
    const stageFile = vi.fn(({ sessionPath, filePath, label }) => ({
      file: { fileId: "sf_pdf", sessionPath, filePath, label },
      mediaItem: { type: "session_file", fileId: "sf_pdf", sessionPath, filePath, label },
    }));

    const result = await renderHtmlToPdf(
      {
        html: "<!doctype html><style>@page{size:A4}</style><h1>Hello</h1>",
        filename: "hello.pdf",
      },
      {
        dataDir: tempDir,
        sessionPath: "/sessions/office.jsonl",
        stageFile,
      },
      {
        env: {
          GSAP_DESKTOP_EXEC_PATH: "/Applications/G-SAP.app/Contents/MacOS/G-SAP",
          GSAP_DESKTOP_IS_PACKAGED: "1",
        },
        spawn: fakeSpawn,
      },
    );

    expect(observedCommand).toMatchObject({
      command: "/Applications/G-SAP.app/Contents/MacOS/G-SAP",
      args: ["--gsap-office-html-to-pdf", expect.stringMatching(/job\.json$/)],
    });
    expect(fs.readFileSync(result.outputPath, "utf-8")).toContain("%PDF-1.4");
    expect(stageFile).toHaveBeenCalledWith({
      sessionPath: "/sessions/office.jsonl",
      filePath: result.outputPath,
      label: "hello.pdf",
    });
    expect(result.mediaItem).toMatchObject({ type: "session_file", fileId: "sf_pdf" });
  });
});
