// @ts-nocheck
import { describe, expect, it } from "vitest";
import { createHostApi } from "../lib/workflow/host-api.ts";
import { createLimiter } from "../lib/workflow/concurrency.ts";

function setup(extra = {}) {
  const events = [];
  const api = createHostApi({ baseIsoOpts: {}, limiter: createLimiter({ maxConcurrent: 1, maxTotal: 100 }),
    executeIsolated: async () => ({ replyText: "ok" }), onAgentEvent: e => events.push(e), ...extra });
  return { api, events };
}
describe("workflow failure semantics", () => {
  it("parallel rejects a failed branch rather than returning null and done", async () => {
    const { api, events } = setup();
    await expect(api.parallel([() => "ok", () => { throw new Error("branch failed"); }])).rejects.toThrow("branch failed");
    expect(events.at(-1)).toMatchObject({ phase: "fail" });
  });
  it("pipeline rejects failed stages rather than reporting done", async () => {
    const { api, events } = setup();
    await expect(api.pipeline([1], () => { throw new Error("stage failed"); })).rejects.toThrow("stage failed");
    expect(events.at(-1)).toMatchObject({ phase: "fail" });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowJournal } from "../lib/workflow/journal.ts";
import { runWorkflowScript } from "../lib/workflow/sandbox.ts";

it("collect-errors finishes independent branches and preserves indexed results", async () => {
  const { api, events } = setup();
  let finished = false;
  let error;
  try {
    await api.parallel([() => { throw new Error("broken"); }, async () => { finished = true; return "artifact"; }], { failurePolicy: "collect-errors" });
  } catch (e) { error = e; }
  expect(finished).toBe(true);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.results[1]).toEqual({ status: "fulfilled", value: "artifact" });
  expect(events.at(-1)).toMatchObject({ phase: "fail" });
});

it("cancellation stops pipeline stages and queued agents", async () => {
  const controller = new AbortController();
  const calls = [];
  const { api } = setup({ signal: controller.signal, executeIsolated: async p => { calls.push(p); controller.abort(); return { replyText: "done" }; } });
  await expect(api.parallel([() => api.agent("first"), () => api.agent("second")])).rejects.toThrow(/aborted/);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(calls).toEqual(["first"]);
  const next = setup({ signal: controller.signal });
  await expect(next.api.pipeline([1], () => { throw new Error("should not run"); })).rejects.toThrow(/aborted/);
});

it("catching aggregate errors cannot mark a partially failed script successful", async () => {
  const { api } = setup();
  await expect(runWorkflowScript("export const meta = { name: 'test', description: 'test' }; try { await parallel([() => { throw new Error('broken'); }], { failurePolicy: 'collect-errors' }); } catch {} return 'done';", api)).rejects.toThrow(/branches failed/);
});

it("persists dispatch before a side effect and blocks retry after external success/client timeout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-recovery-"));
  const file = path.join(dir, "run.jsonl");
  try {
    const journal = new WorkflowJournal(file);
    journal.setMetadata({ runId: "run-1", originRunId: "run-1", definitionKey: "fixed" });
    let writes = 0;
    const { api } = setup({ journal, executeIsolated: async () => {
      expect(WorkflowJournal.load(file)._entries.get(1).status).toBe("running");
      writes++;
      throw new Error("client timeout after write");
    } });
    await expect(api.agent("upload", { access: "write" })).rejects.toThrow(/timeout/);
    const replayJournal = WorkflowJournal.load(file);
    expect(replayJournal._entries.get(1)).toMatchObject({ status: "unknown", actionId: expect.stringContaining("run-1:1:") });
    const retry = setup({ replayJournal, executeIsolated: async () => { writes++; return { replyText: "bad" }; } });
    await expect(retry.api.agent("upload", { access: "write" })).rejects.toThrow(/unknown external result/);
    expect(writes).toBe(1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("blocks a crash-left running write but permits retry of explicitly read-only work", async () => {
  const journal = new WorkflowJournal(null);
  const key = WorkflowJournal.computeKey("read", { access: "read" });
  journal.record(1, key, null, "running", { access: "read" });
  expect(journal.tryReplay(1, key)).toBeNull();
  const write = new WorkflowJournal(null);
  write.record(1, "k", null, "running", { access: "write" });
  expect(() => write.tryReplay(1, "changed")).toThrow(/unknown external result/);
});

it("fails closed before dispatch when journal cannot be persisted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-journal-"));
  let calls = 0;
  try {
    const journal = new WorkflowJournal(dir); // A directory is not an appendable journal.
    const { api } = setup({ journal, executeIsolated: async () => { calls++; return {}; } });
    await expect(api.agent("write", { access: "write" })).rejects.toThrow();
    expect(calls).toBe(0);
    expect(journal.totalEntries).toBe(0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("snapshots metadata and rejects definition drift", () => {
  const journal = new WorkflowJournal(null);
  const metadata = { runId: "run", definitionKey: "version-1" };
  journal.setMetadata(metadata);
  metadata.definitionKey = "changed";
  expect(journal.metadata.definitionKey).toBe("version-1");
  expect(() => journal.setMetadata(metadata)).toThrow(/immutable/);
  expect(() => journal.assertCompatible(metadata)).toThrow(/changed/);
  expect(() => journal.assertCompatible({ definitionKey: "version-1" })).not.toThrow();
});

it("canonicalizes nested option ordering", () => {
  expect(WorkflowJournal.computeKey("task", { schema: { a: 1, b: 2 }, access: "read" }))
    .toBe(WorkflowJournal.computeKey("task", { access: "read", schema: { b: 2, a: 1 } }));
});

it("retains unvisited successful writes across a failed recovery chain", () => {
  const original = new WorkflowJournal(null);
  original.setMetadata({ originRunId: "origin", runId: "origin", definitionKey: "same" });
  original.record(3, "saved-write", "artifact", "ok", { access: "write" });
  const resumed = new WorkflowJournal(null);
  resumed.setMetadata({ originRunId: "origin", runId: "retry", definitionKey: "same" });
  resumed.inherit(original);
  expect(resumed.tryReplay(3, "saved-write")).toEqual({ hit: true, result: "artifact" });
  expect(resumed.actionId(3, "saved-write")).toBe(original.actionId(3, "saved-write"));
});

it("a checkpoint can have only one recovery successor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-claim-"));
  try {
    const journal = new WorkflowJournal(path.join(dir, "run.jsonl"));
    journal.claimRecovery("next-run");
    expect(() => journal.claimRecovery("duplicate-run")).toThrow(/already resumed/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "run.jsonl.resume"), "utf8"))).toEqual({ nextRunId: "next-run" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("refuses recovery while the source owner is still running", () => {
  const journal = new WorkflowJournal(null);
  journal.setMetadata({ definitionKey: "same", ownerPid: process.pid });
  expect(() => journal.assertCompatible({ definitionKey: "same" })).toThrow(/still be active/);
  journal.finish();
  expect(() => journal.assertCompatible({ definitionKey: "same" })).not.toThrow();
});

it("fail-fast does not dispatch an agent queued behind a failed branch", async () => {
  const calls = [];
  const { api } = setup({ executeIsolated: async prompt => { calls.push(prompt); throw new Error("first failed"); } });
  await expect(api.parallel([() => api.agent("first"), () => api.agent("queued")])).rejects.toThrow(/first failed/);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(calls).toEqual(["first"]);
});

import { createWorkflowExecutionLimits } from "../lib/workflow/limits.ts";

it("enforces the actual-dispatch step cap including concurrent queued agents", async () => {
  const calls = [];
  const { api } = setup({ args: { maxSteps: 1 }, executeIsolated: async prompt => { calls.push(prompt); return { replyText: "ok" }; } });
  await expect(api.parallel([() => api.agent("first"), () => api.agent("second")], { failurePolicy: "collect-errors" })).rejects.toThrow(/branches failed/);
  expect(calls).toEqual(["first"]);
});

it("checks the duration limit between pipeline stages before later writes", async () => {
  const limits = createWorkflowExecutionLimits({ maxDurationMs: 100 });
  let nextStage = false;
  const { api } = setup({ executionLimits: limits });
  await expect(api.pipeline([1], value => { limits.startedAt = Date.now() - 101; return value; }, () => { nextStage = true; })).rejects.toThrow(/duration budget/);
  expect(nextStage).toBe(false);
});

it("shared nested execution limits cannot reset the dispatch cap", async () => {
  const executionLimits = createWorkflowExecutionLimits({ maxSteps: 1 });
  const parent = setup({ executionLimits });
  const child = setup({ executionLimits });
  await parent.api.agent("parent");
  await expect(child.api.agent("child")).rejects.toThrow(/step budget/);
});

it("rejects invalid limits rather than silently disabling caps", () => {
  for (const args of [{ maxSteps: 0 }, { maxSteps: 1001 }, { maxDurationMs: -1 }, { maxDurationMs: Infinity }, { budgetTokens: 0 }]) {
    expect(() => createWorkflowExecutionLimits(args)).toThrow(/must be/);
  }
});
