// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./args.ts";
import { CliError } from "./errors.ts";

export const IMAGE_MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

export async function readImages(paths = []) {
  const images = [];
  for (const rawPath of paths) {
    const filePath = path.resolve(expandHome(rawPath));
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = IMAGE_MIME_BY_EXT.get(ext);
    if (!mimeType) throw new CliError(`不支持的图片格式: ${filePath}`);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new CliError(`不是文件: ${filePath}`);
    if (stat.size > 15 * 1024 * 1024) throw new CliError(`图片过大: ${filePath}`);
    images.push({ type: "image", data: fs.readFileSync(filePath).toString("base64"), mimeType });
  }
  return images;
}
