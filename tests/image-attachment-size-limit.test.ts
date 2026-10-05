import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  MAX_CHAT_IMAGE_BASE64_CHARS,
  isChatImageBase64WithinLimit,
} from "../shared/image-mime.ts";

const PREVIOUS_IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;

function base64CharsForBytes(byteCount: number): number {
  return Math.ceil(byteCount / 3) * 4;
}

function readFileBase64Handler(source: string): string {
  const match = source.match(/wrapIpcHandler\("read-file-base64"[\s\S]*?\n\}\);/);
  if (!match) throw new Error("read-file-base64 handler not found");
  return match[0];
}

describe("image attachment size limit", () => {
  it("allows chat image payloads above the old 20MB ceiling", () => {
    const oldLimitAsBase64Chars = base64CharsForBytes(PREVIOUS_IMAGE_LIMIT_BYTES);

    expect(MAX_CHAT_IMAGE_BASE64_CHARS).toBeGreaterThan(oldLimitAsBase64Chars);
    expect(isChatImageBase64WithinLimit("x".repeat(oldLimitAsBase64Chars + 4))).toBe(true);
  });

  it("uses an image-specific limit when Electron reads local files as base64", () => {
    const mainSource = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf-8");
    const handler = readFileBase64Handler(mainSource);

    expect(handler).toContain("MAX_IMAGE_ATTACHMENT_BYTES");
    expect(handler).toContain("isImageAttachmentPath(filePath)");
    expect(handler).not.toContain("20 * 1024 * 1024");
  });
});
