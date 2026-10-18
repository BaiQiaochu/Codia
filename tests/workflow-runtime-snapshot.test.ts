// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { createResolvedRuntimeSnapshot, assertResolvedRuntimeSnapshot } from "../lib/workflow/runtime-snapshot.ts";
import { createHostApi } from "../lib/workflow/host-api.ts";
import { WorkflowJournal } from "../lib/workflow/journal.ts";
import { createLimiter } from "../lib/workflow/concurrency.ts";

const config = { implementation: "build-a", model: { id: "model-a", provider: "p", baseUrl: "https://provider" }, thinkingLevel: "medium", systemPrompt: "original prompt", tools: [{ name: "upload", parameters: { type: "object" }, execute: () => "original" }], agentConfig: { apiKey: "secret-test-value" }, scope: { cwd: "/work" } };
const snapshot = () => createResolvedRuntimeSnapshot(config);
function host(journal, replayJournal, current = snapshot(), calls = vi.fn()) {
  return createHostApi({
    journal, replayJournal, requireRuntimeSnapshot: true,
    baseIsoOpts: { agentId: "a" }, limiter: createLimiter({ maxConcurrent: 4, maxTotal: 100 }),
    executeIsolated: async (_prompt, opts) => {
      const result = opts.workflowRuntimeGuard(current);
      if (result?.replay) return { workflowReplay: true };
      calls();
      return { replyText: "confirmed" };
    },
  });
}

describe("resolved workflow runtime pinning", () => {
  it.each(["model", "systemPrompt", "tools", "agentConfig", "scope", "implementation", "thinkingLevel"])("rejects changed %s", field => {
    expect(() => assertResolvedRuntimeSnapshot(snapshot(), createResolvedRuntimeSnapshot({ ...config, [field]: "changed" }))).toThrow(/runtime changed/);
  });
  it("never stores configuration secrets or prompt text", () => {
    const data = JSON.stringify(snapshot());
    expect(data).not.toContain("secret-test-value");
    expect(data).not.toContain("original prompt");
    expect(data).not.toContain("https://provider");
  });
  it("pins running actions before effects and validates versions before replaying successful writes", async () => {
    const journal = new WorkflowJournal(null);
    const effects = vi.fn(() => expect(journal.getEntry(1)).toMatchObject({ status: "running", runtimeSnapshot: snapshot() }));
    await expect(host(journal, null, snapshot(), effects).agent("upload", { access: "write" })).resolves.toBe("confirmed");
    expect(effects).toHaveBeenCalledTimes(1);
    const next = new WorkflowJournal(null);
    next.inherit(journal);
    await expect(host(next, journal, snapshot(), effects).agent("upload", { access: "write" })).resolves.toBe("confirmed");
    expect(effects).toHaveBeenCalledTimes(1);
    const changed = createResolvedRuntimeSnapshot({ ...config, systemPrompt: "new instructions" });
    await expect(host(new WorkflowJournal(null), journal, changed, effects).agent("upload", { access: "write" })).rejects.toThrow(/runtime changed/);
    expect(effects).toHaveBeenCalledTimes(1);
  });
  it("rejects version drift on retryable reads and legacy unpinned successes", async () => {
    const journal = new WorkflowJournal(null);
    const key = WorkflowJournal.computeKey("read", { access: "read" });
    journal.record(1, key, null, "error", { access: "read", runtimeSnapshot: snapshot() });
    const effects = vi.fn();
    await expect(host(new WorkflowJournal(null), journal, { ...snapshot(), tools: "changed" }, effects).agent("read", { access: "read" })).rejects.toThrow(/runtime changed/);
    journal.record(1, key, "old", "ok", { access: "read" });
    await expect(host(new WorkflowJournal(null), journal, snapshot(), effects).agent("read", { access: "read" })).rejects.toThrow(/runtime changed/);
    expect(effects).not.toHaveBeenCalled();
  });
  it("fails closed if executor ignores the required runtime guard", async () => {
    const api = createHostApi({ requireRuntimeSnapshot: true, baseIsoOpts: {}, limiter: createLimiter({ maxConcurrent: 1, maxTotal: 1 }), executeIsolated: async () => ({ replyText: "ignored" }) });
    await expect(api.agent("read")).rejects.toThrow(/did not enforce/);
  });
});

describe("workflow distribution identity", () => {
  it("supports pruned official bundles and detects hot chunk changes without stale caching", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { getWorkflowImplementationDigest } = await import("../lib/workflow/runtime-snapshot.ts");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-bundle-"));
    try {
      fs.mkdirSync(path.join(root, "bundle"));
      fs.writeFileSync(path.join(root, "bundle", "index.js"), "export const runtime = 1;");
      fs.writeFileSync(path.join(root, "bundle", "core-chunk.js"), "export const tool = 1;");
      fs.writeFileSync(path.join(root, "package.json"), '{"name":"codia-server"}');
      fs.writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}');
      const runtime = path.join(root, "bundle", "core-chunk.js");
      const first = getWorkflowImplementationDigest(root, runtime);
      expect(getWorkflowImplementationDigest(root, runtime)).toBe(first);
      fs.writeFileSync(runtime, "export const tool = 2;");
      expect(getWorkflowImplementationDigest(root, runtime)).not.toBe(first);
      fs.unlinkSync(path.join(root, "package-lock.json"));
      expect(() => getWorkflowImplementationDigest(root, runtime)).toThrow();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("bounded workflow trusted context", () => {
  it("does not allow node options to broaden model or tool authorization", async () => {
    const budget = { assertActive() {} };
    const executionModel = { id: "pinned", provider: "local" };
    const executeIsolated = vi.fn(async () => ({ replyText: "ok" }));
    const api = createHostApi({
      baseIsoOpts: { runBudget: budget, model: executionModel, agentId: "owner", toolFilter: ["safe_tool"], builtinFilter: ["read"] },
      limiter: createLimiter({ maxConcurrent: 1, maxTotal: 5 }), executeIsolated,
      resolveAgentId: () => "other",
    });
    await api.agent("work", { model: { id: "expensive" }, agentType: "other", toolFilter: "*" });
    expect(executeIsolated.mock.calls[0][1]).toMatchObject({
      runBudget: budget, model: executionModel, agentId: "owner", toolFilter: ["safe_tool"], builtinFilter: ["read"],
    });
    expect(executeIsolated.mock.calls[0][1].runBudget).toBe(budget);
  });
  it("fails closed when a bounded workflow omits explicit allowlists", async () => {
    const executeIsolated = vi.fn();
    const api = createHostApi({ baseIsoOpts: { runBudget: {} }, limiter: createLimiter({ maxConcurrent: 1, maxTotal: 5 }), executeIsolated });
    await expect(api.agent("work")).rejects.toThrow(/explicit tool allowlists/);
    expect(executeIsolated).not.toHaveBeenCalled();
  });
});
