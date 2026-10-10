import { describe, expect, it } from "vitest";
import {
  buildWin32CodiaWriteAclCleanupArgs,
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

  it("builds deduped Codia ACL cleanup commands", () => {
    expect(buildWin32CodiaWriteAclCleanupArgs({ paths: ["C:\\work", "C:\\work", "C:\\data"] }))
      .toEqual([
        "--cleanup-codia-write-acl", "C:\\work",
        "--cleanup-codia-write-acl", "C:\\data",
      ]);
  });

  it("builds legacy profile cleanup commands", () => {
    expect(buildWin32LegacyProfileCleanupArgs({
      profileNames: ["com.codia.sandbox.1288.475900", "com.codia.sandbox.5104.475988"],
    })).toEqual([
      "--cleanup-legacy-profile", "com.codia.sandbox.1288.475900",
      "--cleanup-legacy-profile", "com.codia.sandbox.5104.475988",
    ]);
  });
});
