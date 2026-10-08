import { describe, expect, it, vi } from "vitest";
import {
  retainViewerLocalFileResourceWatch,
  resourceEventMatchesViewerFile,
} from "../desktop/src/viewer-resource-events.ts";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  url: string;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe("viewer ResourceEvent live reload", () => {
  it("matches resource.changed events for the current viewer file", () => {
    expect(resourceEventMatchesViewerFile({
      type: "resource.changed",
      resource: { kind: "local-file", filePath: "/workspace/note.md" },
    }, "/workspace/note.md")).toBe(true);

    expect(resourceEventMatchesViewerFile({
      type: "resource.changed",
      resource: { kind: "local-file", filePath: "/workspace/other.md" },
    }, "/workspace/note.md")).toBe(false);
  });

  it("subscribes through ResourceIO and notifies only matching viewer resource events", async () => {
    FakeWebSocket.instances = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/resource-io/subscribe")) {
        return new Response(JSON.stringify({ ok: true, subscriptionId: "sub-viewer" }), { status: 200 });
      }
      if (url.endsWith("/api/resource-io/subscriptions/sub-viewer")) {
        return new Response(JSON.stringify({ ok: true, released: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method || "GET"}`);
    });
    const onChanged = vi.fn();
    const platform = {
      getServerPort: vi.fn(async () => "62950"),
      getServerToken: vi.fn(async () => "secret-token"),
    };

    const watch = retainViewerLocalFileResourceWatch("/workspace/note.md", platform, {
      fetchImpl,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onChanged,
    });
    await watch.ready;

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:62950/api/resource-io/subscribe",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          purpose: "viewer",
          resources: [{ kind: "local-file", path: "/workspace/note.md" }],
        }),
      }),
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url)
      .toBe("ws://127.0.0.1:62950/ws?token=secret-token");

    FakeWebSocket.instances[0].emit({
      type: "resource.changed",
      resource: { kind: "local-file", filePath: "/workspace/other.md" },
    });
    FakeWebSocket.instances[0].emit({
      type: "resource.changed",
      resource: { kind: "local-file", filePath: "/workspace/note.md" },
    });

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({
      type: "resource.changed",
    }));

    watch.release();
    await Promise.resolve();
    expect(FakeWebSocket.instances[0].close).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:62950/api/resource-io/subscriptions/sub-viewer",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
      }),
    );
  });
});
