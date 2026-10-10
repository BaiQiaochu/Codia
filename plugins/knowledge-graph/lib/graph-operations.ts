// @ts-nocheck
const NODE_TYPES = new Set(["concept", "topic", "entity", "fragment", "tag"]);
const EDGE_TYPES = new Set(["related", "hierarchical", "sequential"]);
const DIRECTED_EDGE_TYPES = new Set(["hierarchical", "sequential"]);
const GRAPH_VERSION = 2;

const ENGLISH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
]);

const CHINESE_STOP_WORDS = new Set([
  "一个",
  "一些",
  "一段",
  "一种",
  "以及",
  "使用",
  "修复",
  "内容",
  "功能",
  "可以",
  "完成",
  "当前",
  "文本",
  "模块",
  "测试",
  "用户",
  "用于",
  "生成",
  "系统",
  "继续",
  "设置",
  "这个",
  "那个",
  "页面",
  "窗口",
  "程序",
  "代码",
  "文件",
  "问题",
]);

const GENERIC_PREFIXES = [
  "当前",
  "这个",
  "这些",
  "这种",
  "该",
  "本",
  "把",
  "对",
  "用于",
  "关于",
  "针对",
  "主程序",
  "原始代码",
  "新的",
];

const GENERIC_SUFFIXES = [
  "功能",
  "模块",
  "系统",
  "页面",
  "逻辑",
  "流程",
  "能力",
  "内容",
  "配置",
  "设置",
  "窗口",
  "项目",
];

const TOPIC_SUFFIXES = [
  "主题",
  "知识图谱",
  "知识库",
  "系统",
  "流程",
  "页面",
  "窗口",
  "模块",
  "功能",
  "组件",
  "配置",
  "文档",
  "策略",
  "队列",
  "接口",
  "路由",
];

const ENTITY_MARKERS = [
  "AI",
  "API",
  "SDK",
  "LLM",
  "GPT",
  "JSON",
  "Codia",
  "SparkNoteAI",
  "Hermes",
  "DeepSeek",
  "ComfyUI",
  "MiniMax",
  "Electron",
  "React",
  "Node",
];

const EXACT_TERMS = [
  "知识图谱",
  "知识库",
  "知识库问答",
  "自动学习指令",
  "数据存放",
  "分享 API",
  "多模态模型",
  "视觉辅助模型",
  "图片生成供应商",
  "来源文档",
  "对话队列",
  "内置浏览器",
  "Codia",
  "SparkNoteAI",
  "Hermes Agent",
  "Hermes",
  "DeepSeek",
  "ComfyUI",
  "MiniMax",
  "OpenAI",
  "SGLang",
];

const FRAGMENT_SUFFIXES = ["片段", "段落", "消息"];
const TAG_SUFFIXES = ["标签"];
const SENTENCE_VERBS = ["使用", "支持", "包括", "包含", "导致", "生成", "构建", "删除", "清空", "更新", "查看", "显示", "加载", "保存", "修复", "优化", "创建", "集成", "切换", "归档", "浏览", "调用"];
const CHINESE_TECH_PATTERN =
  /[\u4e00-\u9fffA-Za-z0-9-]{1,20}(?:知识图谱|知识库问答|知识库|自动学习指令|数据存放|来源文档|图片生成供应商|多模态模型|视觉辅助模型|对话队列|内置浏览器|功能|模块|节点|关系|文档|页面|窗口|队列|配置|插件|模型|路由|接口|工具|数据源)/gu;
const RELATION_FALLBACK_PATTERN =
  /\b(relates?\s+to|uses?|supports?|depends\s+on|based\s+on|built\s+on|inspired\s+by|includes?|contains?|has|consists?\s+of|leads?\s+to|causes?|results?\s+in|generates?)\b|关联|连接|相关|使用|依赖|基于|支持|包括|包含|组成|属于|归于|导致|触发|生成|推动/iu;

