import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { MASKED_SECRET } from "../shared/secret-custody.ts";

describe("security audit log", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("redacts secret-like metadata before writing audit JSONL", async () => {
    const { appendSecurityAuditEvent, securityAuditLogPath } = await import("../core/security-audit-log.js");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-security-audit-"));

    const record = appendSecurityAuditEvent(tmpDir, {
      action: "settings.test",
      result: "success",
      actor: { kind: "device", deviceId: "phone" },
      metadata: {
        api_key: "sk-secret",
        nested: {
          token: "tg-secret",
          safe: "visible",
        },
      },
    }, {
      now: "2026-05-17T00:00:00.000Z",
      eventId: "sec_test",
    });

    expect(record.metadata).toEqual({
      api_key: MASKED_SECRET,
      nested: {
        token: MASKED_SECRET,
        safe: "visible",
      },
    });
    const raw = fs.readFileSync(securityAuditLogPath(tmpDir), "utf-8");
    expect(raw).not.toContain("sk-secret");
    expect(raw).not.toContain("tg-secret");
  });
});
