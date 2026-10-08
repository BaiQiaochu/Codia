import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraphStore } from "../lib/graph-store.js";

let tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-kg-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("GraphStore", () => {
  it("builds graph data, persists source browsing, and survives reload", () => {
    const dir = makeTempDir();
    const store = new GraphStore(dir);

    const result = store.buildFromDocuments({
      title: "Conversation graph",
      documents: [
        {
          id: "note-1",
          title: "Original note",
          text: "SparkNoteAI relates to Alpha. Alpha supports Beta.",
        },
      ],
      rebuild: true,
    });

    expect(result.stats.node_count).toBeGreaterThanOrEqual(2);
    expect(result.stats.edge_count).toBeGreaterThanOrEqual(1);
    expect(result.stats.source_count).toBe(1);
    expect(store.getStats()).toEqual(
      expect.objectContaining({
        graph_exists: true,
        node_count: result.stats.node_count,
        edge_count: result.stats.edge_count,
        source_count: 1,
        connected_nodes: expect.any(Number),
        isolated_nodes: expect.any(Number),
        avg_degree: expect.any(Number),
      }),
    );

    store.flushSync();
    expect(JSON.parse(fs.readFileSync(path.join(dir, "graph.json.gsap-watermark.json"), "utf8")).payload).toMatchObject({
      product: "Codia",
      source: "knowledge_graph",
      filePath: path.join(dir, "graph.json"),
    });
    store.destroy();

    const reloaded = new GraphStore(dir);
    const graph = reloaded.getData();
    expect(graph).toEqual(
      expect.objectContaining({
        version: 2,
        title: "Conversation graph",
        nodes: expect.any(Array),
        edges: expect.any(Array),
        sources: [
          expect.objectContaining({
            id: "note-1",
            title: "Original note",
            text: "SparkNoteAI relates to Alpha. Alpha supports Beta.",
          }),
        ],
      }),
    );

    const alphaNode = reloaded.listNodes().find((node) => node.name === "Alpha");
    expect(alphaNode).toBeTruthy();
    expect(reloaded.getNodeSourceDocuments(alphaNode.id)).toEqual(
      expect.objectContaining({
        node: expect.objectContaining({
          id: alphaNode.id,
          name: "Alpha",
        }),
        sources: [
          expect.objectContaining({
            id: "note-1",
            title: "Original note",
          }),
        ],
      }),
    );

    reloaded.destroy();
  });

  it("incremental builds merge nodes and preserve multiple source documents", () => {
    const store = new GraphStore(makeTempDir());

    store.buildFromDocuments({
      documents: [
        {
          id: "first",
          title: "First source",
          text: "Alpha relates to Beta.",
        },
      ],
      rebuild: true,
    });

    const second = store.buildFromDocuments({
      documents: [
        {
          id: "second",
          title: "Second source",
          text: "Alpha relates to Beta. Beta leads to Gamma.",
        },
      ],
    });

    expect(second.stats.node_count).toBe(3);
    expect(second.stats.edge_count).toBe(2);
    expect(second.stats.source_count).toBe(2);

    const alpha = store.listNodes().find((node) => node.name === "Alpha");
    const beta = store.listNodes().find((node) => node.name === "Beta");
    expect(alpha?.source_note_ids.sort()).toEqual(["first", "second"]);
    expect(beta?.source_note_ids.sort()).toEqual(["first", "second"]);
    expect(store.listSources().map((source) => source.id).sort()).toEqual(["first", "second"]);

    store.destroy();
  });

  it("archives the previous graph on rebuild and supports restore and delete", () => {
    const store = new GraphStore(makeTempDir());

    store.buildFromDocuments({
      title: "Graph one",
      documents: [
        {
          id: "first",
          title: "First graph",
          text: "Alpha relates to Beta.",
        },
      ],
      rebuild: true,
    });

    const rebuilt = store.buildFromDocuments({
      title: "Graph two",
      documents: [
        {
          id: "second",
          title: "Second graph",
          text: "Gamma leads to Delta.",
        },
      ],
      rebuild: true,
      archiveOnRebuild: true,
      archiveTitle: "Graph one snapshot",
      archiveReason: "rebuild",
    });

    expect(rebuilt.archived).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        title: "Graph one snapshot",
        reason: "rebuild",
        source: "rebuild",
      }),
    );
    expect(store.listArchives()).toHaveLength(1);
    expect(store.getData().nodes.some((node) => node.name === "Alpha")).toBe(false);
    expect(store.getData().nodes.some((node) => node.name === "Gamma")).toBe(true);

    const archivedGraph = store.getData({ archiveId: rebuilt.archived.id });
    expect(archivedGraph?.nodes.some((node) => node.name === "Alpha")).toBe(true);
    expect(archivedGraph?.is_archive).toBe(true);

    const restored = store.restoreArchive(rebuilt.archived.id);
    expect(restored).toEqual(
      expect.objectContaining({
        archive: expect.objectContaining({ id: rebuilt.archived.id }),
        backup_archive: expect.objectContaining({
          id: expect.any(String),
          source: "restore-backup",
        }),
        graph: expect.objectContaining({
          nodes: expect.any(Array),
        }),
      }),
    );
    expect(store.getData().nodes.some((node) => node.name === "Alpha")).toBe(true);
    expect(store.listArchives()).toHaveLength(2);

    expect(store.deleteArchive(rebuilt.archived.id)).toBe(true);
    expect(store.getArchive(rebuilt.archived.id)).toBe(null);
    expect(store.listArchives()).toHaveLength(1);

    store.destroy();
  });

  it("keeps archives by default when clearing the current graph and removes them only on request", () => {
    const store = new GraphStore(makeTempDir());

    store.buildFromText({
      title: "Working graph",
      text: "Alpha relates to Beta.",
      rebuild: true,
    });

    const archived = store.archiveCurrentGraph({
      title: "Working graph snapshot",
      reason: "manual",
      source: "manual",
    });
    expect(archived).toBeTruthy();
    expect(store.listArchives()).toHaveLength(1);

    store.clear();
    expect(store.getData()).toEqual(
      expect.objectContaining({
        nodes: [],
        edges: [],
        sources: [],
      }),
    );
    expect(store.listArchives()).toHaveLength(1);

    store.clear({ removeArchives: true });
    expect(store.listArchives()).toHaveLength(0);

    store.destroy();
  });

  it("prunes unreferenced source documents after deleting the last related nodes", () => {
    const store = new GraphStore(makeTempDir());
    store.buildFromDocuments({
      documents: [
        {
          id: "first",
          title: "First source",
          text: "Alpha relates to Beta.",
        },
        {
          id: "second",
          title: "Second source",
          text: "Gamma leads to Delta.",
        },
      ],
      rebuild: true,
    });

    const gamma = store.listNodes().find((node) => node.name === "Gamma");
    const delta = store.listNodes().find((node) => node.name === "Delta");
    expect(gamma).toBeTruthy();
    expect(delta).toBeTruthy();

    expect(store.deleteNode(gamma.id)).toBe(true);
    expect(store.listSources().map((source) => source.id).sort()).toEqual(["first", "second"]);

    expect(store.deleteNode(delta.id)).toBe(true);
    expect(store.listSources().map((source) => source.id)).toEqual(["first"]);
    expect(store.getStats()).toEqual(
      expect.objectContaining({
        source_count: 1,
      }),
    );

    store.destroy();
  });

  it("normalizes SparkNoteAI-style string ids and source documents", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "graph.json"),
      JSON.stringify(
        {
          version: 2,
          title: "Imported graph",
          nodes: [
            {
              id: "node-a",
              name: "SparkNoteAI",
              node_type: "entity",
              description: "source project",
              source_note_ids: ["note-a"],
            },
            {
              id: "node-b",
              name: "Knowledge graph",
              node_type: "topic",
              source_note_ids: ["note-a"],
            },
          ],
          edges: [
            {
              id: "edge-a",
              source_node_id: "node-a",
              target_node_id: "node-b",
              edge_type: "related",
              strength: 0.9,
            },
          ],
          sources: [
            { id: "note-a", title: "Original note", text: "SparkNoteAI knowledge graph source text" },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const store = new GraphStore(dir);
    const nodes = store.listNodes();
    const edges = store.listEdges();
    const status = store.status();

    expect(nodes).toHaveLength(2);
    expect(nodes.every((node) => Number.isFinite(node.id))).toBe(true);
    expect(edges).toEqual([
      expect.objectContaining({
        source_node_id: expect.any(Number),
        target_node_id: expect.any(Number),
        edge_type: "related",
        strength: 0.9,
      }),
    ]);
    expect(status).toEqual(
      expect.objectContaining({
        graph_exists: true,
        node_count: 2,
        edge_count: 1,
        source_count: 1,
        storage: "local-json",
      }),
    );

    const sparkNode = nodes.find((node) => node.name === "SparkNoteAI");
    expect(store.getNodeSourceDocuments(sparkNode.id)).toEqual(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            id: "note-a",
            text: "SparkNoteAI knowledge graph source text",
          }),
        ],
      }),
    );

    store.destroy();
  });
});
