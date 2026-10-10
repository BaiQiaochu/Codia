import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowJournal } from "../lib/workflow/journal.js";

function tmpJournalPath() {
  return path.join(os.tmpdir(), `codia-test-journal-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function cleanup(filePath) {
  try {
    if (filePath) fs.unlinkSync(filePath);
  } catch {}
}

describe("WorkflowJournal", () => {
  let paths = [];

  afterEach(() => {
    paths.forEach(cleanup);
    paths = [];
  });

  it("computeKey is deterministic and ignores non-deterministic option fields", () => {
    const k1 = WorkflowJournal.computeKey("prompt", { model: "a" });
    const k2 = WorkflowJournal.computeKey("prompt", {
      model: "a",
      signal: new AbortController().signal,
      onSessionReady: () => {},
    });

    expect(k1).toBe(k2);
    expect(k1).toHaveLength(16);
  });

  it("persists to JSONL and loads back by node sequence", () => {
    const journalPath = tmpJournalPath();
    paths.push(journalPath);
    const journal = new WorkflowJournal(journalPath);
    const key1 = WorkflowJournal.computeKey("a", {});
    const key2 = WorkflowJournal.computeKey("b", {});

    journal.record(2, key2, { data: 2 });
    journal.record(1, key1, "one");

    const loaded = WorkflowJournal.load(journalPath);
    expect(loaded.totalEntries).toBe(2);
    expect(loaded.tryReplay(1, key1)).toEqual({ hit: true, result: "one" });
    expect(loaded.tryReplay(2, key2)).toEqual({ hit: true, result: { data: 2 } });
  });

  it("invalidates subsequent replay when a node key changes", () => {
    const journalPath = tmpJournalPath();
    paths.push(journalPath);
    const journal = new WorkflowJournal(journalPath);
    const key1 = WorkflowJournal.computeKey("a", {});
    const key2 = WorkflowJournal.computeKey("b", {});
    const key3 = WorkflowJournal.computeKey("c", {});
    journal.record(1, key1, "one");
    journal.record(2, key2, "two");
    journal.record(3, key3, "three");

    const replay = WorkflowJournal.load(journalPath);
    expect(replay.tryReplay(1, key1)).toEqual({ hit: true, result: "one" });
    expect(replay.tryReplay(2, WorkflowJournal.computeKey("changed", {}))).toBeNull();
    expect(replay.tryReplay(3, key3)).toBeNull();
    expect(replay.replayHits).toBe(1);
  });

  it("skips error entries and corrupt journal lines", () => {
    const journalPath = tmpJournalPath();
    paths.push(journalPath);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const key = WorkflowJournal.computeKey("fail", {});
    fs.writeFileSync(journalPath, [
      JSON.stringify({ nodeSeq: 1, key, result: null, status: "error", ts: Date.now() }),
      "not json",
      "",
    ].join("\n"));

    const replay = WorkflowJournal.load(journalPath);
    expect(replay.tryReplay(1, key)).toBeNull();
  });
});
