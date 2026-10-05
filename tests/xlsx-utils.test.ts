import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { xlsxToHtml, xlsxToText } from "../shared/xlsx-utils.ts";

const fixturePath = path.join(process.cwd(), "tests", "fixtures", "sample.xlsx");
const tmpDir = path.join(process.cwd(), "tmp", "tests");

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const mod = (value - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    value = Math.floor((value - mod) / 26);
  }
  return name;
}

function sheetXml(rows) {
  const rowXml = rows.map((row, rowIndex) => {
    const cells = row.map((cell, colIndex) => {
      const ref = `${columnName(colIndex)}${rowIndex + 1}`;
      return `<c r="${ref}" t="inlineStr"><is><t>${String(cell)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
}

async function writeWorkbook(filePath, sheets) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
    + `</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `</Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>`
    + `</workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")
    + `</Relationships>`);
  sheets.forEach((sheet, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet.rows));
  });
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(filePath, buffer);
}

describe("xlsx-utils", () => {
  it("converts xlsx to aligned text", async () => {
    expect(fs.existsSync(fixturePath)).toBe(true);
    const text = await xlsxToText(fixturePath);

    expect(text).toContain("[Sheet: People]");
    expect(text).toContain("Rows: 3");
    expect(text).toContain("Columns: 2");
    expect(text).toContain("Alice");
    expect(text).toContain("Bob");
    expect(text).toContain("Age");
  });

  it("converts xlsx to html", async () => {
    const html = await xlsxToHtml(fixturePath);

    expect(html).toContain("<table");
    expect(html).toContain("People");
    expect(html).toContain("Alice");
    expect(html).toContain("Bob");
  });

  it("reads all workbook sheets", async () => {
    const workbookPath = path.join(tmpDir, "multi-sheet.xlsx");
    await writeWorkbook(workbookPath, [
      { name: "First", rows: [["Name"], ["Alice"]] },
      { name: "Second", rows: [["Name"], ["Bob"]] },
    ]);

    const text = await xlsxToText(workbookPath);

    expect(text).toContain("[Sheet: First]");
    expect(text).toContain("[Sheet: Second]");
    expect(text).toContain("Alice");
    expect(text).toContain("Bob");
  });

  it("keeps oversized sheet rows reachable while bounding cell text", async () => {
    const workbookPath = path.join(tmpDir, "oversized-sheet.xlsx");
    await writeWorkbook(workbookPath, [{
      name: "Big",
      rows: Array.from({ length: 101 }, (_, index) => [`row-${index + 1}`, "value"]),
    }]);

    const text = await xlsxToText(workbookPath);

    expect(text).toContain("[Sheet: Big]");
    expect(text).toContain("Rows: 101");
    expect(text).toContain("Columns: 2");
    expect(text).toContain("row-101");
    expect(text).not.toContain("Preview");
    expect(text).not.toContain("[truncated:");
    expect(text).not.toContain("[Sheet content summarized: too many rows or columns to inline safely]");
  });
});
