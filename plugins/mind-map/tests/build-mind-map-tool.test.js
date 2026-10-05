import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDesignDocumentPreview } from "../../../shared/design-document-preview.ts";
import { MindMapStore } from "../lib/mind-map-store.js";
import { execute } from "../tools/build-mind-map.js";

const tempDirs = [];

function makeCtx(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-mm-tool-"));
  tempDirs.push(dataDir);
  return {
    dataDir,
    agentId: "gsap",
    sessionPath: "C:/sessions/current.jsonl",
    _mindMap: { store: new MindMapStore(dataDir) },
    bus: {
      request: vi.fn(async () => ({
        text: JSON.stringify({
          title: "Explicit Text",
          topics: [{ title: "Alpha" }, { title: "Beta" }],
        }),
      })),
    },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("build-mind-map tool", () => {
  it("requires explicit text, documents, or filePath input", async () => {
    const result = await execute({}, makeCtx());
    expect(result.content[0].text).toMatch(/provide/i);
  });

  it("generates a mind map from explicit text and returns an iframe card", async () => {
    const ctx = makeCtx();
    const result = await execute({ title: "Explicit Text", text: "# Alpha\n- Beta" }, ctx);

    expect(result.details.card).toMatchObject({
      type: "iframe",
      route: expect.stringContaining("/card"),
      title: "Mind Map",
      pluginId: "mind-map",
    });
    expect(ctx.bus.request).toHaveBeenCalledTimes(1);
    const utilityCall = ctx.bus.request.mock.calls[0];
    expect(utilityCall[0]).toBe("utility:call-text");
    expect(utilityCall[1].messages[0].content).toContain("# Alpha");
    expect(utilityCall[1].messages[0].content).not.toContain("sessions/current");

    const filePath = result.details.mindMap.filePath;
    expect(fs.existsSync(filePath)).toBe(true);
    const preview = await parseDesignDocumentPreview(filePath);
    expect(preview.sections[0].items).toEqual(["Explicit Text", "  Alpha", "  Beta"]);
  });

  it("generates from an explicit file path without reading session history", async () => {
    const ctx = makeCtx();
    const sourcePath = path.join(ctx.dataDir, "notes.md");
    fs.writeFileSync(sourcePath, "# Notes\n- Safe content\n");

    const result = await execute({ filePath: sourcePath }, ctx);

    expect(result.details.mindMap.fileName).toBe("notes.xmind");
    expect(ctx.bus.request.mock.calls[0][1].messages[0].content).toContain("Safe content");
    expect(ctx.bus.request.mock.calls[0][1].messages[0].content).not.toContain("session history");
  });

  it("defaults generated files to the current workspace cwd instead of plugin data", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-mm-tool-data-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-mm-tool-workspace-"));
    tempDirs.push(dataDir, workspace);
    const ctx = makeCtx({
      dataDir,
      cwd: workspace,
      _mindMap: { store: new MindMapStore(dataDir) },
    });

    const result = await execute({ title: "Workspace Map", text: "# Workspace\n- Local" }, ctx);

    expect(result.details.mindMap.filePath).toBe(path.join(workspace, "Workspace Map.xmind"));
    expect(fs.existsSync(path.join(workspace, "Workspace Map.xmind"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "generated", "Workspace Map.xmind"))).toBe(false);
    expect(decodeURIComponent(result.details.card.route)).toContain(path.join(workspace, "Workspace Map.xmind"));
  });
});
