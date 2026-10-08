/**
  *
 * PI SDK -read tool 只做 buffer.toString("utf-8")，对 xlsx/docx 等二进制格式
  *
  *
 */

import { readFile as fsReadFile } from "fs/promises";
import { extname } from "path";
import { xlsxToText } from "../../shared/xlsx-utils.ts";

//

async function docxToText(filePath) {
  const mammoth = (await import("mammoth")).default;
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

//

/**
  * */
function isValidUtf8(buffer) {
 //
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return true;

 //
  let hasHighByte = false;
  for (let i = 0; i < Math.min(buffer.length, 8192); i++) {
    if (buffer[i] > 0x7F) { hasHighByte = true; break; }
  }
  if (!hasHighByte) return true;

 //
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function decodeBuffer(buffer) {
  if (isValidUtf8(buffer)) {
    // 鍘绘帀 UTF-8 BOM
    if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
      return buffer.subarray(3).toString("utf-8");
    }
    return buffer.toString("utf-8");
  }
 //
  try {
    return new TextDecoder("gbk").decode(buffer);
  } catch {
    // fallback
    return buffer.toString("utf-8");
  }
}

// ── 导出 ──

const XLSX_EXTS = new Set([".xlsx"]);
const DOCX_EXTS = new Set([".docx"]); // mammoth 只支持 .docx (Office Open XML)，不支持旧版 .doc
const TEXT_LIKE_EXTS = new Set([
  ".csv", ".tsv", ".txt", ".log", ".md", ".json", ".xml", ".html", ".htm",
  ".yaml", ".yml", ".ini", ".cfg", ".conf", ".properties",
  ".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".c", ".cpp", ".h", ".cs",
  ".go", ".rs", ".rb", ".php", ".sh", ".bat", ".ps1", ".sql",
]);

/**
  *
 * @returns {(absolutePath: string) => Promise<Buffer>}
 */
export function createEnhancedReadFile() {
  return async (absolutePath) => {
    const ext = extname(absolutePath).toLowerCase();

 //
    if (XLSX_EXTS.has(ext)) {
      try {
        const text = await xlsxToText(absolutePath);
        return Buffer.from(text, "utf-8");
      } catch (err) {
 //
        const { t } = await import("../i18n.ts");
        return Buffer.from(`[${t("error.xlsxParseFailed", { ext, msg: err.message })}]`, "utf-8");
      }
    }

 // docx -提取纯文本，返回 UTF-8 buffer
    if (DOCX_EXTS.has(ext)) {
      try {
        const text = await docxToText(absolutePath);
        return Buffer.from(text, "utf-8");
      } catch (err) {
        const { t } = await import("../i18n.ts");
        return Buffer.from(`[${t("error.docxParseFailed", { ext, msg: err.message })}]`, "utf-8");
      }
    }

 // 读取原始 buffer
    const buffer = await fsReadFile(absolutePath);

 // 文本文件：检测编码，-UTF-8 转换
    if (TEXT_LIKE_EXTS.has(ext) || !ext) {
      const decoded = decodeBuffer(buffer);
      return Buffer.from(decoded, "utf-8");
    }

 // 其他文件：原样返回（图片等由 PI SDK 自己处理-
    return buffer;
  };
}
