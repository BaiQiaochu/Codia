import { describe, expect, it, vi } from "vitest";
import { evaluateToolSafetyPolicy } from "../lib/permission/safety-policy.ts";

function request(overrides = {}) {
  return {
    id: "approval-1",
    kind: "tool_action",
    sessionPath: "/tmp/gsap/session.jsonl",
    agentId: "gsap",
    toolName: "bash",
    actionName: "execute",
    params: { command: "git push origin main" },
    target: { type: "command", label: "git push origin main" },
    blastRadius: "external",
    reversibility: "hard",
    ...overrides,
  };
}

describe("SafetyPolicy", () => {
  it("blocks git push as a hard invariant independent of approvals", () => {
    const decision = evaluateToolSafetyPolicy(request());

    expect(decision).toMatchObject({
      action: "block",
      code: "ACTION_BLOCKED_BY_SAFETY_POLICY",
      reviewer: "safety_policy",
      risk: "critical",
      ruleIds: ["privacy-push-required"],
    });
    expect(decision?.reason).toContain("/privacy-push");
  });

  it("detects git push through global git options", () => {
    expect(evaluateToolSafetyPolicy(request({
      params: { command: "git -C /repo push origin main" },
      target: { type: "command", label: "git -C /repo push origin main" },
    }))).toMatchObject({
      action: "block",
      ruleIds: ["privacy-push-required"],
    });
    expect(evaluateToolSafetyPolicy(request({
      params: { command: "git --git-dir /repo/.git push origin --tags" },
      target: { type: "command", label: "git --git-dir /repo/.git push origin --tags" },
    }))).toMatchObject({
      action: "block",
      ruleIds: ["push-tags-blocked"],
    });
    expect(evaluateToolSafetyPolicy(request({
      params: { command: "git -c user.name=gsap push --force-with-lease origin main" },
      target: { type: "command", label: "git -c user.name=gsap push --force-with-lease origin main" },
    }))).toMatchObject({
      action: "block",
      ruleIds: ["force-push-blocked"],
    });
  });

  it("detects git push nested inside common shell command arguments", () => {
    expect(evaluateToolSafetyPolicy(request({
      params: { command: "bash -lc \"cd /repo && git push origin main\"" },
      target: { type: "command", label: "bash -lc \"cd /repo && git push origin main\"" },
    }))).toMatchObject({
      action: "block",
      ruleIds: ["privacy-push-required"],
    });
    expect(evaluateToolSafetyPolicy(request({
      params: { command: "pwsh -NoProfile -Command \"git.exe push --tags\"" },
      target: { type: "command", label: "pwsh -NoProfile -Command \"git.exe push --tags\"" },
    }))).toMatchObject({
      action: "block",
      ruleIds: ["push-tags-blocked"],
    });
    expect(evaluateToolSafetyPolicy(request({
      params: { command: "cmd.exe /c \"git push --force origin main\"" },
      target: { type: "command", label: "cmd.exe /c \"git push --force origin main\"" },
    }))).toMatchObject({
      action: "block",
      ruleIds: ["force-push-blocked"],
    });
  });

  it("does not block unrelated commands that happen to use --force", () => {
    const marker = vi.fn();
    const decision = evaluateToolSafetyPolicy(request({
      params: { command: "npm install left-pad@1.3.0 --force" },
      target: { type: "command", label: "npm install left-pad@1.3.0 --force" },
    }));

    if (!decision) marker();
    expect(decision).toBeNull();
    expect(marker).toHaveBeenCalledOnce();
  });
});
