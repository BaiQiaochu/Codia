import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withMemoryReasoningBuffer } from "../lib/memory/llm-budget.js";

const repoRoot = path.resolve(__dirname, "..");

describe("memory LLM output budget", () => {
  it("keeps non-reasoning memory calls at the visible token budget", () => {
    const maxTokens = withMemoryReasoningBuffer(480, {
      model: { id: "utility", reasoning: false, maxTokens: 4096 },
    });

    expect(maxTokens).toBe(480);
  });

  it("adds a hidden reasoning buffer without exceeding model limits", () => {
    const maxTokens = withMemoryReasoningBuffer(480, {
      model: { id: "reasoning-model", reasoning: true, maxTokens: 1200 },
    });

    expect(maxTokens).toBe(1200);
  });

  it("uses the reasoning buffer in memory compile and rolling summary calls", () => {
    const compile = fs.readFileSync(path.join(repoRoot, "lib/memory/compile.ts"), "utf8");
    const summary = fs.readFileSync(path.join(repoRoot, "lib/memory/session-summary.ts"), "utf8");

    expect(compile).toContain("withMemoryReasoningBuffer");
    expect(summary).toContain("withMemoryReasoningBuffer");
  });
});
