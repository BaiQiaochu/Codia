// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addBookmarkEntry,
  addChannelMember,
  appendMessage,
  parseChannel,
  readBookmarks,
  updateBookmark,
} from "../lib/channels/channel-store.ts";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-store-"));
}

describe("channel-store write locking", () => {
  let tmpDir;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      tmpDir = null;
    }
  });

  it("preserves appended messages after a frontmatter rewrite", () => {
    tmpDir = mktemp();
    const channelPath = path.join(tmpDir, "crew.md");
    fs.writeFileSync(
      channelPath,
      [
        "---",
        "members: [alice]",
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );

    addChannelMember(channelPath, "bob");
    appendMessage(channelPath, "alice", "hello from lock test");

    const content = fs.readFileSync(channelPath, "utf-8");
    const { meta, messages } = parseChannel(content);
    expect(meta.members).toContain("alice");
    expect(meta.members).toContain("bob");
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("hello from lock test");
  });

  it("preserves bookmark updates across read-modify-write operations", () => {
    tmpDir = mktemp();
    const bookmarksPath = path.join(tmpDir, "channels.md");
    fs.writeFileSync(
      bookmarksPath,
      [
        "# 频道",
        "",
        "- ch_alpha (last: never)",
        "",
      ].join("\n"),
      "utf-8",
    );

    updateBookmark(bookmarksPath, "ch_alpha", "2026-04-23 12:34:56");
    addBookmarkEntry(bookmarksPath, "ch_beta");

    const bookmarks = readBookmarks(bookmarksPath);
    expect(bookmarks.get("ch_alpha")).toBe("2026-04-23 12:34:56");
    expect(bookmarks.get("ch_beta")).toBe("never");
  });
});
