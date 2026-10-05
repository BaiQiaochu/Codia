// @ts-nocheck
import { describe, expect, it } from "vitest";

import { summarizeToolStartArgs } from "../server/routes/chat.ts";

describe("chat tool_start arg summary", () => {
  it("does not leak unsummarized args for other tools", () => {
    expect(summarizeToolStartArgs("write", {
      file_path: "/tmp/a.txt",
      content: "secret body",
    }, 1_700_000_000_000)).toEqual({
      file_path: "/tmp/a.txt",
    });
  });
});
