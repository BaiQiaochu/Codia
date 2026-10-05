import { Hono } from "hono";
import { routeError, strictJson } from "../hono-helpers.ts";

const MAX_OPTIMIZE_PROMPT_CHARS = 12_000;
const MAX_RESEARCH_TOPIC_CHARS = 4_000;
const MAX_RESEARCH_CONTEXT_CHARS = 8_000;

const RESEARCH_MODE_PLANS = {
  quick: {
    label: "快速",
    maxSearchResults: 6,
    minSources: 3,
    fetchDepth: 2,
    sourceTypes: ["official", "news", "documentation"],
  },
  deep: {
    label: "深入",
    maxSearchResults: 12,
    minSources: 6,
    fetchDepth: 5,
    sourceTypes: ["official", "documentation", "news", "industry-report"],
  },
  academic: {
    label: "学术",
    maxSearchResults: 16,
    minSources: 8,
    fetchDepth: 6,
    sourceTypes: ["paper", "official", "standard", "research-report"],
  },
  library: {
    label: "文库",
    maxSearchResults: 14,
    minSources: 6,
    fetchDepth: 5,
    sourceTypes: ["documentation", "manual", "report", "knowledge-base"],
  },
} as const;

const RESEARCH_EXPORT_FORMAT_ALIASES: Record<string, string> = {
  doc: "word",
  docx: "word",
  word: "word",
  md: "markdown",
  markdown: "markdown",
  pdf: "pdf",
  ppt: "ppt",
  pptx: "ppt",
};

type ResearchMode = keyof typeof RESEARCH_MODE_PLANS;

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isZhLocale(locale: string): boolean {
  return /^zh\b/i.test(locale);
}

