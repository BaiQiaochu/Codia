import { describe, expect, it } from "vitest";
import { resolveAgentParam } from "../lib/tools/agent-id-resolver.js";

describe("resolveAgentParam", () => {
  const agents = [
    { id: "gsap", name: "G-SAP" },
    { id: "reviewer", name: "Reviewer" },
    { id: "planner", name: "Planner" },
  ];

  it("returns undefined when no agent was requested", () => {
    expect(resolveAgentParam(agents, undefined)).toEqual({ ok: true, agentId: undefined });
    expect(resolveAgentParam(agents, "")).toEqual({ ok: true, agentId: undefined });
  });

  it("matches strict ids before display names", () => {
    const tricky = [
      { id: "Reviewer", name: "Display Id Collision" },
      { id: "reviewer", name: "Reviewer" },
    ];
    expect(resolveAgentParam(tricky, "Reviewer")).toEqual({ ok: true, agentId: "Reviewer" });
  });

  it("falls back to a unique display name", () => {
    expect(resolveAgentParam(agents, "Reviewer")).toEqual({ ok: true, agentId: "reviewer" });
  });

  it("rejects unknown or ambiguous display names", () => {
    expect(resolveAgentParam(agents, "Missing")).toMatchObject({ ok: false, ambiguous: false, byName: [] });

    const ambiguous = resolveAgentParam([
      { id: "a", name: "Same" },
      { id: "b", name: "Same" },
    ], "Same");
    expect(ambiguous).toMatchObject({ ok: false, ambiguous: true });
    expect(ambiguous.byName).toHaveLength(2);
  });
});
