import { describe, expect, it, vi } from "vitest";
import JimengCliPlugin from "../plugins/jimeng-cli/index.ts";

describe("Jimeng CLI plugin", () => {
  it("registers and unregisters image/video adapters through media-gen", async () => {
    const cleanup: Array<() => void> = [];
    const request = vi.fn(async () => ({ ok: true }));
    const plugin = new JimengCliPlugin();
    plugin.ctx = {
      bus: { request },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    plugin.register = (fn: () => void) => cleanup.push(fn);

    await plugin.onload();

    expect(request).toHaveBeenNthCalledWith(1, "media-gen:register-adapter", {
      adapter: expect.objectContaining({ id: "jimeng-cli-images", protocolId: "jimeng-cli-images" }),
    });
    expect(request).toHaveBeenNthCalledWith(2, "media-gen:register-adapter", {
      adapter: expect.objectContaining({ id: "jimeng-cli-videos", protocolId: "jimeng-cli-videos" }),
    });

    for (const dispose of cleanup.reverse()) dispose();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("media-gen:unregister-adapter", { adapterId: "jimeng-cli-images" });
    expect(request).toHaveBeenCalledWith("media-gen:unregister-adapter", { adapterId: "jimeng-cli-videos" });
  });
});
