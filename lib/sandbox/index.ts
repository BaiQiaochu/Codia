// @ts-nocheck
import fs from "fs";
import path, { extname } from "path";
import { deriveSandboxPolicy } from "./policy.ts";
import { PathGuard } from "./path-guard.ts";
import { detectPlatform, checkAvailability } from "./platform.ts";
import { createSeatbeltExec } from "./seatbelt.ts";
import { createBwrapExec } from "./bwrap.ts";
import { createWin32Exec } from "./win32-exec.ts";
import { wrapPathTool, wrapBashTool } from "./tool-wrapper.ts";
import { createEnhancedReadFile } from "./read-enhanced.ts";
import { wrapReadImageWithVisionBridge } from "./read-image-vision.ts";
import { wrapReadOfficeMedia } from "./read-office-media.ts";
import { createManagedConfigWriteGuard } from "./managed-config-guard.ts";
import { t } from "../i18n.ts";
import { normalizeWin32ShellPath } from "./win32-path.ts";
import { serializeSessionFile } from "../session-files/session-file-response.ts";
import { wrapResourceIoFileTools } from "../resource-io/agent-tools.ts";
import { createResourceIoToolOperations } from "../resource-io/pi-tool-operations.ts";
import { createSandboxResourceIO } from "../resource-io/sandbox-resource-io.ts";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "../pi-sdk/index.ts";

const IMAGE_MIMES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function createSandboxedTools(
  cwd,
  customTools,
  {
    agentDir,
    workspace,
    workspaceFolders = [],
    authorizedFolders = [],
    getAuthorizedFolders,
    gsapHome,
    hanakoHome,
    executionBoundary,
    getSandboxEnabled,
    getSandboxNetworkEnabled,
    getExternalReadPaths,
    getTraceContext,
    recordToolCall,
    getSessionPath,
    resolveSessionFile,
    recordFileOperation,
    getVisionBridge,
    isVisionAuxiliaryEnabled,
    resourceIO: providedResourceIO,
    emitEvent,
  },
) {
  const effectiveGsapHome = gsapHome || hanakoHome;
  const resolveAuthorizedFolders = () => {
    if (typeof getAuthorizedFolders === "function") {
      const folders = getAuthorizedFolders();
      return Array.isArray(folders) ? folders : [];
    }
    return Array.isArray(authorizedFolders) ? authorizedFolders : [];
  };
  const makePolicy = () => deriveSandboxPolicy({
    agentDir,
    cwd,
    workspace,
    workspaceFolders,
    authorizedFolders: resolveAuthorizedFolders(),
    gsapHome: effectiveGsapHome,
    mode: "standard",
  });
  const guard = {
    check: (absolutePath, operation) => new PathGuard(makePolicy()).check(absolutePath, operation),
  };
  const platform = detectPlatform();
  const isWin32RestrictedToken = platform === "win32-restricted-token";
  const traceWrapOpts = {
    executionBoundary,
    getTraceContext,
    recordToolCall,
    getSandboxNetworkEnabled,
    platform,
  };
  const checkManagedConfigWrite = createManagedConfigWriteGuard({ gsapHome: effectiveGsapHome });
  const wrapOpts = { getSandboxEnabled, getExternalReadPaths, checkManagedConfigWrite, ...traceWrapOpts };
  const normalBashTool = isWin32RestrictedToken
    ? createBashTool(cwd, { operations: { exec: createWin32Exec() } })
    : createBashTool(cwd);
  const resourceIO = providedResourceIO || createSandboxResourceIO({
    cwd,
    agentDir,
    workspace,
    workspaceFolders,
    authorizedFolders,
    getAuthorizedFolders,
    gsapHome: effectiveGsapHome,
    getSandboxEnabled,
    getExternalReadPaths,
    getSessionPath,
    emitEvent,
    resolveSessionFile,
  });
  const resourceOps = createResourceIoToolOperations({
    cwd,
    resourceIO,
    getSessionPath: () => getSessionPath?.() || null,
    detectImageMimeType: async (p) => IMAGE_MIMES[extname(p).toLowerCase()] || undefined,
  });
  const enhancedReadFile = createEnhancedReadFile();
  const readOps = {
    ...resourceOps.read,
    readFile: async (p) => {
      if (resourceOps.hasBoundTarget?.(p)) {
        return resourceOps.read.readFile(p);
      }
      await resourceOps.read.access(p);
      return enhancedReadFile(p);
    },
  };
  const bashWrapOpts = {
    getSandboxEnabled,
    getExternalReadPaths,
    fallbackTool: normalBashTool,
    checkManagedConfigWrite,
    ...traceWrapOpts,
  };
  const writeTool = wrapFileTouchTool(createWriteTool(cwd, { operations: resourceOps.write }), cwd, {
    origin: "agent_write",
    operationForPath: (filePath) => fs.existsSync(filePath) ? "modified" : "created",
    getSessionPath,
    recordFileOperation,
  });
  const editTool = wrapFileTouchTool(createEditTool(cwd, { operations: resourceOps.edit }), cwd, {
    origin: "agent_edit",
    operationForPath: () => "modified",
    getSessionPath,
    recordFileOperation,
  });
  const readTool = wrapSessionFilePathTool(wrapReadImageWithVisionBridge(wrapReadOfficeMedia(createReadTool(cwd, { operations: readOps }), cwd, {
    gsapHome,
    getSessionPath,
    recordFileOperation,
    getVisionBridge,
    isVisionAuxiliaryEnabled,
  }), cwd, {
    getSessionPath,
    recordFileOperation,
    getVisionBridge,
    isVisionAuxiliaryEnabled,
  }), { getSessionPath, resolveSessionFile });

  if (isWin32RestrictedToken) {
    const sandboxedBashTool = createBashTool(cwd, {
      operations: {
        exec: (command, execCwd, execOpts) => createWin32Exec({
          sandbox: {
            policy: makePolicy(),
            getExternalReadPaths,
            getSandboxNetworkEnabled,
            gsapHome: effectiveGsapHome,
          },
        })(command, execCwd, execOpts),
      },
    });
    return buildToolSet({
      cwd,
      customTools,
      guard,
      readTool,
      writeTool,
      editTool,
      bashTool: sandboxedBashTool,
      wrapOpts,
      bashWrapOpts,
      resourceIO,
      resourceOps,
      getSessionPath,
      resolveSessionFile,
      emitEvent,
    });
  }

  let bashTool = normalBashTool;
  if (checkAvailability(platform)) {
    const sandboxExec = platform === "seatbelt"
      ? (command, execCwd, execOpts) => createSeatbeltExec(
          makePolicy(),
          { getSandboxNetworkEnabled },
        )(command, execCwd, execOpts)
      : (command, execCwd, execOpts) => createBwrapExec(
          makePolicy(),
          { getExternalReadPaths, getSandboxNetworkEnabled },
        )(command, execCwd, execOpts);
    bashTool = createBashTool(cwd, { operations: { exec: sandboxExec } });
  } else if (platform === "bwrap") {
    bashTool = {
      ...normalBashTool,
      execute: async () => ({
        content: [{ type: "text", text: t("sandbox.osRequired", { platform }) }],
      }),
    };
  }

  return buildToolSet({
    cwd,
    customTools,
    guard,
    readTool,
    writeTool,
    editTool,
    bashTool,
    wrapOpts,
    bashWrapOpts,
    resourceIO,
    resourceOps,
    getSessionPath,
    resolveSessionFile,
    emitEvent,
  });
}

