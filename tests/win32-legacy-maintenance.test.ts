import { describe, expect, it } from "vitest";
import {
  buildWin32GsapWriteAclCleanupArgs,
  buildWin32LegacyAclDiagnosticArgs,
  buildWin32LegacyProfileCleanupArgs,
} from "../lib/sandbox/win32-legacy-maintenance.js";

describe("win32 legacy sandbox maintenance", () => {
  it("builds ACL diagnostics without executable passthrough", () => {
    expect(buildWin32LegacyAclDiagnosticArgs({
      paths: ["C:\\work", "C:\\data"],
      cleanup: true,
    })).toEqual([
      "--cleanup-legacy-acl",
      "--diagnose-legacy-acl", "C:\\work",
      "--diagnose-legacy-acl", "C:\\data",
    ]);
  });

  it("builds deduped G-SAP ACL cleanup commands", () => {
    expect(buildWin32GsapWriteAclCleanupArgs({ paths: ["C:\\work", "C:\\work", "C:\\data"] }))
      .toEqual([
        "--cleanup-gsap-write-acl", "C:\\work",
        "--cleanup-gsap-write-acl", "C:\\data",
      ]);
  });

  it("builds legacy profile cleanup commands", () => {
    expect(buildWin32LegacyProfileCleanupArgs({
      profileNames: ["com.gsap.sandbox.1288.475900", "com.hanako.sandbox.5104.475988"],
    })).toEqual([
      "--cleanup-legacy-profile", "com.gsap.sandbox.1288.475900",
      "--cleanup-legacy-profile", "com.hanako.sandbox.5104.475988",
    ]);
  });
});
