/**
 * #1624: Session capability fingerprint & drift classification.
 */
import { describe, it, expect } from "vitest";
import {
  computeSessionCapabilityFingerprint,
  buildSessionCapabilityDrift,
  normalizeSystemPromptForFingerprint,
} from "../core/session-capability-drift.ts";
import {
  repairRestoredToolSnapshot,
  repairRestoredToolSnapshotDetailed,
} from "../core/tool-snapshot-repair.ts";

describe("computeSessionCapabilityFingerprint", () => {
  it("is insensitive to tool name ordering and duplicates", () => {
    const a = computeSessionCapabilityFingerprint({
      toolNames: ["read", "bash", "edit"],
      systemPrompt: "p",
    });
    const b = computeSessionCapabilityFingerprint({
      toolNames: ["edit", "read", "bash", "read"],
      systemPrompt: "p",
    });
    expect(a).toBe(b);
  });

  it("ignores the volatile current-date line in the system prompt", () => {
    const promptA = "You are Codia.\nCurrent date and time: Monday, June 8, 2026, 10:00 CST\nYour day starts at 04:00.";
    const promptB = "You are Codia.\nCurrent date and time: Thursday, June 11, 2026, 23:59 CST\nYour day starts at 04:00.";
    const a = computeSessionCapabilityFingerprint({ toolNames: ["read"], systemPrompt: promptA });
    const b = computeSessionCapabilityFingerprint({ toolNames: ["read"], systemPrompt: promptB });
    expect(a).toBe(b);
  });
});

describe("normalizeSystemPromptForFingerprint", () => {
  it("replaces every date line, leaving the rest intact", () => {
    const normalized = normalizeSystemPromptForFingerprint(
      "head\nCurrent date and time: Monday, June 8, 2026\ntail\nCurrent date and time: Thursday, June 11, 2026",
    );
    expect(normalized).toContain("head");
    expect(normalized).toContain("tail");
    expect(normalized).not.toContain("June 8, 2026");
    expect(normalized).not.toContain("June 11, 2026");
  });

  it("passes through non-string values as strings without throwing", () => {
    expect(normalizeSystemPromptForFingerprint(null)).toBe("");
    expect(normalizeSystemPromptForFingerprint(undefined)).toBe("");
  });

  it("ignores localized memory and appearance sections around stable prompt seams", () => {
    const promptA = [
      "System base.",
      "## 记忆使用规则",
      "memory revision A",
      "",
      "Current date and time: Monday, June 8, 2026",
      "",
      "## 你的样子",
      "appearance revision A",
      "",
      "## Workspace Scope",
      "- e:/workspace",
    ].join("\n");
    const promptB = [
      "System base.",
      "## 记忆使用规则",
      "memory revision B",
      "",
      "Current date and time: Thursday, June 11, 2026",
      "",
      "## 你的样子",
      "appearance revision B",
      "",
      "## Workspace Scope",
      "- e:/workspace",
    ].join("\n");

    expect(normalizeSystemPromptForFingerprint(promptA)).toBe(normalizeSystemPromptForFingerprint(promptB));
    expect(normalizeSystemPromptForFingerprint(promptA)).not.toContain("memory revision A");
    expect(normalizeSystemPromptForFingerprint(promptA)).not.toContain("appearance revision A");
  });

  it("ignores English memory and appearance sections before workspace instructions", () => {
    const promptA = [
      "System base.",
      "## Memory Rules",
      "memory revision A",
      "",
      "Current date and time: Monday, June 8, 2026",
      "",
      "## Your Appearance",
      "appearance revision A",
      "",
      "## Workspace Instructions",
      "- stay in scope",
    ].join("\n");
    const promptB = [
      "System base.",
      "## Memory Rules",
      "memory revision B",
      "",
      "Current date and time: Thursday, June 11, 2026",
      "",
      "## Your Appearance",
      "appearance revision B",
      "",
      "## Workspace Instructions",
      "- stay in scope",
    ].join("\n");

    expect(normalizeSystemPromptForFingerprint(promptA)).toBe(normalizeSystemPromptForFingerprint(promptB));
  });
});

describe("buildSessionCapabilityDrift", () => {
  it("reports no drift when frozen and live sets match", () => {
    const drift = buildSessionCapabilityDrift({
      frozenToolNames: ["read", "bash"],
      liveToolNames: ["bash", "read"],
      frozenSystemPrompt: "p",
      liveSystemPrompt: "p",
    });
    expect(drift.hasDrift).toBe(false);
    expect(drift.fingerprint).toBe(drift.frozenFingerprint);
  });

  it("classifies added, removed, invalid, and prompt drift", () => {
    const drift = buildSessionCapabilityDrift({
      frozenToolNames: ["read", "browser"],
      liveToolNames: ["read", "office"],
      invalidToolNames: ["retired_tool"],
      frozenSystemPrompt: "old persona",
      liveSystemPrompt: "new persona",
    });
    expect(drift.hasDrift).toBe(true);
    expect(drift.addedToolNames).toEqual(["office"]);
    expect(drift.removedToolNames).toEqual(["browser"]);
    expect(drift.invalidToolNames).toEqual(["retired_tool"]);
    expect(drift.promptChanged).toBe(true);
  });
});

describe("repairRestoredToolSnapshotDetailed", () => {
  it("returns the same kept list as repairRestoredToolSnapshot plus the dropped names", () => {
    const snapshot = ["read", "retired_tool", "bash", "another_dead"];
    const all = ["read", "bash", "edit"];
    const detailed = repairRestoredToolSnapshotDetailed(snapshot, all, { coreToolNames: [] });
    expect(detailed.toolNames).toEqual(repairRestoredToolSnapshot(snapshot, all, { coreToolNames: [] }));
    expect(detailed.droppedToolNames).toEqual(["retired_tool", "another_dead"]);
  });

  it("does not double-report duplicated dead names", () => {
    const detailed = repairRestoredToolSnapshotDetailed(
      ["dead", "dead", "read"],
      ["read"],
      { coreToolNames: [] },
    );
    expect(detailed.droppedToolNames).toEqual(["dead"]);
  });
});
