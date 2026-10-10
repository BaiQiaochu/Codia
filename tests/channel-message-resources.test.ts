import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendMessage, parseChannel } from "../lib/channels/channel-store.js";

describe("channel message resource metadata", () => {
  let tempDir = null;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function makeChannelFile() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-channel-resource-"));
    const filePath = path.join(tempDir, "ch_resources.md");
    fs.writeFileSync(filePath, "---\nid: ch_resources\nmembers: [agent-a, agent-b]\n---\n", "utf-8");
    return filePath;
  }

  it("round-trips file blocks and resource envelopes in markdown metadata", () => {
    const filePath = makeChannelFile();
    const resource = {
      schemaVersion: 1,
      resourceId: "res-image-1",
      name: "demo.png",
      studioId: "default",
      type: "file",
      source: "session_file",
      lifecycle: { status: "available", missingAt: null },
      storage: { provider: "session_file" },
      links: { self: "/api/resources/res-image-1", content: "/api/resources/res-image-1/content" },
    };
    const blocks = [{
      type: "file",
      filePath: "E:/uploads/demo.png",
      label: "demo.png",
      ext: "png",
      kind: "image",
      resource,
    }];

    appendMessage(filePath, "user", "", { blocks, resources: [resource] });

    const parsed = parseChannel(fs.readFileSync(filePath, "utf-8"));
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].body).toBe("");
    expect(parsed.messages[0].blocks).toEqual(blocks);
    expect(parsed.messages[0].resources).toEqual([resource]);
  });
});