function buildToolSet({
  cwd,
  customTools,
  guard,
  readTool,
  writeTool,
  editTool,
  bashTool,
  wrapOpts,
  bashWrapOpts,
  resourceIO,
  resourceOps,
  getSessionPath,
  resolveSessionFile,
  emitEvent,
}) {
  const tools = [
    wrapPathTool(readTool, guard, "read", cwd, wrapOpts),
    wrapPathTool(writeTool, guard, "write", cwd, wrapOpts),
    wrapPathTool(editTool, guard, "write", cwd, wrapOpts),
    wrapBashTool(bashTool, guard, cwd, bashWrapOpts),
    wrapPathTool(createGrepTool(cwd, { operations: resourceOps.grep }), guard, "read", cwd, wrapOpts),
    wrapPathTool(createFindTool(cwd, { operations: resourceOps.find }), guard, "read", cwd, wrapOpts),
    wrapPathTool(createLsTool(cwd, { operations: resourceOps.ls }), guard, "read", cwd, wrapOpts),
  ];
  return {
    tools: wrapResourceIoFileTools(tools, {
      cwd,
      resourceIO,
      getSessionPath,
      resolveSessionFile,
      emitEvent,
      withResourceTarget: resourceOps.withResourceTarget,
    }),
    customTools,
  };
}

