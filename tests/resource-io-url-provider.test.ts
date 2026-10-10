import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UrlProvider } from "../lib/resource-io/providers/url-provider.ts";

const CAPABILITY_KEYS = [
  "stat",
  "read",
  "write",
  "writeExpectedVersion",
  "edit",
  "list",
  "search",
  "watch",
  "materialize",
  "copy",
  "rename",
  "move",
  "trash",
  "delete",
  "mkdir",
].sort();

describe("UrlProvider", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it("reads and materializes safe http resources with version metadata", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-resource-url-"));
    const fetch = vi.fn(async () => new Response("hello url", {
      status: 200,
      headers: {
        "content-type": "text/plain",
        etag: "\"abc\"",
        "last-modified": "Sun, 21 Jun 2026 00:00:00 GMT",
      },
    }));
    const provider = new UrlProvider({
      fetch,
      materializeRoot: tempRoot,
      resolveHostname: async () => ["93.184.216.34"],
    });

    const read = await provider.read({ kind: "url", url: "https://example.com/a.txt" });
    expect(read.content.toString("utf-8")).toBe("hello url");
    expect(read).toMatchObject({
      resourceKey: "url:https://example.com/a.txt",
      resource: {
        kind: "url",
        url: "https://example.com/a.txt",
        provider: "url",
      },
      version: {
        size: 9,
        etag: "\"abc\"",
      },
    });

    const materialized = await provider.materialize({ kind: "url", url: "https://example.com/a.txt" });
    expect(fs.readFileSync(materialized.filePath, "utf-8")).toBe("hello url");
  });

  it("rejects unsafe schemes, localhost, private ranges, and writes", async () => {
    const provider = new UrlProvider({
      fetch: vi.fn(),
      resolveHostname: async (hostname) => hostname === "private.test" ? ["10.0.0.2"] : ["93.184.216.34"],
    });

    await expect(provider.read({ kind: "url", url: "file:///etc/passwd" }))
      .rejects.toMatchObject({ code: "invalid_url_scheme" });
    await expect(provider.read({ kind: "url", url: "http://localhost/a" }))
      .rejects.toMatchObject({ code: "blocked_private_url" });
    await expect(provider.read({ kind: "url", url: "https://private.test/a" }))
      .rejects.toMatchObject({ code: "blocked_private_url" });
    await expect(provider.write({ kind: "url", url: "https://example.com/a" }, "x"))
      .rejects.toMatchObject({ code: "capability_denied" });
  });

  it("declares complete read-only capabilities and denies direct mutations", async () => {
    const provider = new UrlProvider({
      fetch: vi.fn(),
      resolveHostname: async () => ["93.184.216.34"],
    });
    const ref = { kind: "url" as const, url: "https://example.com/a.txt" };

    expect(Object.keys(provider.capabilities()).sort()).toEqual(CAPABILITY_KEYS);
    await expect(provider.write(ref, "x")).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.writeExpectedVersion(ref, "x", { mtimeMs: 1, size: 1 })).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.edit(ref, [{ oldText: "a", newText: "b" }])).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.rename(ref, ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.move(ref, ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.trash(ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.delete(ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.mkdir(ref)).rejects.toMatchObject({ code: "capability_denied" });
  });
});
