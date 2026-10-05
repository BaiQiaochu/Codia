// @ts-nocheck
import fs from "fs/promises";
import path from "path";
import { Type, StringEnum } from "../pi-sdk/index.ts";
import { sessionFilesCacheDir } from "../session-files/session-file-registry.ts";
import { serializeSessionFile } from "../session-files/session-file-response.ts";
import { getToolSessionPath } from "./tool-session.ts";
import { t } from "../i18n.ts";
import { sanitizeArtifactFilename, sanitizeFilenameBase } from "../../shared/filename-sanitizer.ts";

let _counter = 0;

export function createArtifactTool({ getGsapHome, getHanakoHome, registerSessionFile, getSessionPath } = {}) {
  return {
    name: "create_artifact",
    label: t("toolDef.artifact.label"),
    description: t("toolDef.artifact.description"),
    parameters: Type.Object({
      type: StringEnum(
        ["html", "code", "markdown"],
        { description: t("toolDef.artifact.typeDesc") },
      ),
      title: Type.String({ description: t("toolDef.artifact.titleDesc") }),
      content: Type.String({ description: t("toolDef.artifact.contentDesc") }),
      language: Type.Optional(
        Type.String({
          description: t("toolDef.artifact.languageDesc"),
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const artifactId = `art-${Date.now()}-${++_counter}`;
      const artifactFile = await persistArtifactFile({
        artifactId,
        params,
        ctx,
        getGsapHome,
        getHanakoHome,
        registerSessionFile,
        getSessionPath,
      });
      return {
        content: [{ type: "text", text: t("error.artifactCreated", { title: params.title }) }],
        details: {
          artifactId,
          type: params.type,
          title: params.title,
          content: params.content,
          language: params.language || null,
          ...(artifactFile ? flattenArtifactFile(artifactFile) : {}),
          ...(artifactFile ? { artifactFile } : {}),
        },
      };
    },
  };
}

async function persistArtifactFile({
  artifactId,
  params,
  ctx,
  getGsapHome,
  getHanakoHome,
  registerSessionFile,
  getSessionPath,
}) {
  if (typeof registerSessionFile !== "function") return null;
  const sessionPath = getToolSessionPath(ctx) || ctx?.sessionPath || getSessionPath?.() || null;
  if (!sessionPath) return null;
  const gsapHome = getGsapHome?.() || getHanakoHome?.() || null;
  if (!gsapHome) throw new Error("create_artifact requires gsapHome to persist generated artifacts");

  const ext = artifactExt(params);
  const label = sanitizeArtifactFilename(params.title || "artifact", ext);
  const filename = `${safeFilenameBase(params.title || "artifact")}-${artifactId}.${ext}`;
  const dir = sessionFilesCacheDir(gsapHome, sessionPath);
  const filePath = path.join(dir, filename);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, params.content || "", "utf-8");

  return serializeSessionFile(await registerSessionFile({
    sessionPath,
    filePath,
    label,
    origin: "agent_artifact",
    storageKind: "managed_cache",
  }));
}

function flattenArtifactFile(file) {
  if (!file) return {};
  const fileId = file.fileId || file.id || null;
  return {
    ...(fileId ? { fileId } : {}),
    ...(file.filePath ? { filePath: file.filePath } : {}),
    ...(file.label ? { label: file.label } : {}),
    ...(file.ext !== undefined ? { ext: file.ext } : {}),
    ...(file.mime ? { mime: file.mime } : {}),
    ...(file.kind ? { kind: file.kind } : {}),
    ...(file.origin ? { origin: file.origin } : {}),
    ...(file.storageKind ? { storageKind: file.storageKind } : {}),
    ...(file.status ? { status: file.status } : {}),
    ...(file.missingAt !== undefined ? { missingAt: file.missingAt } : {}),
  };
}

function artifactExt(params) {
  if (params.type === "html") return "html";
  if (params.type === "markdown") return "md";
  const language = String(params.language || "").trim().toLowerCase();
  return CODE_LANGUAGE_EXT[language] || "txt";
}

const CODE_LANGUAGE_EXT = {
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  jsx: "jsx",
  tsx: "tsx",
  python: "py",
  py: "py",
  shell: "sh",
  bash: "sh",
  sh: "sh",
  json: "json",
  yaml: "yaml",
  yml: "yml",
  css: "css",
  sql: "sql",
  rust: "rs",
  go: "go",
  java: "java",
};

function safeFilenameBase(title) {
  return sanitizeFilenameBase(title, { fallback: "artifact", maxLength: 80 });
}