export function normalizeResearchMode(value: unknown): ResearchMode {
  const mode = asTrimmedString(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(RESEARCH_MODE_PLANS, mode)
    ? mode as ResearchMode
    : "deep";
}

export function normalizeResearchExportFormats(value: unknown): string[] {
  const rawFormats = Array.isArray(value)
    ? value
    : asTrimmedString(value)
      ? asTrimmedString(value).split(/[,\s]+/)
      : [];
  const formats = rawFormats
    .map((item) => RESEARCH_EXPORT_FORMAT_ALIASES[asTrimmedString(item).toLowerCase()])
    .filter(Boolean);
  const uniqueFormats = Array.from(new Set(formats));
  return uniqueFormats.length > 0 ? uniqueFormats : ["word", "pdf"];
}

export function buildResearchSearchPlan(mode: ResearchMode) {
  return {
    mode,
    ...RESEARCH_MODE_PLANS[mode],
  };
}

export function buildResearchPrompt(options: {
  topic: string;
  mode: ResearchMode;
  locale?: string;
  exportFormats?: string[];
  context?: string;
  generatedAt?: string;
}): string {
  const locale = asTrimmedString(options.locale) || "zh";
  const searchPlan = buildResearchSearchPlan(options.mode);
  const responseLanguage = isZhLocale(locale)
    ? "Write the final report in Simplified Chinese unless source titles must remain in their original language."
    : "Write the final report in English unless the user explicitly asks otherwise.";
  const context = asTrimmedString(options.context);
  const exportFormats = (options.exportFormats?.length ? options.exportFormats : ["word", "pdf"]).join(", ");

  return [
    "You are the Research Mode executor for the current application.",
    responseLanguage,
    "",
    "Use the available tools in this order:",
    "1. Use web_search to find current and authoritative sources.",
    "2. Use web_fetch for the most important URLs when the search snippet is not enough.",
    "3. Do not invent citations, URLs, dates, or source titles.",
    "",
    "Research target:",
    options.topic,
    "",
    "Research mode:",
    JSON.stringify(searchPlan, null, 2),
    "",
    context ? `Additional user context:\n${context}` : "",
    "",
    "Evidence requirements:",
    `- Use at least ${searchPlan.minSources} useful sources when available.`,
    "- Every important factual claim must include citations with title, URL, source type, observed date/time, and confidence: high, medium, or low.",
    "- Prefer official documentation, standards, research papers, product pages, and dated reports over unsourced summaries.",
    "- Mark stale, unavailable, contradictory, or low-confidence evidence explicitly.",
    "",
    "Output structure:",
    "1. Executive summary",
    "2. Key findings",
    "3. Comparison table",
    "4. Evidence and citations",
    "5. Risks and uncertainties",
    `6. Export-ready outline for: ${exportFormats}`,
    "7. Suggested follow-up questions",
    "",
    `Generated at: ${options.generatedAt || new Date().toISOString()}`,
  ].filter(Boolean).join("\n");
}

export function buildPromptOptimizationPrompt(prompt: string, locale = "zh"): string {
  const responseLanguage = isZhLocale(locale)
    ? "使用简体中文输出，除非原提示词明确要求其他语言。"
    : "Output in the same language as the user's prompt unless it explicitly asks for another language.";
  return [
    "你是一个提示词优化器。你的任务是把用户草稿改写成更清晰、可执行、约束明确的提示词。",
    responseLanguage,
    "",
    "要求：",
    "- 保留用户原意，不新增与原意冲突的目标。",
    "- 补齐必要的主体、目标、上下文、风格、格式、限制和验收标准。",
    "- 如果原提示词用于图像/视频/音频生成，补齐画面主体、构图、风格、光线、尺寸/比例和负面约束。",
    "- 如果原提示词用于编程/写作/分析，补齐输入、输出格式、边界条件和质量标准。",
    "- 不要执行用户任务，不要解释优化思路，不要添加寒暄。",
    "- 只输出优化后的提示词。",
    "",
    "<original_prompt>",
    prompt,
    "</original_prompt>",
  ].join("\n");
}

export function normalizeOptimizedPromptReply(reply: unknown, fallback = ""): string {
  let text = asTrimmedString(reply);
  const original = asTrimmedString(fallback);
  if (!text) return original;

  for (let i = 0; i < 4; i += 1) {
    text = text
      .replace(/^```[a-z0-9_-]*\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    text = text
      .replace(/^(?:优化后(?:的)?提示词|优化提示词|改写后(?:的)?提示词|optimized prompt|rewritten prompt|prompt)\s*[:：]\s*/i, "")
      .trim();
  }
  if (
    (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }

  return text || original;
}

export function createPromptsRoute(engine: any) {
  const route = new Hono();

  route.post("/prompts/optimize", async (c) => {
    try {
      const body = await strictJson(c);
      const prompt = asTrimmedString(body?.prompt);
      if (!prompt) return c.json({ error: "prompt is required" }, 400);
      if ([...prompt].length > MAX_OPTIMIZE_PROMPT_CHARS) {
        return c.json({
          error: "prompt is too long",
          maxLength: MAX_OPTIMIZE_PROMPT_CHARS,
        }, 400);
      }
      if (typeof engine?.executeIsolated !== "function") {
        return c.json({ error: "prompt optimizer is unavailable" }, 503);
      }

      const sessionPath = asTrimmedString(body?.sessionPath) || null;
      const requestedAgentId = asTrimmedString(body?.agentId) || null;
      const sessionAgentId = sessionPath ? engine.agentIdFromSessionPath?.(sessionPath) || null : null;
      const agentId = requestedAgentId || sessionAgentId || engine.currentAgentId || null;
      const locale = asTrimmedString(body?.locale) || "zh";

      const result = await engine.executeIsolated(
        buildPromptOptimizationPrompt(prompt, locale),
        {
          ...(agentId ? { agentId } : {}),
          ...(sessionPath ? { parentSessionPath: sessionPath } : {}),
          toolFilter: [],
          builtinFilter: [],
          withMemory: false,
          permissionMode: "read_only",
          operation: "prompt_optimize",
        },
      );

      if (result?.error && !result?.replyText) {
        return c.json({ error: result.error }, 500);
      }

      const optimizedPrompt = normalizeOptimizedPromptReply(result?.replyText, prompt);
      return c.json({
        ok: true,
        originalPrompt: prompt,
        optimizedPrompt,
      });
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.post("/prompts/research", async (c) => {
    try {
      const body = await strictJson(c);
      const topic = asTrimmedString(body?.topic || body?.query);
      if (!topic) return c.json({ error: "topic is required" }, 400);
      if ([...topic].length > MAX_RESEARCH_TOPIC_CHARS) {
        return c.json({
          error: "topic is too long",
          maxLength: MAX_RESEARCH_TOPIC_CHARS,
        }, 400);
      }
      if (typeof engine?.executeIsolated !== "function") {
        return c.json({ error: "research mode is unavailable" }, 503);
      }

      const context = asTrimmedString(body?.context || body?.constraints);
      if ([...context].length > MAX_RESEARCH_CONTEXT_CHARS) {
        return c.json({
          error: "context is too long",
          maxLength: MAX_RESEARCH_CONTEXT_CHARS,
        }, 400);
      }

      const sessionPath = asTrimmedString(body?.sessionPath) || null;
      const requestedAgentId = asTrimmedString(body?.agentId) || null;
      const sessionAgentId = sessionPath ? engine.agentIdFromSessionPath?.(sessionPath) || null : null;
      const agentId = requestedAgentId || sessionAgentId || engine.currentAgentId || null;
      const locale = asTrimmedString(body?.locale) || "zh";
      const mode = normalizeResearchMode(body?.mode);
      const exportFormats = normalizeResearchExportFormats(body?.exportFormats);
      const generatedAt = new Date().toISOString();
      const searchPlan = buildResearchSearchPlan(mode);

      const result = await engine.executeIsolated(
        buildResearchPrompt({
          topic,
          mode,
          locale,
          exportFormats,
          context,
          generatedAt,
        }),
        {
          ...(agentId ? { agentId } : {}),
          ...(sessionPath ? { parentSessionPath: sessionPath } : {}),
          toolFilter: ["web_search", "web_fetch"],
          builtinFilter: [],
          withMemory: false,
          permissionMode: "read_only",
          operation: "research_mode",
        },
      );

      const report = asTrimmedString(result?.replyText);
      if (result?.error && !report) {
        return c.json({ error: result.error }, 500);
      }
      if (!report) {
        return c.json({ error: "empty research report" }, 500);
      }

      return c.json({
        ok: true,
        topic,
        mode,
        searchPlan,
        exportFormats,
        generatedAt,
        report,
        sessionPath: result?.sessionPath || null,
      });
    } catch (err) {
      return routeError(c, err);
    }
  });

  return route;
}
