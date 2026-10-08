import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionManager as AdaptedSessionManager } from "../lib/pi-sdk/index.ts";
import { createSessionPathValidators } from "../core/session-paths.ts";
import * as messageUtils from "../core/message-utils.ts";

// Foreign paths are a lexical simulation only. Keep Node's native path and
// real filesystem untouched so the actual SDK can resolve its own package.
const {
  isValidSessionPath,
  isActiveSessionPath,
  isArchivedDesktopSessionPath,
  isDesktopSessionPath,
} = createSessionPathValidators({ pathImpl: path.win32, normalizePath: path.win32.resolve });

describe("Windows session path validation", () => {
  it("accepts the same path when only drive and user-directory casing differs", () => {
    const agentsDir = "C:\\Users\\Alice\\.gsap\\agents";
    const sessionPath = "c:\\users\\alice\\.gsap\\agents\\hana\\sessions\\old.jsonl";

    expect(isValidSessionPath(sessionPath, agentsDir)).toBe(true);
    expect(isActiveSessionPath(sessionPath, agentsDir)).toBe(true);
    expect(isDesktopSessionPath(sessionPath, agentsDir)).toBe(true);
  });

  it("treats archived desktop sessions as desktop but not active", () => {
    const agentsDir = "C:\\Users\\Alice\\.gsap\\agents";
    const sessionPath = "c:\\users\\alice\\.gsap\\agents\\hana\\sessions\\archived\\old.jsonl";

    expect(isValidSessionPath(sessionPath, agentsDir)).toBe(true);
    expect(isActiveSessionPath(sessionPath, agentsDir)).toBe(false);
    expect(isArchivedDesktopSessionPath(sessionPath, agentsDir)).toBe(true);
    expect(isDesktopSessionPath(sessionPath, agentsDir)).toBe(true);
  });

  it("still rejects sibling paths that only share a textual prefix", () => {
    const agentsDir = "C:\\Users\\Alice\\.gsap\\agents";
    const sessionPath = "C:\\Users\\Alice\\.gsap\\agents-evil\\hana\\sessions\\old.jsonl";

    expect(isValidSessionPath(sessionPath, agentsDir)).toBe(false);
    expect(isActiveSessionPath(sessionPath, agentsDir)).toBe(false);
  });

  it.each([
    "C:\\agents\\..\\outside\\session.jsonl",
    "D:\\agents\\hana\\sessions\\session.jsonl",
    "\\\\other-server\\share\\agents\\hana\\sessions\\session.jsonl",
  ])("rejects traversal and unrelated volumes: %s", (sessionPath) => {
    expect(isValidSessionPath(sessionPath, "C:\\agents")).toBe(false);
    expect(isDesktopSessionPath(sessionPath, "C:\\agents")).toBe(false);
  });

  it("supports a UNC base without admitting another share", () => {
    const base = "\\\\server\\share\\agents";
    expect(isActiveSessionPath("\\\\SERVER\\SHARE\\agents\\hana\\sessions\\one.jsonl", base)).toBe(true);
    expect(isValidSessionPath("\\\\server\\other\\agents\\hana\\sessions\\one.jsonl", base)).toBe(false);
  });

  it.each(["hana\\activity\\one.jsonl", "hana\\sessions\\one.json", "hana\\sessions\\extra\\one.jsonl"])(
    "rejects non-desktop session layouts: %s", (relativePath) => {
      expect(isDesktopSessionPath(path.win32.join("C:\\agents", relativePath), "C:\\agents")).toBe(false);
    },
  );

  it("retains case-sensitive POSIX containment alongside the Windows simulation", () => {
    const posix = createSessionPathValidators({ pathImpl: path.posix, normalizePath: path.posix.resolve });
    expect(posix.isActiveSessionPath("/home/alice/agents/hana/sessions/one.jsonl", "/home/alice/agents")).toBe(true);
    expect(posix.isValidSessionPath("/home/ALICE/agents/hana/sessions/one.jsonl", "/home/alice/agents")).toBe(false);
    expect(posix.isValidSessionPath("/home/alice/agents-evil/one.jsonl", "/home/alice/agents")).toBe(false);
  });

  it("loads the real SDK and reads a native session in the same import graph", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    expect(VERSION).toBe(pkg.dependencies["@earendil-works/pi-coding-agent"]);
    expect(AdaptedSessionManager).toBe(SessionManager);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-real-sdk-path-"));
    const sessionPath = path.join(root, "hana", "sessions", "one.jsonl");
    const open = vi.spyOn(SessionManager, "open");
    try {
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, [
        { type: "session", version: 3, id: "path-import-smoke", timestamp: new Date(0).toISOString(), cwd: root },
        { type: "message", id: "message-1", parentId: null, timestamp: new Date(0).toISOString(),
          message: { role: "user", content: "SDK loading keeps native paths", timestamp: 0 } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      expect(messageUtils.isActiveSessionPath(sessionPath, root)).toBe(true);
      const messages = await messageUtils.loadSessionHistoryMessages(null, sessionPath);
      expect(open).toHaveBeenCalledExactlyOnceWith(sessionPath, path.dirname(sessionPath));
      // A fallback JSONL read alone must not conceal a failed real SDK open.
      expect(open.mock.results[0].type).toBe("return");
      expect(open.mock.results[0].value.getBranch()).toEqual([
        expect.objectContaining({ type: "message", id: "message-1" }),
      ]);
      expect(messages).toEqual([expect.objectContaining({ role: "user", content: "SDK loading keeps native paths" })]);
    } finally {
      open.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
