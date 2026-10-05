// @ts-nocheck
import { Type } from "@sinclair/typebox";
import { t } from "../i18n.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TITLE_META_RE = /^<!--\s*experience-title:\s*([A-Za-z0-9_-]+)\s*-->$/;

function tr(key, fallback, vars) {
  const value = t(key, vars);
  return value === key ? fallback : value;
}

export function rebuildIndex(experienceDir, indexPath) {
  const docs = listExperienceDocuments(experienceDir);
  if (docs.length === 0) {
    try {
      fs.writeFileSync(indexPath, "", "utf-8");
    } catch {
      // Index rebuild is best-effort when the parent directory is unavailable.
    }
    return;
  }

  const blocks = [];

  for (const doc of docs) {
    const entries = doc.body
      .split("\n")
      .filter((line) => /^\d+\.\s/.test(line.trim()))
      .map((line) => line.replace(/^\d+\.\s*/, "").trim());

    if (entries.length === 0) continue;

    const snippets = entries.map((entry) =>
      entry.length > 20 ? `${entry.slice(0, 20)}...` : entry,
    );
    let desc = snippets.join("; ");
    if (desc.length > 120) desc = `${desc.slice(0, 117)}...`;

    blocks.push(
      `# ${doc.title} (${entries.length})\n${desc}\n-> experience/${doc.file}`,
    );
  }

  fs.writeFileSync(indexPath, `${blocks.join("\n\n")}\n`, "utf-8");
}

export function recordEntry(experienceDir, indexPath, category, content) {
  const safeCategory = normalizeExperienceCategory(category);
  if (!fs.existsSync(experienceDir)) {
    fs.mkdirSync(experienceDir, { recursive: true });
  }

  const existingDoc = findExperienceDocument(experienceDir, safeCategory);
  const filePath = existingDoc?.filePath || path.join(experienceDir, buildExperienceStorageFileName(safeCategory));
  const existing = existingDoc?.body || readFile(filePath);

  if (existing.includes(content)) {
    return { added: false, reason: "duplicate" };
  }

  const lines = existing.split("\n").filter((line) => /^\d+\.\s/.test(line.trim()));
  const nextNum = lines.length + 1;
  const newLine = `${nextNum}. ${content}`;
  const updated = existing.trimEnd()
    ? `${existing.trimEnd()}\n${newLine}\n`
    : `${newLine}\n`;

  fs.writeFileSync(filePath, serializeExperienceDocument(safeCategory, updated), "utf-8");
  rebuildIndex(experienceDir, indexPath);

  return { added: true };
}

export function syncExperienceCategories(experienceDir, indexPath, categories) {
  fs.mkdirSync(experienceDir, { recursive: true });

  const existingDocs = listExperienceDocuments(experienceDir);
  const existingByTitle = new Map(existingDocs.map((doc) => [doc.title, doc]));
  const nextFiles = new Set();

  for (const [rawCategory, rawBody] of categories) {
    const category = normalizeExperienceCategory(rawCategory);
    const body = String(rawBody || "").trim();
    if (!body) continue;

    const existing = existingByTitle.get(category);
    const fileName = existing?.file || buildExperienceStorageFileName(category);
    const filePath = path.join(experienceDir, fileName);
    nextFiles.add(fileName);
    fs.writeFileSync(filePath, serializeExperienceDocument(category, body), "utf-8");
  }

  for (const doc of existingDocs) {
    if (!nextFiles.has(doc.file)) {
      try {
        fs.unlinkSync(doc.filePath);
      } catch {
        // Ignore files removed by another process.
      }
    }
  }

  rebuildIndex(experienceDir, indexPath);
}

function isExperienceEnabled(isEnabled) {
  if (typeof isEnabled !== "function") return false;
  try {
    return isEnabled() === true;
  } catch {
    return false;
  }
}

function pausedResult() {
  return {
    content: [{ type: "text", text: tr("error.expPaused", "Experience is paused.") }],
    details: { paused: true },
  };
}

