// @ts-nocheck
import { describe, expect, it } from "vitest";
import { formatSessionLine, selectSession } from "../cli/chat.ts";

describe("CLI chat session helpers", () => {
  const sessions = [
    { path: "/a.json", title: "Alpha", agentName: "G-SAP", modified: "2026-05-19T10:00:00.000Z" },
    { path: "/b.json", firstMessage: "Beta first", agentId: "agent-b", modified: null },
  ];

  it("selects the latest session by default", () => {
    expect((selectSession as any)(sessions)).toBe(sessions[0]);
  });

  it("selects one-based session indices", () => {
    expect(selectSession(sessions, "2")).toBe(sessions[1]);
  });

  it("selects exact session paths", () => {
    expect(selectSession(sessions, "/b.json")).toBe(sessions[1]);
  });

  it("formats recent session rows for terminal display", () => {
    const line = formatSessionLine(sessions[0], 1);
    expect(line).toContain("Alpha");
    expect(line).toContain("G-SAP");
  });
});
