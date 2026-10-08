import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { SessionListProjectionCache, sessionFileRevision } from "../core/session-list-projection-cache.js";

describe("SessionListProjectionCache", () => {
  it('uses compact task and review presentation in sidebar/search instead of model envelopes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codia-presentation-list-'));
    try {
      const entries = [
        { type: 'session', id: 'task', timestamp: '2026-10-06T00:00:00Z' },
        { type: 'custom', customType: 'codia-input-presentation', data: { text: '我的想法', quickAction: 'ideas' } },
        { type: 'message', message: { role: 'user', content: 'INTERNAL TASK INSTRUCTIONS' } },
        { type: 'custom', customType: 'codia-agent-review', data: { displayMessage: { text: '审阅问题' }, review: { requestId: 'r' } } },
        { type: 'custom', customType: 'codia-input-presentation', data: { text: '审阅问题', reviewRequestId: 'r' } },
        { type: 'message', message: { role: 'user', content: 'INTERNAL REVIEW FINDINGS' } },
      ];
      await fs.writeFile(path.join(dir, 'task.jsonl'), entries.map(item => JSON.stringify(item)).join('\n'));
      const [row] = await new SessionListProjectionCache().list(dir);
      expect(row.firstMessage).toBe('我的想法');
      expect(row.allMessagesText).toBe('我的想法 审阅问题');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it("projects session list rows from JSONL files and reuses unchanged projections", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gsap-session-list-cache-"));
    try {
      const sessionPath = path.join(dir, "s1.jsonl");
      await fs.writeFile(sessionPath, [
        JSON.stringify({ type: "session", id: "s1", timestamp: "2026-05-16T08:00:00.000Z", cwd: "/workspace" }),
        JSON.stringify({ type: "session_info", name: "Named session" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "first request", timestamp: "2026-05-16T08:01:00.000Z" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: "2026-05-16T08:02:00.000Z" } }),
      ].join("\n"), "utf8");

      const cache = new SessionListProjectionCache();
      const first = await cache.list(dir);
      const second = await cache.list(dir);

      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        path: sessionPath,
        id: "s1",
        cwd: "/workspace",
        name: "Named session",
        messageCount: 2,
        firstMessage: "first request",
        allMessagesText: "first request answer",
      });
      expect(first[0].modified.toISOString()).toBe("2026-05-16T08:02:00.000Z");
      expect(first[0].revision).toBe(sessionFileRevision(await fs.stat(sessionPath)));
      expect(second).toEqual(first);
      expect(second[0]).not.toBe(first[0]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
