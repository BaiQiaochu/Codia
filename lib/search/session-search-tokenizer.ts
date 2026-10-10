import { createRequire } from "module";

const require = createRequire(import.meta.url);

const PUNCTUATION_RE = /^[\p{P}\p{S}\s]+$/u;
const ASCII_WORD_RE = /[a-z0-9_][a-z0-9_.-]*/giu;
const CJK_RUN_RE = /[\p{Script=Han}]+/gu;
const MIXED_ASCII_CJK_RE = /[a-z0-9_.-]+[\p{Script=Han}]+|[\p{Script=Han}]+[a-z0-9_.-]+/giu;
const SPACED_TERM_RE = /[^\s]+/gu;

const CUSTOM_WORDS = [
  "session_search 1000 nz",
  "session 1000 eng",
  "SessionFile 1000 eng",
  "A2A通信 1000 nz",
  "聊天记录 1000 nz",
  "搜索不到 1000 v",
  "Agent 1000 eng",
  "CodeX 1000 eng",
  "Codia 1000 eng",
  "CODIA_HOME 1000 eng",
  "Bridge 1000 eng",
  "MCP 1000 eng",
  "RC 1000 eng",
  "better-sqlite3 1000 eng",
];

let jiebaInstance: any | null | undefined = undefined;

export class SessionSearchTokenizerUnavailableError extends Error {
  cause: unknown;

  constructor(cause: unknown) {
    super("session_search_tokenizer_unavailable");
    this.name = "SessionSearchTokenizerUnavailableError";
    this.cause = cause;
  }
}

export function normalizeSessionSearchText(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeSessionSearchQuery(query: unknown) {
  const normalized = normalizeSessionSearchText(query);
  if (!normalized) return [];

  const terms = new Set<string>();
  addToken(terms, normalized);

  for (const match of normalized.matchAll(SPACED_TERM_RE)) {
    addToken(terms, match[0]);
  }
  for (const match of normalized.matchAll(ASCII_WORD_RE)) {
    addToken(terms, match[0]);
  }
  for (const match of normalized.matchAll(MIXED_ASCII_CJK_RE)) {
    addToken(terms, match[0]);
    addMixedCjkFragments(terms, match[0]);
  }
  for (const match of normalized.matchAll(CJK_RUN_RE)) {
    addCjkFragments(terms, match[0]);
  }

  const jieba = getOptionalJieba();
  if (jieba) {
    for (const token of jieba.cutForSearch(normalized, true)) {
      addToken(terms, normalizeSessionSearchText(token));
    }
  }

  return [...terms];
}

function getOptionalJieba() {
  if (jiebaInstance !== undefined) return jiebaInstance;

  try {
    // Optional native tokenizer. The fallback above is intentionally good
    // enough for stable desktop builds that do not ship @node-rs/jieba.
    const { Jieba } = require("@node-rs/jieba");
    const { dict } = require("@node-rs/jieba/dict");
    const jieba = Jieba.withDict(dict);
    if (typeof jieba.loadDict === "function") {
      jieba.loadDict(Buffer.from(CUSTOM_WORDS.join("\n"), "utf8"));
    }
    jiebaInstance = jieba;
  } catch {
    jiebaInstance = null;
  }
  return jiebaInstance;
}

function addCjkFragments(terms: Set<string>, value: string) {
  addToken(terms, value);
  if (value.length < 2) return;
  for (let size = 2; size <= Math.min(4, value.length); size += 1) {
    for (let i = 0; i <= value.length - size; i += 1) {
      addToken(terms, value.slice(i, i + size));
    }
  }
}

function addMixedCjkFragments(terms: Set<string>, value: string) {
  const prefixMatch = /^([a-z0-9_.-]+)([\p{Script=Han}]+)$/u.exec(value);
  if (prefixMatch) {
    const [, prefix, cjk] = prefixMatch;
    for (let size = 2; size <= Math.min(4, cjk.length); size += 1) {
      addToken(terms, `${prefix}${cjk.slice(0, size)}`);
    }
    return;
  }

  const suffixMatch = /^([\p{Script=Han}]+)([a-z0-9_.-]+)$/u.exec(value);
  if (suffixMatch) {
    const [, cjk, suffix] = suffixMatch;
    for (let size = 2; size <= Math.min(4, cjk.length); size += 1) {
      addToken(terms, `${cjk.slice(-size)}${suffix}`);
    }
  }
}

function addToken(terms: Set<string>, token: unknown) {
  const value = normalizeSessionSearchText(token);
  if (!value || PUNCTUATION_RE.test(value)) return;
  if (value.length === 1 && /^[\p{Script=Han}]$/u.test(value)) return;
  terms.add(value);
}
