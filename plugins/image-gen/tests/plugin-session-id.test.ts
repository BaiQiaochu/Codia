import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImageGenPlugin from "../index.ts";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-plugin-test-"));
  tmpDirs.push(dir);
  return dir;
}

function createBusHarness() {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  return {
    bus: {
      hasHandler: vi.fn(() => false),
      handle: vi.fn((type: string, handler: (payload: unknown) => unknown) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      }),
      request: vi.fn(async (type: string, payload: unknown) => {
        const handler = handlers.get(type);
        if (!handler) return { ok: true };
        return handler(payload);
      }),
      subscribe: vi.fn(() => () => {}),
    },
    async request(type: string, payload: unknown) {
      const handler = handlers.get(type);
      if (!handler) throw new Error(`missing handler ${type}`);
      return handler(payload);
    },
  };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("image-gen plugin session identity", () => {
  it("accepts sessionId-first submit-image payloads at the plugin bus boundary", async () => {
    const { bus, request } = createBusHarness();
    const plugin = new (ImageGenPlugin as any)();
    plugin.ctx = {
      dataDir: makeTmpDir(),
      bus,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerSessionFile: vi.fn(),
    };
    plugin.register = vi.fn();

    await plugin.onload();
    await request("media-gen:register-adapter", {
      adapter: {
        id: "fake-image",
        name: "Fake Image",
        types: ["image"],
        async submit() {
          return { files: ["fake.png"] };
        },
      },
    });

    const result = await request("media-gen:submit-image", {
      sessionId: "sess_image_plugin",
      input: { provider: "fake-image", prompt: "lantern" },
    });

    expect(result).toMatchObject({
      ok: true,
      kind: "image",
      prompt: "lantern",
    });
  });
});
