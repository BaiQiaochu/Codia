import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDesignDocumentPreview } from "../../../shared/design-document-preview.ts";
import { MindMapStore } from "../lib/mind-map-store.js";
import { buildXmindWorkbook } from "../lib/mind-map-operations.js";

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-mm-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("MindMapStore", () => {
  it("creates, reads, edits, and saves a parseable XMind tree", async () => {
    const store = new MindMapStore(makeTempDir());
    const filePath = store.createBlank("Plan.xmind", "Plan");
    const sidecarPath = `${filePath}.gsap-watermark.json`;

    let tree = store.read(filePath).root;
    expect(tree).toMatchObject({ title: "Plan", children: [] });
    expect(JSON.parse(fs.readFileSync(sidecarPath, "utf8")).payload).toMatchObject({
      product: "Codia",
      source: "mind_map",
      filePath,
    });

    const added = store.addNode(filePath, tree.id, "Goals");
    expect(added.node).toMatchObject({ title: "Goals", children: [] });

    store.renameNode(filePath, added.node.id, "Release Goals");
    tree = store.read(filePath).root;
    expect(tree.children[0]).toMatchObject({ id: added.node.id, title: "Release Goals" });

    const preview = await parseDesignDocumentPreview(filePath);
    expect(preview.sections[0].items).toEqual(["Plan", "  Release Goals"]);
  });

  it("deletes child nodes without allowing root deletion", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "existing.xmind");
    fs.writeFileSync(filePath, buildXmindWorkbook("Root", [
      { title: "Keep" },
      { title: "Remove", children: [{ title: "Child" }] },
    ]));

    const store = new MindMapStore(dir);
    const before = store.read(filePath).root;
    const removableId = before.children[1].id;

    expect(store.deleteNode(filePath, removableId).root.children.map((node) => node.title)).toEqual(["Keep"]);
    expect(() => store.deleteNode(filePath, store.read(filePath).root.id)).toThrow(/root/i);
  });
});
