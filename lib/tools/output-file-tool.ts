// @ts-nocheck
/**
 * output-file-tool.ts — 文件交付工具（stage_files）
 *
 * stage_files 只声明“这些 session 文件已经可交付”，具体桌面展示、
 * Bridge 发送、移动端渲染由消费端决定。
 *
 * 参数：{ filepaths: string[] } 或 { fileIds: string[] }
 * 同时向下兼容旧的单文件调用：{ filePath: string, fileId?: string, label?: string }
 */
import fs from "fs";
import path from "path";
import { Type } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import { getToolSessionPath } from "./tool-session.ts";

/** 修正 LLM 常见的路径问题：转义空格、URL 编码、多余引号 */
function sanitizePath(p) {
  p = String(p || "").trim().replace(/^["']|["']$/g, "");
  p = p.replace(/\\ /g, " ");
  if (p.includes("%20")) {
    try { p = decodeURIComponent(p); } catch {}
  }
  return p;
}

export function createStageFilesTool({ registerSessionFile, resolveSessionFile, getSessionPath } = {}) {
  const description = `${t("toolDef.outputFile.description")} Call this tool when you need to hand one or more files to the user, present them on desktop, or send them through Bridge/remote platforms. Prefer fileIds for files already registered in the current session. Use local absolute filepaths only for files that are not yet SessionFiles. Do not merely mention file paths in text, and do not decide how the target platform should render or send the file; consumers choose the platform-specific delivery.`;
  return {
    name: "stage_files",
    label: t("toolDef.outputFile.label"),
    description,
    parameters: Type.Object({
      fileIds: Type.Optional(Type.Array(Type.String(), {
        minItems: 1,
        description: "SessionFile ids to deliver. Prefer this for files already shown by current_status or returned by another tool.",
      })),
      fileId: Type.Optional(Type.String({ description: "(Compat) Single SessionFile id to deliver. Prefer fileIds for new calls." })),
      filepaths: Type.Optional(Type.Array(Type.String(), {
        minItems: 1,
        description: `${t("toolDef.outputFile.filepathsDesc")} Use local absolute file paths only when no SessionFile id is available. StageFile registers these paths for desktop, Bridge, and future mobile consumers.`,
      })),
      // 向下兼容旧接口
      filePath: Type.Optional(Type.String({ description: `${t("toolDef.outputFile.filePathDesc")} Prefer filepaths for new calls.` })),
      label: Type.Optional(Type.String({ description: t("toolDef.outputFile.labelDesc") })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const results = [];
      const errors = [];
      const sessionPath = getToolSessionPath(ctx) || ctx?.sessionPath || getSessionPath?.() || null;

      let fileIds = params.fileIds;
      if (!fileIds || fileIds.length === 0) {
        fileIds = params.fileId ? [params.fileId] : [];
      }

      for (const fileId of fileIds || []) {
        if (!fileId || typeof fileId !== "string") continue;
        if (typeof resolveSessionFile !== "function") {
          errors.push("stage_files requires a SessionFile resolver to deliver fileIds");
          continue;
        }
        try {
          const sessionFile = await resolveSessionFile(fileId, { sessionPath });
          if (!sessionFile) {
            errors.push(`SessionFile not found: ${fileId}`);
            continue;
          }

          const resolvedPath = sessionFile.filePath || sessionFile.realPath || "";
          const label = params.label || sessionFile.label || sessionFile.displayName || sessionFile.filename || fileId;
          const ext = sessionFile.ext || path.extname(sessionFile.filename || resolvedPath || "").toLowerCase().replace(".", "");
          const effectiveSessionPath = sessionPath || sessionFile.sessionPath || null;
          let deliveredFile = sessionFile;

          if (
            typeof registerSessionFile === "function"
            && effectiveSessionPath
            && resolvedPath
            && path.isAbsolute(resolvedPath)
            && fs.existsSync(resolvedPath)
          ) {
            deliveredFile = await registerSessionFile({
              sessionPath: effectiveSessionPath,
              filePath: resolvedPath,
              label,
              origin: "stage_files",
            });
          }

          results.push(toStageFileResult(deliveredFile, { filePath: resolvedPath, label, ext }));
        } catch (err) {
          errors.push(err?.message || String(err));
        }
      }

      let paths = params.filepaths;
      if (!paths || paths.length === 0) {
        paths = params.filePath ? [params.filePath] : [];
      }

      for (const raw of paths) {
        const fp = sanitizePath(raw);

        if (!path.isAbsolute(fp)) {
          errors.push(t("error.outputFileNotAbsolute", { path: fp }));
          continue;
        }
        if (!fs.existsSync(fp)) {
          errors.push(t("error.outputFileNotFound", { path: fp }));
          continue;
        }

        const displayLabel = path.basename(fp);
        const ext = path.extname(fp).toLowerCase().replace(".", "");
        const label = params.label || displayLabel;
        if (registerSessionFile) {
          if (!sessionPath) {
            errors.push("stage_files requires an active sessionPath to register files");
            continue;
          }
          try {
            const sessionFile = await registerSessionFile({
              sessionPath,
              filePath: fp,
              label,
              origin: "stage_files",
            });
            results.push(toStageFileResult(sessionFile, { filePath: fp, label, ext }));
          } catch (err) {
            errors.push(err?.message || String(err));
          }
        } else {
          results.push({ filePath: fp, label, ext });
        }
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: errors.join("\n") || t("error.outputFileNeedPaths") }],
          details: {},
        };
      }

      const summary = results.map(r => r.label).join(", ");
      return {
        content: [{ type: "text", text: t("error.outputFilePresented", { summary }) }],
        details: {
          files: results,
          media: {
            ...(results.some(r => r.fileId) ? { items: results.map(toMediaItem).filter(Boolean) } : {}),
            mediaUrls: results.map(r => r.filePath).filter(Boolean),
          },
        },
      };
    },
  };
}

function toStageFileResult(sessionFile, legacy) {
  const fileId = sessionFile?.id || sessionFile?.fileId || null;
  return {
    ...(fileId ? { id: fileId, fileId } : {}),
    filePath: sessionFile?.filePath || legacy.filePath,
    ...(sessionFile?.realPath ? { realPath: sessionFile.realPath } : {}),
    label: legacy.label || sessionFile?.displayName || sessionFile?.label,
    ...(sessionFile?.displayName ? { displayName: sessionFile.displayName } : {}),
    ...(sessionFile?.filename ? { filename: sessionFile.filename } : {}),
    ext: sessionFile?.ext || legacy.ext || "",
    ...(sessionFile?.mime ? { mime: sessionFile.mime } : {}),
    ...(sessionFile?.size !== undefined ? { size: sessionFile.size } : {}),
    ...(sessionFile?.kind ? { kind: sessionFile.kind } : {}),
    ...(sessionFile?.sessionPath ? { sessionPath: sessionFile.sessionPath } : {}),
    ...(sessionFile?.origin ? { origin: sessionFile.origin } : {}),
    ...(sessionFile?.storageKind ? { storageKind: sessionFile.storageKind } : {}),
    ...(sessionFile?.status ? { status: sessionFile.status } : {}),
    ...(sessionFile?.missingAt !== undefined ? { missingAt: sessionFile.missingAt } : {}),
    ...(sessionFile?.resource ? { resource: sessionFile.resource } : {}),
  };
}

function toMediaItem(file) {
  if (!file?.fileId) return null;
  return {
    type: "session_file",
    fileId: file.fileId,
    sessionPath: file.sessionPath,
    filePath: file.filePath,
    filename: file.filename || (file.filePath ? path.basename(file.filePath) : file.label),
    label: file.label,
    mime: file.mime,
    size: file.size,
    kind: file.kind,
  };
}