function resolveToolPath(rawPath, cwd) {
  if (!rawPath) return null;
  if (process.platform === "win32") {
    return normalizeWin32ShellPath(rawPath, cwd, { allowRelative: true });
  }
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function fileTouchToolPathParam(params) {
  if (!params || typeof params !== "object") return null;
  if (typeof params.path === "string" && params.path) return params.path;
  if (typeof params.file_path === "string" && params.file_path) return params.file_path;
  if (typeof params.filePath === "string" && params.filePath) return params.filePath;
  return null;
}

function normalizeFileTouchToolParams(params) {
  const rawPath = fileTouchToolPathParam(params);
  if (!rawPath || params?.path === rawPath) return params;
  return { ...params, path: rawPath };
}

function wrapFileTouchTool(tool, cwd, {
  origin,
  operationForPath,
  getSessionPath,
  recordFileOperation,
} = {}) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const normalizedParams = normalizeFileTouchToolParams(params);
      const absolutePath = resolveToolPath(fileTouchToolPathParam(normalizedParams), cwd);
      const operation = absolutePath ? operationForPath?.(absolutePath) : null;
      const result = await tool.execute(toolCallId, normalizedParams, ...rest);
      const sessionPath = getSessionPath?.() || null;
      if (!absolutePath || !sessionPath || typeof recordFileOperation !== "function") {
        return result;
      }
      if (!fs.existsSync(absolutePath)) return result;
      try {
        const sessionFile = serializeSessionFile(recordFileOperation({
          sessionPath,
          filePath: absolutePath,
          label: path.basename(absolutePath),
          origin,
          operation,
        }));
        return appendSessionFileDetails(result, sessionFile, absolutePath);
      } catch (err) {
        return appendRegistrationWarning(result, err);
      }
    },
  };
}

function addSessionFileParameters(parameters) {
  if (!parameters || typeof parameters !== "object" || !parameters.properties) return parameters;
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((name) => name !== "path")
    : parameters.required;
  return {
    ...parameters,
    ...(required ? { required } : {}),
    properties: {
      ...parameters.properties,
      fileId: {
        type: "string",
        description: "SessionFile id from current_status/session_files or attached [SessionFile] context. Use this for read/stat/copy access. Do not use fileId for write/edit; use writableLocalRef.path or an ordinary local path for modifications.",
      },
      sessionPath: {
        type: "string",
        description: "Optional session JSONL path that owns fileId. Usually omit to use the current session.",
      },
    },
  };
}

function sessionFilePath(file) {
  if (!file || typeof file !== "object") return null;
  if (file.status === "expired") {
    throw new Error(`SessionFile expired: ${file.fileId || file.id || "unknown"}`);
  }
  const filePath = file.realPath || file.filePath || file.path || null;
  if (!filePath || !path.isAbsolute(filePath)) {
    throw new Error(`SessionFile has no readable absolute path: ${file.fileId || file.id || "unknown"}`);
  }
  return filePath;
}

function wrapSessionFilePathTool(tool, { getSessionPath, resolveSessionFile } = {}) {
  return {
    ...tool,
    parameters: addSessionFileParameters(tool.parameters),
    execute: async (toolCallId, params = {}, ...rest) => {
      const fileId = typeof params.fileId === "string" && params.fileId.trim() ? params.fileId.trim() : null;
      if (!fileId) return tool.execute(toolCallId, params, ...rest);
      if (typeof resolveSessionFile !== "function") {
        return {
          content: [{ type: "text", text: `SessionFile resolver unavailable for fileId: ${fileId}` }],
        };
      }
      const lookupSessionPath = typeof params.sessionPath === "string" && params.sessionPath
        ? params.sessionPath
        : getSessionPath?.() || null;
      try {
        const file = resolveSessionFile(fileId, { sessionPath: lookupSessionPath });
        if (!file) {
          return { content: [{ type: "text", text: `SessionFile not found: ${fileId}` }] };
        }
        const resolvedPath = sessionFilePath(file);
        return tool.execute(toolCallId, { ...params, path: resolvedPath }, ...rest);
      } catch (err) {
        return {
          content: [{ type: "text", text: err?.message || String(err) }],
        };
      }
    },
  };
}

function sessionFileRef(sessionFile) {
  const fileId = sessionFile?.fileId || sessionFile?.id || null;
  return fileId ? { kind: "session-file", fileId } : null;
}

function writableLocalRef(filePath) {
  return typeof filePath === "string" && path.isAbsolute(filePath)
    ? { kind: "local-file", path: filePath }
    : null;
}

function appendSessionFileDetails(result, sessionFile, filePath = null) {
  if (!sessionFile) return result;
  const sessionRef = sessionFileRef(sessionFile);
  const writableRef = writableLocalRef(filePath);
  return {
    ...(result || {}),
    details: {
      ...(result?.details || {}),
      sessionFile,
      ...(sessionRef ? { sessionFileRef: sessionRef } : {}),
      ...(writableRef ? { writableLocalRef: writableRef } : {}),
    },
  };
}

function appendRegistrationWarning(result, err) {
  const message = `Session file registration failed: ${err?.message || String(err)}`;
  const content = Array.isArray(result?.content) ? [...result.content] : [];
  return {
    ...(result || {}),
    content: [...content, { type: "text", text: message }],
  };
}
