import { describe, expect, it } from "vitest";
import { extractGraphDocument, normalizeGraphData } from "../lib/graph-operations.js";

describe("graph-operations", () => {
  it("extracts English nodes and relations without sentence-level noise", () => {
    const result = extractGraphDocument(
      "Alpha relates to Beta. Codia uses local knowledge graph source documents. SparkNoteAI inspired the graph data model rewrite.",
      {
        title: "Conversation graph",
        sourceId: "demo-source",
      },
    );

    const nodeNames = result.nodes.map((node) => node.name);
    expect(nodeNames).toContain("Alpha");
    expect(nodeNames).toContain("Beta");
    expect(nodeNames).toContain("Codia");
    expect(nodeNames).toContain("SparkNoteAI");
    expect(nodeNames).not.toContain("Alpha relates to Beta");
    expect(nodeNames).not.toContain("Beta. Codia");
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_name: "Alpha",
          target_name: "Beta",
          edge_type: "related",
        }),
      ]),
    );
    expect(result.stats.sentences_processed).toBe(3);
  });

  it("extracts Chinese hierarchical concepts and keeps source linkage", () => {
    const result = extractGraphDocument(
      "知识图谱包括节点、关系和来源文档。SparkNoteAI 使用知识图谱模型。Codia 支持本地知识图谱页面。",
      {
        title: "知识图谱测试",
        sourceId: "note-1",
      },
    );

    const nodeNames = result.nodes.map((node) => node.name);
    expect(nodeNames).toEqual(
      expect.arrayContaining(["知识图谱", "节点", "关系", "来源文档", "SparkNoteAI", "Codia"]),
    );
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_name: "知识图谱",
          target_name: "节点",
          edge_type: "hierarchical",
        }),
        expect.objectContaining({
          source_name: "知识图谱",
          target_name: "关系",
          edge_type: "hierarchical",
        }),
      ]),
    );
    expect(result.nodes.every((node) => node.source_note_ids.includes("note-1"))).toBe(true);
  });

  it("normalizes SparkNoteAI-style string ids into local numeric graph ids", () => {
    const normalized = normalizeGraphData({
      version: 2,
      nodes: [
        {
          id: "node-a",
          name: "SparkNoteAI",
          node_type: "entity",
          source_note_ids: ["note-a"],
        },
        {
          id: "node-b",
          name: "知识图谱",
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
      sources: [{ id: "note-a", title: "Original note", text: "SparkNoteAI knowledge graph source text" }],
    });

    expect(normalized.nodes).toHaveLength(2);
    expect(normalized.edges).toHaveLength(1);
    expect(normalized.nodes.every((node) => Number.isFinite(node.id))).toBe(true);
    expect(normalized.edges[0]).toEqual(
      expect.objectContaining({
        id: expect.any(Number),
        source_node_id: expect.any(Number),
        target_node_id: expect.any(Number),
        edge_type: "related",
        strength: 0.9,
      }),
    );
    expect(normalized.sources).toEqual([
      expect.objectContaining({
        id: "note-a",
        text: "SparkNoteAI knowledge graph source text",
      }),
    ]);
  });
});
