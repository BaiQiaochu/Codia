// @ts-nocheck
const FIELD_RULES = [
  { key: "productName", patterns: [/^(产品|产品名|项目|品牌|物料)\s*[:：]\s*(.+)$/i] },
  { key: "scene", patterns: [/^(场景|需求场景|测试场景|画面)\s*[:：]\s*(.+)$/i] },
  { key: "style", patterns: [/^(风格|画风|视觉风格)\s*[:：]\s*(.+)$/i] },
  { key: "size", patterns: [/^(尺寸|分辨率|画幅)\s*[:：]\s*(.+)$/i] },
  { key: "rounds", patterns: [/^(轮次|张数|数量)\s*[:：]\s*(.+)$/i] },
  { key: "negativePrompt", patterns: [/^(负面词|负向提示|排除项)\s*[:：]\s*(.+)$/i] },
  { key: "expectations", patterns: [/^(要求|预期|验收标准|测试目标)\s*[:：]\s*(.+)$/i] },
  { key: "notes", patterns: [/^(备注|补充|说明)\s*[:：]\s*(.+)$/i] },
  { key: "rawPrompt", patterns: [/^(提示词|专业提示词|prompt)\s*[:：]\s*(.+)$/i] },
];

function pickMatchedValue(line) {
  for (const rule of FIELD_RULES) {
    for (const pattern of rule.patterns) {
      const match = line.match(pattern);
      if (match) {
        return { key: rule.key, value: (match[2] || "").trim() };
      }
    }
  }
  return null;
}

function normalizeRounds(raw, fallback = 1) {
  const value = Number(String(raw || "").match(/\d+/)?.[0] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function isLikelyAfterSalesCase(text, config = {}) {
  const source = String(text || "").trim();
  if (!source) return false;
  const includeKeywords = config?.wechat?.includeKeywords || [];
  const excludeKeywords = config?.wechat?.excludeKeywords || [];
  if (excludeKeywords.some((keyword) => source.includes(keyword))) return false;
  if (includeKeywords.some((keyword) => source.includes(keyword))) return true;
  return /(?:产品|场景|风格|尺寸|负面词|提示词)\s*[:：]/.test(source);
}

export function shouldMonitorMessage(payload, config = {}) {
  if (!config?.enabled) return false;
  if (!payload?.platform) return false;
  if (payload.platform !== "wechat") return false;
  if (!config?.wechat?.enabled) return false;
  if (payload.isGroup) {
    const monitored = config?.wechat?.monitoredGroups || [];
    if (!Array.isArray(monitored) || monitored.length === 0) return true;
    return monitored.includes(payload.groupName) || monitored.includes(payload.chatId) || monitored.includes(payload.sessionKey);
  }
  return true;
}

export function parseAfterSalesMessage(text, config = {}) {
  const source = String(text || "").replace(/\r\n/g, "\n").trim();
  const parsed = {
    productName: "",
    scene: "",
    style: config?.defaults?.style || "",
    size: config?.defaults?.size || "",
    rounds: config?.defaults?.rounds || 1,
    negativePrompt: config?.defaults?.negativePrompt || "",
    expectations: "",
    notes: "",
    rawPrompt: "",
  };

  const unmatched = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const matched = pickMatchedValue(trimmed);
    if (!matched) {
      unmatched.push(trimmed);
      continue;
    }
    if (matched.key === "rounds") {
      parsed.rounds = normalizeRounds(matched.value, parsed.rounds);
    } else {
      parsed[matched.key] = matched.value;
    }
  }

  if (!parsed.rawPrompt && unmatched.length > 0) {
    parsed.rawPrompt = unmatched.join("；");
  }
  if (!parsed.scene && parsed.rawPrompt) {
    parsed.scene = parsed.rawPrompt;
  }

  const missing = [];
  if (!parsed.productName) missing.push("productName");
  if (!parsed.scene) missing.push("scene");

  return {
    recognized: isLikelyAfterSalesCase(source, config),
    confidence: missing.length === 0 ? "high" : parsed.rawPrompt ? "medium" : "low",
    missingFields: missing,
    parsedCase: parsed,
  };
}
