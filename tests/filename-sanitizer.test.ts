import { describe, expect, it } from "vitest";

import {
  replaceUnsafeFilenameChars,
  sanitizeArtifactFilename,
  sanitizeFilenameBase,
  sanitizeFilename,
  sanitizePathBasename,
  sanitizePublicMediaUrl,
  uniqueFilename,
} from "../shared/filename-sanitizer.ts";

describe("filename sanitizer", () => {
  it("replaces Windows-unsafe filename characters and control characters", () => {
    expect(replaceUnsafeFilenameChars('a<b>c:d"e/f\\g|h?i*j\u0001', "_")).toBe(
      "a_b_c_d_e_f_g_h_i_j_",
    );
  });

  it("normalizes artifact filename bases with fallback and max length", () => {
    expect(sanitizeFilenameBase('  report: <draft>   final  ', { maxLength: 12 })).toBe("report draft");
    expect(sanitizeFilenameBase('***', { fallback: "artifact" })).toBe("artifact");
    expect(sanitizeFilenameBase('CON', { fallback: "artifact" })).toBe("artifact");
  });

  it("keeps only the sanitized basename for path-like upload names", () => {
    expect(sanitizePathBasename('C:/tmp/my<bad>|file.txt')).toBe("mybadfile.txt");
    expect(sanitizePathBasename('C:\\tmp\\draft?.md')).toBe("draft.md");
    expect(sanitizePathBasename('', { fallback: "upload.bin" })).toBe("upload.bin");
  });

  it("sanitizes complete artifact filenames while keeping unicode text", () => {
    expect(sanitizeFilename('  报告: 第一版?.md  ', { replacement: "_" })).toBe("报告_ 第一版_.md");
    expect(sanitizeArtifactFilename('demo/path', '.tsx')).toBe("demo path.tsx");
  });

  it("deduplicates already sanitized names", () => {
    expect(uniqueFilename("report.md", new Set(["report.md", "report (2).md"]))).toBe("report (3).md");
  });

  it("normalizes public media urls and rejects local schemes", () => {
    expect(sanitizePublicMediaUrl(" https://example.com/a.png#frag ")).toBe("https://example.com/a.png#frag");
    expect(sanitizePublicMediaUrl("file:///tmp/a.png")).toBe("");
  });
});
