import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/debug-log.ts", () => ({
  debugLog: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ChannelRouter } from "../hub/channel-router.ts";

describe("ChannelRouter channel identity guidance", () => {
  let root;
  let channelsDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-channel-identity-"));
    channelsDir = path.join(root, "channels");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.writeFileSync(
      path.join(channelsDir, "poets.md"),
      "---\nid: poets\nmembers: [libai, dufu]\n---\n",
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeFakeRouter() {
    const names = { libai: "Li Bai", dufu: "Du Fu" };
    return {
      _engine: { channelsDir },
      _resolveChannelMemorySenderName: (id) => names[id] || String(id),
      _formatChannelIdentityGuidance: ChannelRouter.prototype._formatChannelIdentityGuidance,
    };
  }

  it("injects the member list, marks the current speaker, and reminds identity boundaries", () => {
    const router = makeFakeRouter();

    const guidance = router._formatChannelIdentityGuidance("libai", "poets", false);

    expect(guidance).toContain("Li Bai (you)");
    expect(guidance).toContain("Du Fu");
    expect(guidance).toContain("speaker");
    expect(guidance).toContain("Do not speak for other members");
  });

  it("still outputs the identity boundary line when channel meta cannot be read", () => {
    const router = makeFakeRouter();

    const guidance = router._formatChannelIdentityGuidance("libai", "no-such-channel", false);

    expect(guidance).toContain("Li Bai");
    expect(guidance).toContain("Only represent");
    expect(guidance).not.toContain("Channel members");
  });
});
