import { describe, expect, it } from "vitest";

import { toResourceEventWsMessage } from "../server/resource-events-ws.ts";

describe("toResourceEventWsMessage", () => {
  it("forwards resource.changed events with their resource identity", () => {
    const event = {
      type: "resource.changed",
      changeType: "modified",
      resourceKey: "local_fs:/workspace/notes/a.md",
      resource: {
        kind: "local-file",
        provider: "local_fs",
        path: "/workspace/notes/a.md",
        filePath: "/workspace/notes/a.md",
      },
      version: { mtimeMs: 1000, size: 12 },
      source: "provider_watch",
      sequence: 7,
      occurredAt: "2026-06-21T09:00:00.000Z",
    };

    expect(toResourceEventWsMessage(event, null)).toEqual(event);
  });

  it("uses the hub session path when a resource event is session-scoped by the bus", () => {
    const event = {
      type: "resource.changed",
      changeType: "created",
      resourceKey: "local_fs:/workspace/notes/new.md",
      resource: {
        kind: "local-file",
        provider: "local_fs",
        path: "/workspace/notes/new.md",
      },
      source: "agent_tool",
      sequence: 8,
      occurredAt: "2026-06-21T09:01:00.000Z",
    };

    expect(toResourceEventWsMessage(event, "/sessions/a.jsonl")).toMatchObject({
      type: "resource.changed",
      sessionPath: "/sessions/a.jsonl",
      resourceKey: "local_fs:/workspace/notes/new.md",
    });
  });

  it("forwards delete and rename resource events", () => {
    expect(toResourceEventWsMessage({
      type: "resource.deleted",
      resourceKey: "local_fs:/workspace/notes/old.md",
      resource: { kind: "local-file", provider: "local_fs", path: "/workspace/notes/old.md" },
      source: "provider_watch",
      sequence: 9,
      occurredAt: "2026-06-21T09:02:00.000Z",
    }, null)).toMatchObject({ type: "resource.deleted" });

    expect(toResourceEventWsMessage({
      type: "resource.renamed",
      oldResourceKey: "local_fs:/workspace/notes/old.md",
      newResourceKey: "local_fs:/workspace/notes/new.md",
      oldResource: { kind: "local-file", provider: "local_fs", path: "/workspace/notes/old.md" },
      newResource: { kind: "local-file", provider: "local_fs", path: "/workspace/notes/new.md" },
      source: "provider_watch",
      sequence: 10,
      occurredAt: "2026-06-21T09:03:00.000Z",
    }, null)).toMatchObject({ type: "resource.renamed" });
  });

  it("ignores non-resource events", () => {
    expect(toResourceEventWsMessage({ type: "demo_event" }, "/sessions/a.jsonl")).toBeNull();
  });
});
