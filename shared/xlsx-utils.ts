import { readFile } from "fs/promises";
import readXlsxFile from "read-excel-file/universal";

const XLSX_SHEET_LIMIT = 8;
const XLSX_SUMMARY_ROW_THRESHOLD = 100;
const XLSX_SUMMARY_COLUMN_THRESHOLD = 30;
const XLSX_SUMMARY_CELL_THRESHOLD = 3000;
const XLSX_COLUMNS_PER_TEXT_LINE = 30;
const XLSX_DISPLAY_CELL_WIDTH = 40;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncateCell(value, width) {
  if (value.length <= width) return value.padEnd(width);
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function normalizeCellText(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ");
}

function shouldSummarizeSheet(rows, columnCount) {
  return (
    rows.length > XLSX_SUMMARY_ROW_THRESHOLD ||
    columnCount > XLSX_SUMMARY_COLUMN_THRESHOLD ||
    rows.length * columnCount > XLSX_SUMMARY_CELL_THRESHOLD
  );
}

async function getWorkbookRows(filePath) {
  const buffer = await readFile(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const parsed = await readXlsxFile(arrayBuffer);
  const sheets = Array.isArray(parsed) && parsed[0]?.data
    ? parsed
    : [{ sheet: "Sheet 1", data: parsed }];

  return sheets.map((sheet, index) => ({
    sheetName: sheet.sheet || `Sheet ${index + 1}`,
    rows: (sheet.data || []).map((row) => row.map((cell) => normalizeCellText(cell))),
  }));
}

export async function xlsxToText(filePath) {
  const workbookRows = await getWorkbookRows(filePath);
  const parts = [];

  for (const { sheetName, rows } of workbookRows.slice(0, XLSX_SHEET_LIMIT)) {
    if (rows.length === 0) continue;

    parts.push(`[Sheet: ${sheetName}]`);

    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
    parts.push(`Rows: ${rows.length}`);
    parts.push(`Columns: ${columnCount}`);
    const widths = new Array(columnCount).fill(0);
    for (const row of rows) {
      for (let i = 0; i < columnCount; i += 1) {
        widths[i] = Math.min(XLSX_DISPLAY_CELL_WIDTH, Math.max(widths[i], (row[i] || "").length));
      }
    }

    const splitColumns = columnCount > XLSX_COLUMNS_PER_TEXT_LINE;
    for (const row of rows) {
      for (let start = 0; start < columnCount; start += XLSX_COLUMNS_PER_TEXT_LINE) {
        const end = Math.min(columnCount, start + XLSX_COLUMNS_PER_TEXT_LINE);
        const line = widths
          .slice(start, end)
          .map((width, offset) => truncateCell(row[start + offset] || "", width))
          .join(" | ");
        parts.push(splitColumns ? `C${start + 1}-${end}: ${line}` : line);
      }
    }
    parts.push("");
  }

  if (workbookRows.length > XLSX_SHEET_LIMIT) {
    parts.push(`[Workbook truncated: showing ${XLSX_SHEET_LIMIT}/${workbookRows.length} sheets]`);
  }

  return parts.join("\n");
}

export async function xlsxToHtml(filePath) {
  const workbookRows = await getWorkbookRows(filePath);
  const sections = [];

  workbookRows.slice(0, XLSX_SHEET_LIMIT).forEach(({ sheetName, rows }, index) => {
    if (rows.length === 0) return;
    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const tableHtml = shouldSummarizeSheet(rows, columnCount)
      ? `<p>${escapeHtml(`[Sheet content summarized: ${rows.length} rows, ${columnCount} columns]`)}</p>`
      : [
          `<table id="sheet-${index}">`,
          ...rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`),
          `</table>`,
        ].join("");
    sections.push(
      `<section class="xlsx-sheet">` +
      `<h3>${escapeHtml(sheetName)}</h3>` +
      tableHtml +
      `</section>`,
    );
  });

  if (workbookRows.length > XLSX_SHEET_LIMIT) {
    sections.push(
      `<section class="xlsx-sheet xlsx-truncated">` +
      `<p>${escapeHtml(`[Workbook truncated: showing ${XLSX_SHEET_LIMIT}/${workbookRows.length} sheets]`)}</p>` +
      `</section>`,
    );
  }

  if (sections.length === 0) return null;
  return sections.join("\n");
}
