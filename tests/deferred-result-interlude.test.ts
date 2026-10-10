// @ts-nocheck
import { describe, expect, it } from "vitest";

import {
  buildDeferredResultInterludeBlock,
  extractDeferredResultDetailMarkdown,
} from "../server/deferred-result-interlude.js";

describe("deferred result interlude", () => {
  it("uses subagent metadata for readable source labels without upstream branding", () => {
    const block = buildDeferredResultInterludeBlock({
      taskId: "subagent-1",
      status: "success",
      result: "Review completed",
      meta: {
        type: "subagent",
        executorAgentNameSnapshot: "Reviewer",
        label: "Draft review",
        summary: "Read the long task and produce a complete review.",
      },
    }, { receiverName: "Codia" });

    expect(block).toMatchObject({
      type: "interlude",
      taskId: "subagent-1",
      sourceKind: "subagent",
      sourceLabel: "Reviewer / Draft review",
      text: "Codia received a reply from Reviewer / Draft review",
      detailMarkdown: "Review completed",
    });
  });

  it("does not leak long task summaries into the interlude source label", () => {
    const block = buildDeferredResultInterludeBlock({
      taskId: "subagent-2",
      status: "success",
      result: "Done",
      meta: {
        type: "subagent",
        executorAgentNameSnapshot: "Worker",
        label: "Implementation",
        summary: "Implement a very long task description that should stay out of the compact interlude label.",
      },
    }, { receiverName: "Codia" });

    expect(block).toMatchObject({
      sourceKind: "subagent",
      sourceLabel: "Worker / Implementation",
      text: "Codia received a reply from Worker / Implementation",
    });
    expect(block.sourceLabel).not.toContain("very long task");
    expect(block.text).not.toContain("very long task");
  });

  it("peels human-readable fields out of structured tool results", () => {
    const detail = extractDeferredResultDetailMarkdown({
      status: "success",
      result: {
        ok: true,
        sessionFiles: [
          { label: "report.md", kind: "markdown" },
        ],
        raw: { nested: "kept out while better fields exist" },
      },
    });

    expect(detail).toContain("Generated files");
    expect(detail).toContain("report.md");
    expect(detail).toContain("ok: true");
    expect(detail).not.toContain("kept out");
  });

  it("summarizes file-only tool results without dumping raw JSON", () => {
    const detail = extractDeferredResultDetailMarkdown({
      status: "success",
      result: {
        sessionFiles: [
          { label: "generated.png", kind: "image" },
        ],
      },
    });

    expect(detail).toBe("Generated files:\n- generated.png (image)");
    expect(detail).not.toContain("sessionFiles");
  });
});