export function createExperienceTools(agentDir, opts = {}) {
  const experienceDir = path.join(agentDir, "experience");
  const indexPath = path.join(agentDir, "experience.md");
  const { isEnabled } = opts;

  const recallTool = {
    name: "recall_experience",
    label: t("toolDef.experience.recallLabel"),
    description: t("toolDef.experience.recallDescription"),
    parameters: Type.Object({
      category: Type.Optional(
        Type.String({ description: t("toolDef.experience.recallCategoryDesc") }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      if (!isExperienceEnabled(isEnabled)) return pausedResult();

      const category = params.category?.trim();

      if (!category) {
        const index = readFile(indexPath);
        if (!index.trim()) {
          return {
            content: [{ type: "text", text: t("error.expEmpty") }],
            details: {},
          };
        }
        return {
          content: [{ type: "text", text: index }],
          details: {},
        };
      }

      let doc = null;
      try {
        doc = findExperienceDocument(experienceDir, category);
      } catch {
        // Invalid categories should behave like missing categories for recall.
      }
      if (!doc || !doc.body.trim()) {
        return {
          content: [
            { type: "text", text: t("error.expCategoryNotFound", { category }) },
          ],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: `# ${doc.title}\n\n${doc.body}` }],
        details: { category: doc.title },
      };
    },
  };

  const recordTool = {
    name: "record_experience",
    label: t("toolDef.experience.recordLabel"),
    description: t("toolDef.experience.recordDescription"),
    parameters: Type.Object({
      category: Type.String({
        description: t("toolDef.experience.recordCategoryDesc"),
      }),
      content: Type.String({
        description: t("toolDef.experience.recordContentDesc"),
      }),
    }),
    execute: async (_toolCallId, params) => {
      if (!isExperienceEnabled(isEnabled)) return pausedResult();

      const category = params.category.replace(/^#+\s*/, "").trim();
      const content = params.content.trim();

      if (!category || !content) {
        return {
          content: [{ type: "text", text: t("error.expEmptyInput") }],
          details: {},
        };
      }

      let result;
      try {
        result = recordEntry(experienceDir, indexPath, category, content);
      } catch (err) {
        if (err.message === "invalid experience category") {
          return {
            content: [{ type: "text", text: err.message }],
            details: {},
          };
        }
        throw err;
      }

      if (!result.added) {
        return {
          content: [{ type: "text", text: t("error.expDuplicate") }],
          details: {},
        };
      }

      return {
        content: [
          { type: "text", text: t("error.expRecorded", { category, content }) },
        ],
        details: { category, content },
      };
    },
  };

  return [recallTool, recordTool];
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

export function normalizeExperienceCategory(category) {
  const title = String(category ?? "").trim();
  if (!title) throw new Error("invalid experience category");
  if (/[\0\r\n]/.test(title)) throw new Error("invalid experience category");
  if (title === "." || title === "..") throw new Error("invalid experience category");
  if (title.includes("/") || title.includes("\\") || title.includes("..")) {
    throw new Error("invalid experience category");
  }
  if (/^[A-Za-z]:/.test(title)) throw new Error("invalid experience category");
  return title;
}

export function buildExperienceStorageFileName(category) {
  const title = normalizeExperienceCategory(category);
  const stem = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const hash = crypto.createHash("sha256").update(title).digest("hex").slice(0, 10);
  return `${stem || "experience"}-${hash}.md`;
}

function encodeExperienceTitle(title) {
  return Buffer.from(title, "utf-8").toString("base64url");
}

function decodeExperienceTitle(encoded) {
  return Buffer.from(encoded, "base64url").toString("utf-8");
}

function serializeExperienceDocument(title, body) {
  return `<!-- experience-title: ${encodeExperienceTitle(title)} -->\n${body.trimEnd()}\n`;
}

export function parseExperienceDocument(content, fallbackTitle) {
  const lines = content.split("\n");
  const metaMatch = lines[0]?.match(TITLE_META_RE);
  if (!metaMatch) {
    return { title: fallbackTitle, body: content.trimEnd() };
  }

  try {
    const title = normalizeExperienceCategory(decodeExperienceTitle(metaMatch[1]));
    return {
      title,
      body: lines.slice(1).join("\n").replace(/^\n+/, "").trimEnd(),
    };
  } catch {
    return { title: fallbackTitle, body: content.trimEnd() };
  }
}

export function listExperienceDocuments(experienceDir) {
  if (!fs.existsSync(experienceDir)) return [];

  let files;
  try {
    files = fs.readdirSync(experienceDir).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return [];
  }

  return files.map((file) => {
    const filePath = path.join(experienceDir, file);
    const fallbackTitle = file.replace(/\.md$/, "");
    const { title, body } = parseExperienceDocument(readFile(filePath), fallbackTitle);
    return { file, filePath, title, body };
  });
}

export function findExperienceDocument(experienceDir, category) {
  const title = normalizeExperienceCategory(category);
  return listExperienceDocuments(experienceDir).find((doc) => doc.title === title) || null;
}
