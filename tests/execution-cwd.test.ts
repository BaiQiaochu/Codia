import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertExecutionCwd, classifyExecutionCwd } from "../lib/shell/execution-cwd.ts";

describe("classifyExecutionCwd", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-exec-cwd-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("classifies an existing directory as ok", () => {
    expect(classifyExecutionCwd(tmpDir)).toMatchObject({ status: "ok", cwd: tmpDir });
  });

  it("classifies a deleted directory as missing", () => {
    const gone = path.join(tmpDir, "gone");
    expect(classifyExecutionCwd(gone)).toMatchObject({ status: "missing", cwd: gone });
  });

  it("classifies a file path as not-directory", () => {
    const file = path.join(tmpDir, "file.txt");
    fs.writeFileSync(file, "x");
    expect(classifyExecutionCwd(file)).toMatchObject({ status: "not-directory", cwd: file });
  });

  it("classifies empty and non-string input as invalid", () => {
    expect(classifyExecutionCwd("").status).toBe("invalid");
    expect(classifyExecutionCwd("   ").status).toBe("invalid");
    expect(classifyExecutionCwd(undefined).status).toBe("invalid");
  });

  it("classifies relative paths as relative", () => {
    expect(classifyExecutionCwd("some/relative/dir").status).toBe("relative");
  });

  it("accepts win32-style absolute paths on any host platform", () => {
    const result = classifyExecutionCwd("C:\\definitely\\missing\\dir");
    expect(result.status).toBe("missing");
  });

  it("lets unreadable stat errors pass through as unreadable", () => {
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const result = classifyExecutionCwd(tmpDir, {
      statSync: () => {
        throw eperm;
      },
    });
    expect(result).toMatchObject({ status: "unreadable", errorCode: "EPERM" });
  });
});

describe("assertExecutionCwd", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-exec-cwd-assert-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the cwd for an existing directory", () => {
    expect(assertExecutionCwd(tmpDir)).toBe(tmpDir);
  });

  it("throws GSAP_EXEC_CWD_MISSING with the cwd in the message for a missing directory", () => {
    const gone = path.join(tmpDir, "gone");
    let caught: any;
    try {
      assertExecutionCwd(gone);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe("GSAP_EXEC_CWD_MISSING");
    expect(caught.cwd).toBe(gone);
    expect(caught.message).toContain(gone);
    expect(caught.message.toLowerCase()).toContain("working directory");
  });

  it("throws GSAP_EXEC_CWD_NOT_DIRECTORY for a file path", () => {
    const file = path.join(tmpDir, "file.txt");
    fs.writeFileSync(file, "x");
    expect(() => assertExecutionCwd(file)).toThrowError(
      expect.objectContaining({ code: "GSAP_EXEC_CWD_NOT_DIRECTORY" }),
    );
  });

  it("throws GSAP_EXEC_CWD_INVALID for empty input", () => {
    expect(() => assertExecutionCwd("")).toThrowError(
      expect.objectContaining({ code: "GSAP_EXEC_CWD_INVALID" }),
    );
  });

  it("throws GSAP_EXEC_CWD_RELATIVE for relative paths", () => {
    expect(() => assertExecutionCwd("rel/dir")).toThrowError(
      expect.objectContaining({ code: "GSAP_EXEC_CWD_RELATIVE" }),
    );
  });

  it("does not throw for unreadable stat errors", () => {
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    expect(assertExecutionCwd(tmpDir, {
      statSync: () => {
        throw eperm;
      },
    })).toBe(tmpDir);
  });
});
