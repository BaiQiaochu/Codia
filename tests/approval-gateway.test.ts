// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { createApprovalGateway, createModelApprovalReviewer } from "../lib/approval-gateway.js";

function request(overrides = {}) {
  return {
    id: "approval-1",
    kind: "tool_action",
    sessionPath: "/tmp/codia/session.jsonl",
    agentId: "codia",
    toolName: "write",
    actionName: "execute",
    params: { path: "notes.md" },
    target: { type: "file", label: "notes.md" },
    blastRadius: "workspace",
    reversibility: "easy",
    ...overrides,
  };
}

describe("ApprovalGateway", () => {
  it("hard-denies git push before model reviewers can approve it", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({ action: "allow", reason: "looks fine" }));
    const largeToolModelReviewer = vi.fn(async () => ({ action: "allow", reason: "explicitly authorized" }));
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request({
      toolName: "bash",
      params: { command: "git push origin main" },
      target: { type: "command", label: "git push origin main" },
      blastRadius: "external",
      reversibility: "hard",
    }));

    expect(decision).toMatchObject({
      action: "hard_deny",
      reviewer: "policy",
      risk: "critical",
      ruleIds: ["privacy-push-required"],
    });
    expect(decision.reason).toContain("/privacy-push");
    expect(smallToolModelReviewer).not.toHaveBeenCalled();
    expect(largeToolModelReviewer).not.toHaveBeenCalled();
  });

  it("hard-denies git push with global git options before model reviewers can approve it", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({ action: "allow", reason: "looks fine" }));
    const gateway = createApprovalGateway({ smallToolModelReviewer });

    await expect(gateway.review(request({
      toolName: "bash",
      params: { command: "git -C /repo push origin main" },
      target: { type: "command", label: "git -C /repo push origin main" },
    }))).resolves.toMatchObject({
      action: "hard_deny",
      reviewer: "policy",
      ruleIds: ["privacy-push-required"],
    });
    await expect(gateway.review(request({
      toolName: "bash",
      params: { command: "git --git-dir /repo/.git push origin --tags" },
      target: { type: "command", label: "git --git-dir /repo/.git push origin --tags" },
    }))).resolves.toMatchObject({
      action: "hard_deny",
      reviewer: "policy",
      ruleIds: ["push-tags-blocked"],
    });
    await expect(gateway.review(request({
      toolName: "bash",
      params: { command: "git -c user.name=codia push --force-with-lease origin main" },
      target: { type: "command", label: "git -c user.name=codia push --force-with-lease origin main" },
    }))).resolves.toMatchObject({
      action: "hard_deny",
      reviewer: "policy",
      ruleIds: ["force-push-blocked"],
    });

    expect(smallToolModelReviewer).not.toHaveBeenCalled();
  });

  it("hard-denies git push nested inside shell commands before reviewers run", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({ action: "allow", reason: "looks fine" }));
    const gateway = createApprovalGateway({ smallToolModelReviewer });

    await expect(gateway.review(request({
      toolName: "bash",
      params: { command: "pwsh -NoProfile -Command \"git.exe push --tags\"" },
      target: { type: "command", label: "pwsh -NoProfile -Command \"git.exe push --tags\"" },
    }))).resolves.toMatchObject({
      action: "hard_deny",
      reviewer: "policy",
      ruleIds: ["push-tags-blocked"],
    });
    expect(smallToolModelReviewer).not.toHaveBeenCalled();
  });

  it("does not hard-deny unrelated commands that happen to use --force", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({ action: "allow", reason: "not a git push", risk: "medium" }));
    const gateway = createApprovalGateway({ smallToolModelReviewer });

    const decision = await gateway.review(request({
      toolName: "bash",
      params: { command: "npm install left-pad@1.3.0 --force" },
      target: { type: "command", label: "npm install left-pad@1.3.0 --force" },
    }));

    expect(decision).toMatchObject({
      action: "allow",
      reviewer: "small_tool_model",
      reason: "not a git push",
    });
    expect(smallToolModelReviewer).toHaveBeenCalledOnce();
  });

  it("escalates from the small tool-model reviewer to the large tool-model reviewer", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({
      action: "escalate",
      reason: "needs blast-radius review",
    }));
    const largeToolModelReviewer = vi.fn(async () => ({
      action: "ask_user",
      reason: "folder access is too broad",
      risk: "high",
    }));
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request({
      kind: "session_folder",
      params: { action: "add", folder: "/Users/test/Desktop" },
      target: { type: "directory", label: "/Users/test/Desktop", path: "/Users/test/Desktop" },
      blastRadius: "device",
      reversibility: "moderate",
    }));

    expect(smallToolModelReviewer).toHaveBeenCalledOnce();
    expect(largeToolModelReviewer).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({
      action: "ask_user",
      reviewer: "large_tool_model",
      reason: "folder access is too broad",
      risk: "high",
    });
  });

  it("lets a large reviewer override a non-low-risk small reviewer decision", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({
      action: "ask_user",
      reason: "small reviewer is unsure",
      risk: "medium",
    }));
    const largeToolModelReviewer = vi.fn(async () => ({
      action: "allow",
      reason: "visible user intent and workspace target match",
      risk: "low",
    }));
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request());

    expect(smallToolModelReviewer).toHaveBeenCalledOnce();
    expect(largeToolModelReviewer).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({
      action: "allow",
      reviewer: "large_tool_model",
      reason: "visible user intent and workspace target match",
    });
  });

  it("fails closed to ask_user when no reviewer can decide", async () => {
    const gateway = createApprovalGateway();

    const decision = await gateway.review(request());

    expect(decision).toMatchObject({
      action: "ask_user",
      reviewer: "policy",
      risk: "medium",
    });
    expect(decision.reason).toContain("reviewer unavailable");
  });

  it("builds a utility-model reviewer that returns a normalized JSON decision", async () => {
    const resolveUtilityConfig = vi.fn(() => ({
      utility: { id: "small-reviewer", provider: "test" },
      api: "openai-completions",
      api_key: "test-key",
      base_url: "https://example.test",
    }));
    const callText = vi.fn(async () => JSON.stringify({
      action: "allow",
      reason: "workspace edit matches the user request",
      risk: "low",
    }));
    const reviewer = createModelApprovalReviewer({
      role: "utility",
      resolveUtilityConfig,
      callText,
    });

    const decision = await reviewer({
      request: request(),
      userIntentSummary: "Edit notes.md",
      explicitUserAuthorization: "",
      sessionPermissionMode: "auto",
      trustEnvironment: { cwd: "/tmp/codia", workspaceFolders: ["/tmp/codia"] },
      recentApprovalHistory: [],
    });

    expect(resolveUtilityConfig).toHaveBeenCalledOnce();
    expect(callText).toHaveBeenCalledWith(expect.objectContaining({
      api: "openai-completions",
      apiKey: "test-key",
      baseUrl: "https://example.test",
      model: { id: "small-reviewer", provider: "test" },
      maxTokens: 220,
      temperature: 0,
    }));
    expect(decision).toMatchObject({
      action: "allow",
      reason: "workspace edit matches the user request",
      risk: "low",
    });
  });
});
