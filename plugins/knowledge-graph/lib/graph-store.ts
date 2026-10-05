// @ts-nocheck
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import darkWatermark from "../../../shared/dark-watermark.cjs";
import {
  DIRECTED_EDGE_TYPES,
  GRAPH_VERSION,
  clampStrength,
  clone,
  detectNodeType,
  extractGraphDocument,
  normalizeGraphData,
  normalizeName,
  normalizeSourceDocument,
  normalizeSources,
  nowIso,
  safeEdgeType,
  toNumericId,
} from "./graph-operations.ts";

const { watermarkGeneratedFileSync } = darkWatermark;
const DEBOUNCE_MS = 250;
const ARCHIVE_INDEX_VERSION = 1;
const DEFAULT_GRAPH_TITLE = "知识图谱";

function mergeSourceIds(currentValue, nextValue) {
  return [...new Set([...(currentValue || []), ...normalizeSources(nextValue)])];
}

function makeDocumentId(index, title, text) {
  const hash = crypto
    .createHash("sha1")
    .update(`${title || ""}\n${text || ""}`)
    .digest("hex")
    .slice(0, 12);
  return `source-${index + 1}-${hash}`;
}

function createArchiveId() {
  return `archive-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function watermarkGraphFile(filePath, source = "knowledge_graph") {
  watermarkGeneratedFileSync({
    filePath,
    source,
    origin: "plugin_generated",
    storageKind: "plugin_generated",
  });
}

function hasGraphContent(graph) {
  return Boolean(
    (Array.isArray(graph?.nodes) && graph.nodes.length > 0) ||
      (Array.isArray(graph?.edges) && graph.edges.length > 0) ||
      (Array.isArray(graph?.sources) && graph.sources.length > 0),
  );
}

function sortLocale(left, right) {
  return String(left).localeCompare(String(right), "zh-Hans-CN");
}

function normalizeArchiveMetadata(input) {
  if (!input || typeof input !== "object") return null;
  const id = String(input.id || "").trim();
  if (!id) return null;

  return {
    id,
    title: String(input.title || DEFAULT_GRAPH_TITLE).trim() || DEFAULT_GRAPH_TITLE,
    reason: String(input.reason || "").trim() || "manual",
    source: String(input.source || "").trim() || "manual",
    created_at: String(input.created_at || input.createdAt || nowIso()),
    updated_at: String(input.updated_at || input.updatedAt || input.created_at || nowIso()),
    last_built_at: input.last_built_at || input.lastBuiltAt || null,
    node_count: Math.max(0, Number(input.node_count ?? input.nodeCount ?? 0) || 0),
    edge_count: Math.max(0, Number(input.edge_count ?? input.edgeCount ?? 0) || 0),
    source_count: Math.max(0, Number(input.source_count ?? input.sourceCount ?? 0) || 0),
  };
}

export function normalizeBuildDocuments(documents) {
  if (!Array.isArray(documents)) return [];

  return documents
    .map((raw, index) => {
      if (typeof raw === "string") {
        const text = String(raw).trim();
        if (!text) return null;
        return normalizeSourceDocument({
          id: makeDocumentId(index, "", text),
          title: `文档 ${index + 1}`,
          text,
        });
      }

      if (!raw || typeof raw !== "object") return null;
      const text = String(raw.text ?? raw.content ?? raw.body ?? "").trim();
      if (!text) return null;

      const title = String(raw.title ?? raw.name ?? `文档 ${index + 1}`).trim();
      const id =
        String(raw.id ?? raw.source_id ?? raw.sourceId ?? raw.note_id ?? raw.noteId ?? "").trim() ||
        makeDocumentId(index, title, text);

      return normalizeSourceDocument({ id, title, text });
    })
    .filter(Boolean);
}

function computeStats(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const sources = Array.isArray(graph?.sources) ? graph.sources : [];

  const connectedNodeIds = new Set();
  for (const edge of edges) {
    if (Number.isFinite(edge?.source_node_id)) connectedNodeIds.add(edge.source_node_id);
    if (Number.isFinite(edge?.target_node_id)) connectedNodeIds.add(edge.target_node_id);
  }

  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const sourceCount = sources.length;
  const connectedNodes = connectedNodeIds.size;

  return {
    graph_exists: nodeCount > 0,
    node_count: nodeCount,
    edge_count: edgeCount,
    source_count: sourceCount,
    connected_nodes: connectedNodes,
    isolated_nodes: Math.max(0, nodeCount - connectedNodes),
    avg_degree: nodeCount > 0 ? Number(((edgeCount * 2) / nodeCount).toFixed(2)) : 0,
    last_built_at: graph?.last_built_at || null,
  };
}

export class GraphStore {
  constructor(dataDir) {
    this._dataDir = dataDir;
    this._filePath = path.join(dataDir, "graph.json");
    this._archiveIndexPath = path.join(dataDir, "graph-archives.json");
    this._archiveDir = path.join(dataDir, "graph-archives");
    this._nodes = new Map();
    this._edges = new Map();
    this._sources = new Map();
    this._archives = new Map();
    this._nextNodeId = 1;
    this._nextEdgeId = 1;
    this._lastBuiltAt = null;
    this._title = "";
    this._debounceTimer = null;
    this._load();
  }

  status(taskState = {}) {
    const stats = this.getStats();
    return {
      has_llm_config: true,
      llm_required: false,
      graph_exists: stats.graph_exists,
      node_count: stats.node_count,
      edge_count: stats.edge_count,
      source_count: stats.source_count,
      is_building: Boolean(taskState.is_building),
      building_progress: taskState.is_building
        ? Math.max(0, Math.min(100, Number(taskState.building_progress) || 0))
        : stats.graph_exists
          ? 100
          : 0,
      building_message: taskState.building_message || null,
      current_task_id: taskState.current_task_id || null,
      current_task_status: taskState.current_task_status || null,
      queued_task_count: Math.max(0, Number(taskState.queued_task_count) || 0),
      queued_task_ids: Array.isArray(taskState.queued_task_ids) ? taskState.queued_task_ids : [],
      active_task_count: Math.max(0, Number(taskState.active_task_count) || 0),
      last_built_at: this._lastBuiltAt,
      storage: "local-json",
      model: "sparknote-inspired-local",
      archive_count: this._archives.size,
      current_title: this._title || DEFAULT_GRAPH_TITLE,
    };
  }

  getData(options = {}) {
    const snapshot = this._getSnapshot(options);
    if (!snapshot) return null;

    const archive = options.archiveId ? this.getArchive(options.archiveId) : null;
    return {
      version: GRAPH_VERSION,
      title: snapshot.title || DEFAULT_GRAPH_TITLE,
      last_built_at: snapshot.last_built_at || null,
      nodes: snapshot.nodes.map(clone).sort((left, right) => sortLocale(left.name, right.name)),
      edges: snapshot.edges.map(clone).sort((left, right) => left.id - right.id),
      sources: snapshot.sources
        .map(clone)
        .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at))),
      is_archive: Boolean(archive),
      archive_id: archive?.id || null,
      archive_title: archive?.title || null,
      archived_at: archive?.created_at || null,
    };
  }

  getStats(options = {}) {
    const snapshot = this._getSnapshot(options);
    if (!snapshot) return null;
    return computeStats(snapshot);
  }

  listNodes(options = {}) {
    return this.getData(options)?.nodes || [];
  }

  listEdges(options = {}) {
    return this.getData(options)?.edges || [];
  }

  listSources(options = {}) {
    return this.getData(options)?.sources || [];
  }

  listArchives() {
    return [...this._archives.values()]
      .map(clone)
      .sort((left, right) =>
        String(right.updated_at || right.created_at).localeCompare(
          String(left.updated_at || left.created_at),
        ),
      );
  }

  getArchive(id) {
    const key = String(id || "").trim();
    if (!key) return null;
    const archive = this._archives.get(key);
    return archive ? clone(archive) : null;
  }

  archiveCurrentGraph({ title = "", reason = "manual", source = "manual" } = {}) {
    const snapshot = this._getActiveSnapshot();
    if (!hasGraphContent(snapshot)) return null;

    const createdAt = nowIso();
    const id = createArchiveId();
    const archiveTitle =
      String(title || "").trim() ||
      snapshot.title ||
      `${DEFAULT_GRAPH_TITLE} ${createdAt.replace("T", " ").slice(0, 16)}`;
    const metadata = {
      id,
      title: archiveTitle,
      reason: String(reason || "").trim() || "manual",
      source: String(source || "").trim() || "manual",
      created_at: createdAt,
      updated_at: createdAt,
      last_built_at: snapshot.last_built_at || null,
      node_count: snapshot.nodes.length,
      edge_count: snapshot.edges.length,
      source_count: snapshot.sources.length,
    };

    const payload = {
      version: GRAPH_VERSION,
      title: archiveTitle,
      last_built_at: snapshot.last_built_at || null,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      sources: snapshot.sources,
    };

    this._archives.set(id, metadata);
    this._writeArchivePayloadSync(id, payload);
    this._writeArchiveIndexSync();
    return clone(metadata);
  }

  restoreArchive(
    id,
    { archiveCurrent = true, backupTitle = "", backupReason = "restore-backup" } = {},
  ) {
    const archive = this.getArchive(id);
    if (!archive) return null;

    const payload = this._readArchivePayload(id);
    if (!payload) return null;

    let backupArchive = null;
    if (archiveCurrent && hasGraphContent(this._getActiveSnapshot())) {
      backupArchive = this.archiveCurrentGraph({
        title: backupTitle,
        reason: backupReason,
        source: "restore-backup",
      });
    }

    this._applySnapshot(payload);
    this._scheduleSave();

    return {
      archive,
      backup_archive: backupArchive,
      graph: this.getData(),
      stats: this.getStats(),
    };
  }

  deleteArchive(id) {
    const key = String(id || "").trim();
    if (!key || !this._archives.has(key)) return false;

    this._archives.delete(key);
    try {
      fs.rmSync(this._archiveFilePath(key), { force: true });
    } catch (error) {
      process.stderr.write(`KnowledgeGraphStore archive delete failed: ${error.message}\n`);
    }
    this._writeArchiveIndexSync();
    return true;
  }

  clear({ removeArchives = false } = {}) {
    this._resetState();
    if (removeArchives) {
      this._archives.clear();
      try {
        fs.rmSync(this._archiveDir, { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(`KnowledgeGraphStore archive clear failed: ${error.message}\n`);
      }
      this._writeArchiveIndexSync();
    }
    this._scheduleSave();
    return true;
  }

  deleteNode(id) {
    const nodeId = toNumericId(id);
    if (!nodeId || !this._nodes.has(nodeId)) return false;

    this._nodes.delete(nodeId);
    for (const [edgeId, edge] of this._edges.entries()) {
      if (edge.source_node_id === nodeId || edge.target_node_id === nodeId) {
        this._edges.delete(edgeId);
      }
    }

    this._pruneUnreferencedSources();
    this._scheduleSave();
    return true;
  }

  deleteEdge(id) {
    const edgeId = toNumericId(id);
    if (!edgeId || !this._edges.has(edgeId)) return false;

    this._edges.delete(edgeId);
    this._scheduleSave();
    return true;
  }

  getNodeSourceDocuments(id, options = {}) {
    const nodeId = toNumericId(id);
    if (!nodeId) return null;

    const graph = this.getData(options);
    if (!graph) return null;

    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node) return null;

    const sourceMap = new Map(graph.sources.map((source) => [source.id, source]));
    const sources = normalizeSources(node.source_note_ids)
      .map((sourceId) => sourceMap.get(sourceId) || null)
      .filter(Boolean)
      .map(clone);

    return {
      node: clone(node),
      sources,
      archive_id: graph.archive_id || null,
      is_archive: graph.is_archive,
    };
  }

  buildFromText({
    title = "",
    text = "",
    sourceId = "",
    rebuild = false,
    maxNodes = 24,
    archiveOnRebuild = rebuild,
    archiveTitle = "",
    archiveReason = "rebuild",
  } = {}) {
    const trimmedText = String(text || "").trim();
    const trimmedTitle = String(title || "").trim();
    const documentId = String(sourceId || "").trim() || makeDocumentId(0, trimmedTitle, trimmedText);

    return this.buildFromDocuments({
      documents: [
        {
          id: documentId,
          title: trimmedTitle || "文档 1",
          text: trimmedText,
        },
      ],
      title: trimmedTitle || DEFAULT_GRAPH_TITLE,
      rebuild,
      maxNodes,
      archiveOnRebuild,
      archiveTitle,
      archiveReason,
    });
  }

  buildFromDocuments({
    documents = [],
    title = "",
    rebuild = false,
    maxNodes = 24,
    archiveOnRebuild = rebuild,
    archiveTitle = "",
    archiveReason = "rebuild",
  } = {}) {
    const normalizedDocuments = normalizeBuildDocuments(documents);
    const graphTitle = String(title || "").trim();
    let archived = null;

    if (rebuild) {
      if (archiveOnRebuild && hasGraphContent(this._getActiveSnapshot())) {
        archived = this.archiveCurrentGraph({
          title: archiveTitle,
          reason: archiveReason,
          source: "rebuild",
        });
      }
      this._resetState();
    }

    let documentsProcessed = 0;
    let nodesCreated = 0;
    let nodesUpdated = 0;
    let edgesCreated = 0;
    let edgesUpdated = 0;
    let sentencesProcessed = 0;
    let conceptsExtracted = 0;
    let relationshipsDiscovered = 0;
    const sourceIds = [];
    const nodeIdsByName = new Map();
    let resolvedTitle = graphTitle;

    for (const document of normalizedDocuments) {
      if (!document?.text) continue;
      documentsProcessed += 1;
      sourceIds.push(document.id);
      if (!resolvedTitle && document.title) resolvedTitle = document.title;
      this._upsertSourceDocument(document);

      const extraction = extractGraphDocument(document.text, {
        title: document.title,
        sourceId: document.id,
        maxNodes,
      });
      sentencesProcessed += extraction.stats.sentences_processed;
      conceptsExtracted += extraction.stats.concepts_extracted;
      relationshipsDiscovered += extraction.stats.relationships_discovered;

      for (const candidate of extraction.nodes) {
        const result = this._upsertNode(candidate, document.id);
        nodeIdsByName.set(normalizeName(result.node.name), result.node.id);
        if (result.status === "created") nodesCreated += 1;
        if (result.status === "updated") nodesUpdated += 1;
      }

      for (const edge of extraction.edges) {
        const sourceNodeId = this._resolveNodeId(edge.source_name, nodeIdsByName, document.id);
        const targetNodeId = this._resolveNodeId(edge.target_name, nodeIdsByName, document.id);
        const result = this._upsertEdge({
          source_node_id: sourceNodeId,
          target_node_id: targetNodeId,
          edge_type: edge.edge_type,
          description: edge.description,
          strength: edge.strength,
        });
        if (result === "created") edgesCreated += 1;
        if (result === "updated") edgesUpdated += 1;
      }
    }

    this._pruneUnreferencedSources();
    if (documentsProcessed > 0) {
      this._lastBuiltAt = nowIso();
      this._title = resolvedTitle || this._title || DEFAULT_GRAPH_TITLE;
    }
    this._scheduleSave();

    return {
      title: this._title || DEFAULT_GRAPH_TITLE,
      sourceId: sourceIds[0] || null,
      sourceIds,
      archived,
      graph: this.getData(),
      extraction: {
        documents_processed: documentsProcessed,
        sentences_processed: sentencesProcessed,
        concepts_extracted: conceptsExtracted,
        relationships_discovered: relationshipsDiscovered,
      },
      stats: {
        documents_processed: documentsProcessed,
        nodes_created: nodesCreated,
        nodes_updated: nodesUpdated,
        edges_created: edgesCreated,
        edges_updated: edgesUpdated,
        node_count: this._nodes.size,
        edge_count: this._edges.size,
        source_count: this._sources.size,
        last_built_at: this._lastBuiltAt,
      },
    };
  }

  flushSync() {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._writeSync();
  }

  destroy() {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
      this._writeSync();
    }
  }

  _resetState() {
    this._nodes.clear();
    this._edges.clear();
    this._sources.clear();
    this._nextNodeId = 1;
    this._nextEdgeId = 1;
    this._lastBuiltAt = null;
    this._title = "";
  }

  _getSnapshot(options = {}) {
    if (options.archiveId) return this._readArchivePayload(options.archiveId);
    return this._getActiveSnapshot();
  }

  _getActiveSnapshot() {
    return {
      version: GRAPH_VERSION,
      title: this._title || DEFAULT_GRAPH_TITLE,
      last_built_at: this._lastBuiltAt,
      nodes: [...this._nodes.values()].map(clone),
      edges: [...this._edges.values()].map(clone),
      sources: [...this._sources.values()].map(clone),
    };
  }

  _archiveFilePath(archiveId) {
    return path.join(this._archiveDir, `${archiveId}.json`);
  }

  _applySnapshot(data) {
    const normalized = normalizeGraphData(data);
    this._nodes = new Map(normalized.nodes.map((node) => [node.id, node]));
    this._edges = new Map(normalized.edges.map((edge) => [edge.id, edge]));
    this._sources = new Map(normalized.sources.map((source) => [source.id, source]));
    this._nextNodeId = normalized.nextNodeId;
    this._nextEdgeId = normalized.nextEdgeId;
    this._lastBuiltAt = data?.last_built_at || data?.lastBuiltAt || null;
    this._title = String(data?.title || data?.graph_title || "").trim() || DEFAULT_GRAPH_TITLE;
    this._pruneUnreferencedSources();
  }

  _resolveNodeId(name, nodeIdsByName, sourceId) {
    const key = normalizeName(name);
    const cached = nodeIdsByName.get(key);
    if (cached && this._nodes.has(cached)) return cached;

    const existing = this._findNodeByName(name);
    if (existing) {
      existing.source_note_ids = mergeSourceIds(existing.source_note_ids, sourceId);
      existing.updated_at = nowIso();
      nodeIdsByName.set(key, existing.id);
      return existing.id;
    }

    const result = this._upsertNode(
      {
        name,
        node_type: detectNodeType(name),
        description: "",
        source_note_ids: normalizeSources(sourceId),
      },
      sourceId,
    );
    nodeIdsByName.set(key, result.node.id);
    return result.node.id;
  }

  _upsertNode(input, sourceId) {
    const name = String(input?.name || "").trim();
    const existing = this._findNodeByName(name);
    const nextSources = mergeSourceIds(input?.source_note_ids, sourceId);

    if (existing) {
      let changed = false;
      const nextType = detectNodeType(name, input?.node_type || input?.type);
      if (existing.node_type === "concept" && nextType !== "concept") {
        existing.node_type = nextType;
        changed = true;
      }

      const description = String(input?.description || "").trim();
      if (description && (!existing.description || description.length > existing.description.length)) {
        existing.description = description;
        changed = true;
      }

      const mergedSources = mergeSourceIds(existing.source_note_ids, nextSources);
      if (mergedSources.length !== (existing.source_note_ids || []).length) {
        existing.source_note_ids = mergedSources;
        changed = true;
      }

      if (changed) existing.updated_at = nowIso();
      return { status: changed ? "updated" : "skipped", node: existing };
    }

    const timestamp = nowIso();
    const node = {
      id: this._nextNodeId++,
      name,
      node_type: detectNodeType(name, input?.node_type || input?.type),
      description: String(input?.description || "").trim(),
      source_note_ids: nextSources,
      is_verified: Boolean(input?.is_verified ?? input?.isVerified),
      created_at: timestamp,
      updated_at: timestamp,
    };

    this._nodes.set(node.id, node);
    return { status: "created", node };
  }

  _findNodeByName(name) {
    const key = normalizeName(name);
    if (!key) return null;

    for (const node of this._nodes.values()) {
      if (normalizeName(node.name) === key) return node;
    }

    return null;
  }

  _upsertEdge(edgeInput) {
    const edgeType = safeEdgeType(edgeInput?.edge_type || edgeInput?.edgeType);
    let sourceId = toNumericId(edgeInput?.source_node_id ?? edgeInput?.sourceNodeId);
    let targetId = toNumericId(edgeInput?.target_node_id ?? edgeInput?.targetNodeId);
    if (!sourceId || !targetId || sourceId === targetId) return "skipped";
    if (!this._nodes.has(sourceId) || !this._nodes.has(targetId)) return "skipped";

    if (!DIRECTED_EDGE_TYPES.has(edgeType) && sourceId > targetId) {
      [sourceId, targetId] = [targetId, sourceId];
    }

    const existing = this._findEdge(sourceId, targetId, edgeType);
    const description = String(edgeInput?.description || "").trim();
    const strength = clampStrength(edgeInput?.strength);

    if (existing) {
      let changed = false;
      if (description && (!existing.description || description.length > existing.description.length)) {
        existing.description = description;
        changed = true;
      }
      if (strength > existing.strength) {
        existing.strength = strength;
        changed = true;
      }
      if (changed) existing.updated_at = nowIso();
      return changed ? "updated" : "skipped";
    }

    const timestamp = nowIso();
    this._edges.set(this._nextEdgeId, {
      id: this._nextEdgeId,
      source_node_id: sourceId,
      target_node_id: targetId,
      edge_type: edgeType,
      description,
      strength,
      created_at: timestamp,
      updated_at: timestamp,
    });
    this._nextEdgeId += 1;
    return "created";
  }

  _findEdge(sourceId, targetId, edgeType) {
    for (const edge of this._edges.values()) {
      if (edge.edge_type !== edgeType) continue;
      if (edge.source_node_id === sourceId && edge.target_node_id === targetId) return edge;
      if (
        edgeType === "related" &&
        edge.source_node_id === targetId &&
        edge.target_node_id === sourceId
      ) {
        return edge;
      }
    }
    return null;
  }

  _upsertSourceDocument(input) {
    const source = normalizeSourceDocument(input);
    if (!source) return null;

    const existing = this._sources.get(source.id);
    if (existing) {
      existing.title = source.title || existing.title;
      if (source.text && source.text.length >= String(existing.text || "").length) {
        existing.text = source.text;
        existing.excerpt = source.excerpt;
      }
      existing.updated_at = nowIso();
      return clone(existing);
    }

    this._sources.set(source.id, source);
    return clone(source);
  }

  _collectReferencedSourceIds() {
    const referenced = new Set();

    for (const node of this._nodes.values()) {
      for (const sourceId of normalizeSources(node.source_note_ids)) {
        if (sourceId) referenced.add(sourceId);
      }
    }

    return referenced;
  }

  _pruneUnreferencedSources() {
    const referenced = this._collectReferencedSourceIds();
    let removed = 0;

    for (const sourceId of [...this._sources.keys()]) {
      if (referenced.has(sourceId)) continue;
      this._sources.delete(sourceId);
      removed += 1;
    }

    return removed;
  }

  _load() {
    this._loadActiveGraph();
    this._loadArchiveIndex();
  }

  _loadActiveGraph() {
    try {
      if (!fs.existsSync(this._filePath)) return;
      const data = JSON.parse(fs.readFileSync(this._filePath, "utf8"));
      this._applySnapshot(data);
      if (this._pruneUnreferencedSources() > 0) this._writeSync();
    } catch (error) {
      process.stderr.write(`KnowledgeGraphStore load failed: ${error.message}\n`);
      this._resetState();
    }
  }

  _loadArchiveIndex() {
    try {
      if (!fs.existsSync(this._archiveIndexPath)) return;
      const raw = JSON.parse(fs.readFileSync(this._archiveIndexPath, "utf8"));
      const archives = Array.isArray(raw) ? raw : Array.isArray(raw?.archives) ? raw.archives : [];
      let changed = false;

      for (const item of archives) {
        const metadata = normalizeArchiveMetadata(item);
        if (!metadata) {
          changed = true;
          continue;
        }
        if (!fs.existsSync(this._archiveFilePath(metadata.id))) {
          changed = true;
          continue;
        }
        this._archives.set(metadata.id, metadata);
      }

      if (changed) this._writeArchiveIndexSync();
    } catch (error) {
      process.stderr.write(`KnowledgeGraphStore archive index load failed: ${error.message}\n`);
      this._archives.clear();
    }
  }

  _readArchivePayload(archiveId) {
    const archive = this.getArchive(archiveId);
    if (!archive) return null;

    try {
      const raw = JSON.parse(fs.readFileSync(this._archiveFilePath(archive.id), "utf8"));
      const normalized = normalizeGraphData(raw);
      return {
        version: GRAPH_VERSION,
        title: String(raw?.title || archive.title || DEFAULT_GRAPH_TITLE).trim() || DEFAULT_GRAPH_TITLE,
        last_built_at: raw?.last_built_at || raw?.lastBuiltAt || archive.last_built_at || null,
        nodes: normalized.nodes,
        edges: normalized.edges,
        sources: normalized.sources,
      };
    } catch (error) {
      process.stderr.write(`KnowledgeGraphStore archive read failed: ${error.message}\n`);
      return null;
    }
  }

  _scheduleSave() {
    if (this._debounceTimer !== null) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._writeSync();
    }, DEBOUNCE_MS);
  }

  _writeSync() {
    try {
      fs.mkdirSync(this._dataDir, { recursive: true });
      const payload = {
        version: GRAPH_VERSION,
        title: this._title || DEFAULT_GRAPH_TITLE,
        last_built_at: this._lastBuiltAt,
        nodes: [...this._nodes.values()],
        edges: [...this._edges.values()],
        sources: [...this._sources.values()],
      };
      const tmpPath = `${this._filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tmpPath, this._filePath);
      watermarkGraphFile(this._filePath);
    } catch (error) {
      process.stderr.write(`KnowledgeGraphStore write failed: ${error.message}\n`);
    }
  }

  _writeArchiveIndexSync() {
    try {
      fs.mkdirSync(this._dataDir, { recursive: true });
      const payload = {
        version: ARCHIVE_INDEX_VERSION,
        archives: this.listArchives(),
      };
      const tmpPath = `${this._archiveIndexPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tmpPath, this._archiveIndexPath);
      watermarkGraphFile(this._archiveIndexPath, "knowledge_graph_archive_index");
    } catch (error) {
      process.stderr.write(`KnowledgeGraphStore archive index write failed: ${error.message}\n`);
    }
  }

  _writeArchivePayloadSync(archiveId, payload) {
    try {
      fs.mkdirSync(this._archiveDir, { recursive: true });
      const targetPath = this._archiveFilePath(archiveId);
      const tmpPath = `${targetPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tmpPath, targetPath);
      watermarkGraphFile(targetPath, "knowledge_graph_archive");
    } catch (error) {
      process.stderr.write(`KnowledgeGraphStore archive write failed: ${error.message}\n`);
    }
  }
}

export { DEFAULT_GRAPH_TITLE, GRAPH_VERSION, normalizeGraphData, normalizeName };
