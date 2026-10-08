import { describe, expect, it } from "vitest";

import {
  redactLogText,
  redactLogValue,
  redactLogLabel,
  formatLogArgs,
} from "../shared/log-redactor.ts";

describe("ESM log redaction", () => {
  it("exports browser-safe redaction helpers without CommonJS globals", () => {
    expect(redactLogText("token=abc123")).toBe("token=[redacted]");
    expect(redactLogValue({ token: "abc123", ok: true })).toEqual({
      token: "[redacted]",
      ok: true,
    });
    expect(redactLogLabel("bridge\nbad module!")).toBe("bridge_bad_module_");
    expect(formatLogArgs(["Authorization: Bearer secret"])).toBe("Authorization: Bearer [redacted]");
  });
});