const RELATION_RULES = [
  { regex: /\b(relates?\s+to|associated\s+with|linked\s+to|connects?\s+to|works?\s+with)\b/i, type: "related", mode: "pair" },
  { regex: /\b(uses?|supports?|depends\s+on|based\s+on|built\s+on|inspired\s+by)\b/i, type: "related", mode: "pair" },
  { regex: /\b(includes?|contains?|has|consists?\s+of)\b/i, type: "hierarchical", mode: "list" },
  { regex: /\b(part\s+of|belongs\s+to)\b/i, type: "hierarchical", mode: "belongs-to" },
  { regex: /\b(leads?\s+to|causes?|results?\s+in|generates?)\b/i, type: "sequential", mode: "pair" },
  { regex: /(关联到|连接到|相关于|相关)/u, type: "related", mode: "pair" },
  { regex: /(使用|依赖于|基于|借助|支持|采用|集成)/u, type: "related", mode: "pair" },
  { regex: /(包括|包含|由.+组成|含有)/u, type: "hierarchical", mode: "list" },
  { regex: /(属于|归于|隶属于)/u, type: "hierarchical", mode: "belongs-to" },
  { regex: /(导致|触发|生成|推动|产出)/u, type: "sequential", mode: "pair" },
];

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function toHalfWidth(value) {
  return String(value ?? "")
    .replace(/[\uff01-\uff5e]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
}

function simplifyWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function trimPunctuation(value) {
  return String(value ?? "")
    .replace(/^[\s"'`“”‘’「」『』【】<>()[\]{}.,;:!?，。；：！？、\\|/+~-]+/gu, "")
    .replace(/[\s"'`“”‘’「」『』【】<>()[\]{}.,;:!?，。；：！？、\\|/+~-]+$/gu, "");
}

function stripGenericAffixes(value) {
  let next = simplifyWhitespace(trimPunctuation(toHalfWidth(value)));
  if (!next) return "";

  for (const prefix of GENERIC_PREFIXES) {
    if (next.startsWith(prefix) && next.length > prefix.length + 1) {
      next = next.slice(prefix.length);
      break;
    }
  }

  for (const suffix of GENERIC_SUFFIXES) {
    if (next.endsWith(suffix) && next.length > suffix.length + 1) {
      const candidate = next.slice(0, -suffix.length);
      if (candidate.length >= 2) {
        next = candidate;
        break;
      }
    }
  }

  return simplifyWhitespace(trimPunctuation(next));
}

function looksLikeAsciiWord(value) {
  return /^[A-Za-z0-9][A-Za-z0-9 ._/#:+-]*$/.test(value);
}

function normalizeName(value) {
  const stripped = stripGenericAffixes(value)
    .replace(/[(){}\[\]<>「」『』【】"'`“”‘’]/gu, "")
    .replace(/[.,;:!?，。；：！？、]/gu, "")
    .replace(/\s+/g, "");
  if (!stripped) return "";
  return looksLikeAsciiWord(stripped) ? stripped.toLowerCase() : stripped;
}

function safeNodeType(value) {
  const type = String(value ?? "").trim().toLowerCase();
  return NODE_TYPES.has(type) ? type : "concept";
}

function safeEdgeType(value) {
  const type = String(value ?? "").trim().toLowerCase();
  return EDGE_TYPES.has(type) ? type : "related";
}

function clampStrength(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.max(0, Math.min(1, numeric));
}

function toNumericId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

function nextFreeId(usedIds, start) {
  let id = Math.max(1, Math.trunc(Number(start) || 1));
  while (usedIds.has(id)) id += 1;
  usedIds.add(id);
  return id;
}

function uniq(values) {
  return [...new Set(values)];
}

function normalizeSources(value) {
  const items = [];

  const push = (entry) => {
    if (entry == null) return;
    if (typeof entry === "object") {
      const rawId = entry.id ?? entry.source_id ?? entry.sourceId ?? entry.note_id ?? entry.noteId;
      if (rawId != null) items.push(String(rawId).trim());
      return;
    }
    items.push(String(entry).trim());
  };

  if (Array.isArray(value)) {
    value.forEach(push);
  } else if (typeof value === "string" && value.includes(",")) {
    value.split(",").forEach(push);
  } else {
    push(value);
  }

  return uniq(items.filter(Boolean));
}

function normalizeSourceDocument(value, fallbackId = null) {
  if (!value || typeof value !== "object") return null;

  const id = String(
    value.id ??
      value.source_id ??
      value.sourceId ??
      value.note_id ??
      value.noteId ??
      fallbackId ??
      "",
  ).trim();
  if (!id) return null;

  const timestamp = nowIso();
  const title = simplifyWhitespace(String(value.title ?? value.name ?? value.filename ?? id).trim()) || id;
  const text = String(value.text ?? value.content ?? value.body ?? value.sourceText ?? "").trim();

  return {
    id,
    title: title.slice(0, 160),
    text,
    excerpt: text ? text.slice(0, 240) : "",
    created_at: value.created_at ?? value.createdAt ?? timestamp,
    updated_at: value.updated_at ?? value.updatedAt ?? value.created_at ?? value.createdAt ?? timestamp,
  };
}

function normalizeSourceDocuments(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSourceDocument(item)).filter(Boolean);
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([id, item]) => normalizeSourceDocument(item, id))
      .filter(Boolean);
  }

  return [];
}

function rawNodeName(value) {
  return simplifyWhitespace(String(value?.name ?? value?.label ?? value?.title ?? "").trim());
}

function rawEdgeEndpoint(value, side) {
  const raw =
    value?.[`${side}_node_id`] ??
    value?.[`${side}NodeId`] ??
    value?.[`${side}_id`] ??
    value?.[`${side}Id`] ??
    value?.[side];

  if (raw && typeof raw === "object") {
    return raw.id ?? raw.name ?? raw.label ?? null;
  }

  return raw;
}

function detectNodeType(name, fallback = "concept") {
  const cleaned = stripGenericAffixes(name);
  if (!cleaned) return safeNodeType(fallback);

  for (const suffix of TAG_SUFFIXES) {
    if (cleaned.endsWith(suffix)) return "tag";
  }
  for (const suffix of FRAGMENT_SUFFIXES) {
    if (cleaned.endsWith(suffix)) return "fragment";
  }
  for (const suffix of TOPIC_SUFFIXES) {
    if (cleaned.endsWith(suffix)) return "topic";
  }

  const upper = cleaned.toUpperCase();
  if (ENTITY_MARKERS.some((marker) => upper.includes(marker.toUpperCase()))) return "entity";
  if (/^[A-Z][A-Za-z0-9.+#/-]*(?:\s+[A-Z][A-Za-z0-9.+#/-]*){0,3}$/.test(cleaned)) return "entity";
  if (/^[A-Za-z0-9.+#/_-]+$/.test(cleaned) && /[A-Z]/.test(cleaned)) return "entity";
  return safeNodeType(fallback);
}

function isCjkText(value) {
  return /[\u4e00-\u9fff]/u.test(value);
}

function isUsefulCandidate(value) {
  const cleaned = stripGenericAffixes(value);
  if (!cleaned) return false;
  if (/^\d+$/u.test(cleaned)) return false;
  if (cleaned.length < 2 || cleaned.length > 48) return false;
  if (/[\n\r]/u.test(cleaned)) return false;
  if (/[，。！？!?,;；：:]/u.test(cleaned)) return false;

  const normalized = normalizeName(cleaned);
  if (!normalized) return false;
  if (ENGLISH_STOP_WORDS.has(normalized)) return false;
  if (CHINESE_STOP_WORDS.has(normalized)) return false;
  if (isCjkText(cleaned) && cleaned.length > 20) return false;
  if (/^(和|以及|或者|如果|但是|然后|其中|这个|那个|这些|那些)$/u.test(cleaned)) return false;

  return true;
}

function looksLikeSentenceFragment(value) {
  const cleaned = simplifyWhitespace(value);
  if (!cleaned) return false;
  if (RELATION_FALLBACK_PATTERN.test(cleaned)) return true;
  if (cleaned.includes(" 和 ") || cleaned.includes(" 与 ") || cleaned.includes(" 以及 ")) return true;
  if (/[和与及并]/u.test(cleaned) && cleaned.length > 4) return true;
  return SENTENCE_VERBS.some((verb) => cleaned.includes(verb) && cleaned.length > verb.length + 4);
}

function shouldAddTitleAsNode(title) {
  const cleaned = stripGenericAffixes(title);
  if (!cleaned || /测试|test/i.test(cleaned)) return false;
  if (EXACT_TERMS.includes(cleaned)) return true;
  return detectNodeType(cleaned) !== "concept";
}

function truncateText(value, maxLength = 160) {
  const text = simplifyWhitespace(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function splitSentences(text) {
  const normalized = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/([。！？!?；;])/g, "$1\n")
    .replace(/([.])(?=\s+[A-Z\u4e00-\u9fff])/g, "$1\n");

  return normalized
    .split(/\n+/)
    .map((item) => simplifyWhitespace(item))
    .filter(Boolean);
}

function splitListItems(text) {
  const raw = String(text ?? "");
  if (!/(?:,|，|、|\/|;|；|\band\b|\bor\b|以及|并且|与|和)/iu.test(raw)) return [];

  return raw
    .replace(/[(){}\[\]<>「」『』【】]/gu, " ")
    .split(/(?:,|，|、|\/|;|；|\band\b|\bor\b|以及|并且|与|和)/iu)
    .map((item) => stripGenericAffixes(item))
    .filter(Boolean);
}

function addMatchSet(values, matches) {
  for (const match of matches) {
    if (match && isUsefulCandidate(match)) values.push(stripGenericAffixes(match));
  }
}

function extractExactTerms(text) {
  const matches = [];
  for (const term of EXACT_TERMS) {
    if (text.includes(term)) matches.push(term);
  }
  return matches;
}

function extractQuotedCandidates(text) {
  const matches = [];
  const regex = /["“‘'「『]([^"”’'」』]{2,40})["”’'」』]/gu;
  for (const match of text.matchAll(regex)) {
    matches.push(match[1]);
  }
  return matches;
}

function extractLatinCandidates(text) {
  const matches = [];
  const patterns = [
    /\b[A-Z][A-Za-z0-9.+#/-]*(?:\s+[A-Z][A-Za-z0-9.+#/-]*){0,3}\b/g,
    /\b[A-Za-z]+(?:[-_/][A-Za-z0-9]+)+\b/g,
    /\b(?:GPT|API|LLM|SDK|JSON|Node|React|Electron|DeepSeek|ComfyUI|MiniMax|Hermes|SparkNoteAI|Codia|OpenAI|SGLang)\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      matches.push(match[0]);
    }
  }

  return matches;
}

function extractCjkKeywordCandidates(text) {
  const matches = [];
  for (const match of text.matchAll(CHINESE_TECH_PATTERN)) {
    const value = stripGenericAffixes(match[0]);
    if (!value || looksLikeSentenceFragment(value)) continue;
    matches.push(value);
  }
  return matches;
}

function extractCandidatesFromFragment(text) {
  const matches = [];
  const fragment = simplifyWhitespace(toHalfWidth(text));
  if (!fragment) return [];

  addMatchSet(matches, extractExactTerms(fragment));
  addMatchSet(matches, extractQuotedCandidates(fragment));
  addMatchSet(matches, extractLatinCandidates(fragment));
  addMatchSet(matches, extractCjkKeywordCandidates(fragment));
  addMatchSet(matches, splitListItems(fragment));

  if (
    matches.length === 0 &&
    fragment.length <= 24 &&
    !RELATION_FALLBACK_PATTERN.test(fragment) &&
    !/[，。！？!?,;；：:]/u.test(fragment) &&
    isUsefulCandidate(fragment)
  ) {
    matches.push(stripGenericAffixes(fragment));
  }

  const unique = [];
  const seen = new Set();

  for (const item of matches) {
    const cleaned = stripGenericAffixes(item);
    const key = normalizeName(cleaned);
    if (!key || seen.has(key) || looksLikeSentenceFragment(cleaned)) continue;
    seen.add(key);
    unique.push(cleaned);
    if (unique.length >= 8) break;
  }

  return unique;
}

function pickCandidate(candidates, side = "first") {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  return side === "last" ? candidates[candidates.length - 1] : candidates[0];
}

function describeNodeFromSentence(name, sentence) {
  const plain = truncateText(sentence, 180);
  if (!plain) return "";
  if (plain.length <= 24) return plain;

  const normalizedName = normalizeName(name);
  if (!normalizedName) return plain;

  const parts = plain
    .split(/[,，。；;!?！？]/u)
    .map((item) => item.trim())
    .filter(Boolean);

  for (const part of parts) {
    const normalizedPart = normalizeName(part);
    if (normalizedPart.includes(normalizedName) || normalizedName.includes(normalizedPart)) {
      return truncateText(part, 120);
    }
  }

  return plain;
}

function makeEdgeSignature(sourceName, targetName, edgeType) {
  const normalizedType = safeEdgeType(edgeType);
  let left = normalizeName(sourceName);
  let right = normalizeName(targetName);
  if (!left || !right || left === right) return "";

  if (!DIRECTED_EDGE_TYPES.has(normalizedType) && left > right) {
    [left, right] = [right, left];
  }

  return `${left}:${right}:${normalizedType}`;
}

function addEdge(edges, edgeMap, sourceName, targetNames, edgeType, description) {
  const left = stripGenericAffixes(sourceName);
  const targets = Array.isArray(targetNames) ? targetNames : [targetNames];

  for (const targetName of targets) {
    const right = stripGenericAffixes(targetName);
    const signature = makeEdgeSignature(left, right, edgeType);
    if (!signature) continue;

    const existing = edgeMap.get(signature);
    if (existing) {
      existing.strength = Math.max(existing.strength, clampStrength(0.75));
      if (!existing.description && description) existing.description = truncateText(description, 80);
      continue;
    }

    const edge = {
      source_name: left,
      target_name: right,
      edge_type: safeEdgeType(edgeType),
      description: truncateText(description ?? "", 80),
      strength: clampStrength(0.72),
    };
    edgeMap.set(signature, edge);
    edges.push(edge);
  }
}

function extractEdgesFromSentence(sentence, candidates) {
  const edges = [];
  const edgeMap = new Map();

  for (const rule of RELATION_RULES) {
    const match = sentence.match(rule.regex);
    if (!match || typeof match.index !== "number") continue;

    const leftPart = sentence.slice(0, match.index);
    const rightPart = sentence.slice(match.index + match[0].length);
    const leftCandidates = extractCandidatesFromFragment(leftPart);
    const rightCandidates = extractCandidatesFromFragment(rightPart);
    const left = pickCandidate(leftCandidates, "last");

    if (!left) continue;

    if (rule.mode === "list") {
      const targets = rightCandidates.filter((item) => normalizeName(item) !== normalizeName(left));
      if (targets.length > 0) {
        addEdge(edges, edgeMap, left, targets, rule.type, match[0]);
        return edges;
      }
      continue;
    }

    const right = pickCandidate(rightCandidates, "first");
    if (!right || normalizeName(left) === normalizeName(right)) continue;

    if (rule.mode === "belongs-to") {
      addEdge(edges, edgeMap, right, left, rule.type, match[0]);
      return edges;
    }

    addEdge(edges, edgeMap, left, right, rule.type, match[0]);
    return edges;
  }

  if (candidates.length >= 2 && candidates.length <= 3 && sentence.length <= 80) {
    for (let index = 0; index < candidates.length - 1; index += 1) {
      addEdge(edges, edgeMap, candidates[index], candidates[index + 1], "related", "");
    }
  }

  return edges;
}

function scoreCandidate(name, sentence, title) {
  let score = 1;
  if (!name || !sentence) return score;
  if (sentence.includes(name)) score += 1;
  if (title && sentence.includes(title)) score += 0.5;
  if (/^[A-Z]/.test(name)) score += 0.6;
  if (isCjkText(name)) score += Math.min(0.8, name.length * 0.08);
  if (name.length > 4 && name.length <= 18) score += 0.4;
  return score;
}

function ensureCandidate(candidateMap, name, sentence, sourceId, title = "") {
  const cleaned = stripGenericAffixes(name);
  if (!isUsefulCandidate(cleaned)) return null;

  const key = normalizeName(cleaned);
  if (!key) return null;

  const existing = candidateMap.get(key);
  if (existing) {
    existing.score += scoreCandidate(cleaned, sentence, title);
    existing.source_note_ids = uniq([...(existing.source_note_ids || []), ...normalizeSources(sourceId)]);
    const nextDescription = describeNodeFromSentence(cleaned, sentence);
    if (nextDescription && (!existing.description || nextDescription.length > existing.description.length)) {
      existing.description = nextDescription;
    }
    if (existing.node_type === "concept") {
      existing.node_type = detectNodeType(cleaned, existing.node_type);
    }
    return existing;
  }

  const created = {
    name: cleaned,
    node_type: detectNodeType(cleaned),
    description: describeNodeFromSentence(cleaned, sentence),
    source_note_ids: normalizeSources(sourceId),
    score: scoreCandidate(cleaned, sentence, title),
  };
  candidateMap.set(key, created);
  return created;
}

function rankCandidates(candidateMap, edges, maxNodes) {
  const capped = Math.max(4, Math.min(80, Math.trunc(Number(maxNodes) || 24)));
  const edgeDegree = new Map();

  for (const edge of edges) {
    const sourceKey = normalizeName(edge.source_name);
    const targetKey = normalizeName(edge.target_name);
    edgeDegree.set(sourceKey, (edgeDegree.get(sourceKey) || 0) + 1);
    edgeDegree.set(targetKey, (edgeDegree.get(targetKey) || 0) + 1);
  }

  const values = [...candidateMap.values()].sort((left, right) => {
    const leftWeight = left.score + (edgeDegree.get(normalizeName(left.name)) || 0) * 2;
    const rightWeight = right.score + (edgeDegree.get(normalizeName(right.name)) || 0) * 2;
    if (rightWeight !== leftWeight) return rightWeight - leftWeight;
    if (right.name.length !== left.name.length) return right.name.length - left.name.length;
    return left.name.localeCompare(right.name, "zh-Hans-CN");
  });

  const selected = values.slice(0, capped);
  const selectedKeys = new Set(selected.map((item) => normalizeName(item.name)));

  for (const edge of edges) {
    if (selected.length >= capped) break;
    for (const name of [edge.source_name, edge.target_name]) {
      const key = normalizeName(name);
      if (!key || selectedKeys.has(key)) continue;
      const candidate = candidateMap.get(key);
      if (!candidate) continue;
      selected.push(candidate);
      selectedKeys.add(key);
      if (selected.length >= capped) break;
    }
  }

  return { selected, selectedKeys };
}

function finalizeEdges(edges, selectedKeys) {
  const result = [];
  const signatures = new Set();

  for (const edge of edges) {
    const sourceKey = normalizeName(edge.source_name);
    const targetKey = normalizeName(edge.target_name);
    if (!selectedKeys.has(sourceKey) || !selectedKeys.has(targetKey)) continue;

    const signature = makeEdgeSignature(edge.source_name, edge.target_name, edge.edge_type);
    if (!signature || signatures.has(signature)) continue;
    signatures.add(signature);

    result.push({
      source_name: stripGenericAffixes(edge.source_name),
      target_name: stripGenericAffixes(edge.target_name),
      edge_type: safeEdgeType(edge.edge_type),
      description: truncateText(edge.description ?? "", 80),
      strength: clampStrength(edge.strength),
    });
  }

  return result;
}

function extractGraphDocument(text, { title = "", sourceId = "", maxNodes = 24 } = {}) {
  const candidateMap = new Map();
  const rawEdges = [];
  const sentences = splitSentences(text);

  for (const sentence of sentences) {
    const candidates = extractCandidatesFromFragment(sentence);
    for (const candidate of candidates) {
      ensureCandidate(candidateMap, candidate, sentence, sourceId, title);
    }

    const sentenceEdges = extractEdgesFromSentence(sentence, candidates);
    for (const edge of sentenceEdges) {
      rawEdges.push(edge);
      ensureCandidate(candidateMap, edge.source_name, sentence, sourceId, title);
      ensureCandidate(candidateMap, edge.target_name, sentence, sourceId, title);
    }
  }

  if (title && isUsefulCandidate(title) && shouldAddTitleAsNode(title)) {
    ensureCandidate(candidateMap, title, title, sourceId, title);
  }

  const { selected, selectedKeys } = rankCandidates(candidateMap, rawEdges, maxNodes);
  const nodes = selected.map((item) => ({
    name: item.name,
    node_type: safeNodeType(item.node_type),
    description: truncateText(item.description ?? "", 140),
    source_note_ids: normalizeSources(item.source_note_ids),
    is_verified: false,
  }));
  const edges = finalizeEdges(rawEdges, selectedKeys);

  return {
    nodes,
    edges,
    stats: {
      sentences_processed: sentences.length,
      concepts_extracted: nodes.length,
      relationships_discovered: edges.length,
    },
  };
}

function normalizeGraphData(data, { startNodeId = 1, startEdgeId = 1 } = {}) {
  const rawNodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const rawEdges = Array.isArray(data?.edges) ? data.edges : Array.isArray(data?.links) ? data.links : [];
  const sources = normalizeSourceDocuments(data?.sources ?? data?.documents ?? data?.source_documents);

  const nodes = [];
  const edges = [];
  const usedNodeIds = new Set();
  const usedEdgeIds = new Set();
  const rawNodeIdMap = new Map();
  const nameToId = new Map();

  let nextNodeId = Math.max(1, Math.trunc(Number(startNodeId) || 1));
  let nextEdgeId = Math.max(1, Math.trunc(Number(startEdgeId) || 1));

  for (const raw of rawNodes) {
    if (!raw || typeof raw !== "object") continue;
    const name = rawNodeName(raw);
    if (!name) continue;

    const inputId = raw.id ?? raw.node_id ?? raw.nodeId;
    let id = toNumericId(inputId);
    if (!id || usedNodeIds.has(id)) id = nextFreeId(usedNodeIds, nextNodeId);
    else usedNodeIds.add(id);
    nextNodeId = Math.max(nextNodeId, id + 1);

    const createdAt = raw.created_at ?? raw.createdAt ?? nowIso();
    const node = {
      id,
      name: stripGenericAffixes(name),
      node_type: detectNodeType(name, raw.node_type ?? raw.nodeType ?? raw.type ?? raw.group),
      description: String(raw.description ?? raw.summary ?? "").trim(),
      source_note_ids: normalizeSources(
        raw.source_note_ids ??
          raw.sourceNoteIds ??
          raw.source_notes ??
          raw.sourceNotes ??
          raw.source_note_id ??
          raw.sourceNoteId ??
          raw.source_id ??
          raw.sourceId,
      ),
      is_verified: Boolean(raw.is_verified ?? raw.isVerified),
      created_at: createdAt,
      updated_at: raw.updated_at ?? raw.updatedAt ?? createdAt,
    };

    nodes.push(node);
    nameToId.set(normalizeName(name), id);
    rawNodeIdMap.set(String(id), id);
    if (inputId != null) rawNodeIdMap.set(String(inputId), id);
  }

  const resolveNodeId = (value) => {
    const numeric = toNumericId(value);
    if (numeric && usedNodeIds.has(numeric)) return numeric;
    const direct = rawNodeIdMap.get(String(value ?? ""));
    if (direct) return direct;
    return nameToId.get(normalizeName(value));
  };

  const seenEdges = new Set();
  for (const raw of rawEdges) {
    if (!raw || typeof raw !== "object") continue;

    const edgeType = safeEdgeType(raw.edge_type ?? raw.edgeType ?? raw.type);
    let sourceId = resolveNodeId(rawEdgeEndpoint(raw, "source"));
    let targetId = resolveNodeId(rawEdgeEndpoint(raw, "target"));
    if (!sourceId || !targetId || sourceId === targetId) continue;

    if (!DIRECTED_EDGE_TYPES.has(edgeType) && sourceId > targetId) {
      [sourceId, targetId] = [targetId, sourceId];
    }

    const signature = `${sourceId}:${targetId}:${edgeType}`;
    if (seenEdges.has(signature)) continue;
    seenEdges.add(signature);

    const inputId = raw.id ?? raw.edge_id ?? raw.edgeId;
    let id = toNumericId(inputId);
    if (!id || usedEdgeIds.has(id)) id = nextFreeId(usedEdgeIds, nextEdgeId);
    else usedEdgeIds.add(id);
    nextEdgeId = Math.max(nextEdgeId, id + 1);

    const createdAt = raw.created_at ?? raw.createdAt ?? nowIso();
    edges.push({
      id,
      source_node_id: sourceId,
      target_node_id: targetId,
      edge_type: edgeType,
      description: String(raw.description ?? raw.label ?? "").trim(),
      strength: clampStrength(raw.strength ?? raw.weight ?? raw.confidence),
      created_at: createdAt,
      updated_at: raw.updated_at ?? raw.updatedAt ?? createdAt,
    });
  }

  return {
    nodes,
    edges,
    sources,
    nextNodeId,
    nextEdgeId,
  };
}

export {
  DIRECTED_EDGE_TYPES,
  EDGE_TYPES,
  GRAPH_VERSION,
  NODE_TYPES,
  clampStrength,
  clone,
  detectNodeType,
  extractGraphDocument,
  nextFreeId,
  normalizeGraphData,
  normalizeName,
  normalizeSourceDocument,
  normalizeSourceDocuments,
  normalizeSources,
  nowIso,
  safeEdgeType,
  safeNodeType,
  toNumericId,
};
