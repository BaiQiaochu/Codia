import fs from "fs";
import path from "path";
import { detectMime, extOfName, inferFileKind } from "../file-metadata.ts";

const DEFAULT_CONFLICT_POLICY = "fail";

type PathFileRef = { type: "path"; path: string };
type SessionFileRef = { type: "session_file"; fileId: string; sessionPath?: string };
type FileRef = PathFileRef | SessionFileRef;

function normalizeExistingOrResolvedPath(filePath) {
  const resolved = path.resolve(filePath);
  try { return fs.realpathSync(resolved); }
  catch { return resolved; }
}

function normalizePossiblyMissingPath(filePath) {
  const resolved = path.resolve(filePath);
  if (fs.existsSync(resolved)) return normalizeExistingOrResolvedPath(resolved);
  const parts = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    parts.unshift(path.basename(cursor));
    cursor = parent;
  }
  const base = normalizeExistingOrResolvedPath(cursor);
  return parts.length ? path.join(base, ...parts) : base;
}

function isInsideRoot(filePath, root) {
  const rel = path.relative(root, filePath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function normalizeRoot(root, cwd) {
  if (!root || typeof root !== "string") return null;
  const absolute = path.isAbsolute(root) ? root : path.resolve(cwd || process.cwd(), root);
  return normalizeExistingOrResolvedPath(absolute);
}

function allowedRootsFor(allowedRoots, cwd) {
  const roots = (Array.isArray(allowedRoots) ? allowedRoots : [])
    .map((root) => normalizeRoot(root, cwd))
    .filter(Boolean);
  if (!roots.length) return [];
  return roots;
}

function assertParentInsideAllowedRoots(targetPath, allowedRoots, cwd) {
  const roots = allowedRootsFor(allowedRoots, cwd);
  if (!roots.length) throw new Error("copy target has no allowed roots");
  const normalizedTarget = normalizePossiblyMissingPath(path.dirname(targetPath));
  if (roots.some((root) => isInsideRoot(normalizedTarget, root))) return;
  throw new Error(`copy target is outside allowed roots: ${targetPath}`);
}

function assertExistingPathInsideAllowedRoots(filePath, allowedRoots, cwd, label) {
  const roots = allowedRootsFor(allowedRoots, cwd);
  if (!roots.length) throw new Error(`${label} has no allowed roots`);
  const normalizedPath = normalizeExistingOrResolvedPath(filePath);
  if (roots.some((root) => isInsideRoot(normalizedPath, root))) return;
  throw new Error(`${label} is outside allowed roots: ${filePath}`);
}

function readSample(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeFileRef(ref): FileRef {
  if (!ref || typeof ref !== "object") throw new Error("FileRef is required");
  if (ref.type === "path") {
    if (!ref.path || typeof ref.path !== "string") throw new Error("path FileRef requires path");
    return { type: "path", path: ref.path };
  }
  if (ref.type === "session_file") {
    const fileId = ref.fileId || ref.id;
    if (!fileId || typeof fileId !== "string") throw new Error("session_file FileRef requires fileId");
    return {
      type: "session_file",
      fileId,
      ...(ref.sessionPath ? { sessionPath: ref.sessionPath } : {}),
    };
  }
  throw new Error(`unsupported FileRef type: ${ref.type || "unknown"}`);
}

function sessionFilePath(file, fileId) {
  if (!file || typeof file !== "object") throw new Error(`SessionFile not found: ${fileId}`);
  if (file.status === "expired") throw new Error(`SessionFile expired: ${fileId}`);
  const filePath = file.realPath || file.filePath || file.path || null;
  if (!filePath || !path.isAbsolute(filePath)) {
    throw new Error(`SessionFile has no readable absolute path: ${fileId}`);
  }
  return filePath;
}

function sourceFilename(source) {
  return source.filename || source.label || path.basename(source.filePath);
}

async function resolveFileRef(ref, {
  cwd = process.cwd(),
  resolveSessionFile,
  sessionPath = null,
}: any = {}) {
  const normalized = normalizeFileRef(ref);
  if (normalized.type === "path") {
    const filePath = path.isAbsolute(normalized.path) ? normalized.path : path.resolve(cwd, normalized.path);
    return {
      ref: normalized,
      filePath,
      filename: path.basename(filePath),
      sourceFile: null,
    };
  }

  if (typeof resolveSessionFile !== "function") {
    throw new Error("SessionFile resolver unavailable");
  }
  const lookupSessionPath = normalized.sessionPath || sessionPath || null;
  const file = resolveSessionFile(normalized.fileId, { sessionPath: lookupSessionPath });
  const filePath = sessionFilePath(file, normalized.fileId);
  return {
    ref: normalized,
    filePath,
    filename: sourceFilename({ ...file, filePath }),
    sourceFile: file,
  };
}

function metadataForFile(filePath, overrides: any = {}) {
  const stat = fs.statSync(filePath);
  const filename = path.basename(filePath);
  const ext = extOfName(filename);
  const isDirectory = stat.isDirectory();
  const sample = isDirectory ? Buffer.alloc(0) : readSample(filePath);
  const mime = isDirectory
    ? "inode/directory"
    : detectMime(sample, "application/octet-stream", filename);
  return {
    filename,
    ext,
    mime,
    size: isDirectory ? null : stat.size,
    kind: inferFileKind({ mime, ext, isDirectory }),
    isDirectory,
    mtimeMs: stat.mtimeMs,
    ...overrides,
  };
}

export async function statFileRef(ref, deps: any = {}) {
  const resolved = await resolveFileRef(ref, deps);
  if (!fs.existsSync(resolved.filePath)) throw new Error(`file not found: ${resolved.filePath}`);
  const sourceFile = resolved.sourceFile || {};
  const meta = metadataForFile(resolved.filePath, {
    ...(sourceFile.mime ? { mime: sourceFile.mime } : {}),
    ...(sourceFile.kind ? { kind: sourceFile.kind } : {}),
    ...(sourceFile.size !== undefined ? { size: sourceFile.size } : {}),
  });
  return {
    type: resolved.ref.type,
    ...(resolved.ref.type === "session_file" ? { fileId: resolved.ref.fileId } : {}),
    ...(resolved.ref.type === "path" ? { path: resolved.filePath } : {}),
    filePath: resolved.filePath,
    filename: sourceFile.filename || resolved.filename || meta.filename,
    label: sourceFile.label || sourceFile.displayName || sourceFile.filename || resolved.filename || meta.filename,
    mime: meta.mime,
    kind: meta.kind,
    size: meta.size,
    isDirectory: meta.isDirectory,
    status: sourceFile.status || "available",
  };
}

function resolveTargetPath({ targetPath, targetDir, filename, cwd, sourceFilename: fallbackFilename }) {
  if (targetPath && targetDir) throw new Error("Pass either targetPath or targetDir, not both");
  if (targetPath) {
    const raw = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
    return raw;
  }
  if (!targetDir) throw new Error("copy requires targetPath or targetDir");
  const dir = path.isAbsolute(targetDir) ? targetDir : path.resolve(cwd, targetDir);
  return path.join(dir, filename || fallbackFilename);
}

function resolveConflictPath(targetPath, conflictPolicy) {
  const policy = conflictPolicy || DEFAULT_CONFLICT_POLICY;
  if (!fs.existsSync(targetPath)) return targetPath;
  if (policy === "overwrite") return targetPath;
  if (policy !== "rename") throw new Error(`copy target already exists: ${targetPath}`);

  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let i = 2; i < 10_000; i++) {
    const candidate = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`could not find available filename for: ${targetPath}`);
}

export async function copyFileRefToPath({
  from,
  targetPath = null,
  targetDir = null,
  filename = null,
  conflictPolicy = DEFAULT_CONFLICT_POLICY,
  cwd = process.cwd(),
  allowedRoots = [],
  sourceAllowedRoots = null,
  sessionPath = null,
  resolveSessionFile,
  registerSessionFile,
}: any = {}) {
  const resolved = await resolveFileRef(from, { cwd, resolveSessionFile, sessionPath });
  if (!fs.existsSync(resolved.filePath)) throw new Error(`file not found: ${resolved.filePath}`);
  if (resolved.ref.type === "path" && Array.isArray(sourceAllowedRoots)) {
    assertExistingPathInsideAllowedRoots(resolved.filePath, sourceAllowedRoots, cwd, "copy source");
  }
  const sourceStat = fs.statSync(resolved.filePath);
  if (sourceStat.isDirectory()) {
    throw new Error("copying directory FileRefs is not supported in v0");
  }

  const rawTargetPath = resolveTargetPath({
    targetPath,
    targetDir,
    filename,
    cwd,
    sourceFilename: resolved.filename,
  });
  assertParentInsideAllowedRoots(rawTargetPath, allowedRoots, cwd);
  const finalTargetPath = resolveConflictPath(rawTargetPath, conflictPolicy);
  if (fs.existsSync(finalTargetPath)) {
    assertExistingPathInsideAllowedRoots(finalTargetPath, allowedRoots, cwd, "copy target");
  }
  fs.mkdirSync(path.dirname(finalTargetPath), { recursive: true });
  fs.copyFileSync(resolved.filePath, finalTargetPath);

  const label = path.basename(finalTargetPath);
  const registered = typeof registerSessionFile === "function" && sessionPath
    ? registerSessionFile({
      sessionPath,
      filePath: finalTargetPath,
      label,
      origin: "session_file_copy",
      operation: "copied",
      storageKind: "external",
    })
    : null;

  return {
    filePath: finalTargetPath,
    filename: label,
    source: {
      type: resolved.ref.type,
      ...(resolved.ref.type === "session_file" ? { fileId: resolved.ref.fileId } : {}),
      filePath: resolved.filePath,
    },
    ...(registered ? { sessionFile: registered } : {}),
  };
}
