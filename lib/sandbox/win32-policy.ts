import fs from "fs";
import path from "path";

const EXTERNAL_READ_STORAGE_KINDS = new Set(["external", "install_source"]);

type SessionFileForSandbox = {
  status?: string | null;
  storageKind?: string | null;
  realPath?: string | null;
  filePath?: string | null;
};

type ExternalReadOptions = {
  workspaceRoots?: Array<string | null | undefined>;
  gsapHome?: string | null;
};

type SandboxPolicyLike = {
  mode?: string;
  workspace?: string | null;
  workspaceRoots?: Array<string | null | undefined>;
  writablePaths?: Array<string | null | undefined>;
  protectedPaths?: Array<string | null | undefined>;
};

type Win32SandboxGrantOptions = {
  policy?: SandboxPolicyLike | null;
  cwd?: string | null;
};

function normalizeExistingOrResolved(p?: string | null) {
  if (!p) return null;
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function normalizeExisting(p?: string | null) {
  if (!p) return null;
  try {
    return fs.realpathSync(p);
  } catch (err) {
    return err?.code === "ENOENT" ? null : path.resolve(p);
  }
}

function uniqueNormalized(paths?: Array<string | null | undefined>) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths || []) {
    const normalized = normalizeExistingOrResolved(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function uniqueExistingNormalized(paths?: Array<string | null | undefined>) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths || []) {
    const normalized = normalizeExisting(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function isInside(target?: string | null, root?: string | null) {
  if (!target || !root) return false;
  const rel = path.relative(root, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function isInsideAny(target: string | null, roots: string[]) {
  return roots.some((root) => isInside(target, root));
}

function basenameForPlatformPath(target?: string | null) {
  const raw = String(target || "");
  return /^[a-z]:[\\/]|^\\\\/i.test(raw) ? path.win32.basename(raw) : path.basename(raw);
}

export function externalReadPathsFromSessionFiles(
  files: SessionFileForSandbox[] = [],
  { workspaceRoots = [], gsapHome }: ExternalReadOptions = {},
) {
  const normalizedWorkspaceRoots = uniqueNormalized(workspaceRoots);
  const normalizedHome = gsapHome ? normalizeExistingOrResolved(gsapHome) : null;
  const out: string[] = [];

  for (const file of files || []) {
    if (!file || file.status === "missing" || file.status === "expired") continue;
    if (!EXTERNAL_READ_STORAGE_KINDS.has(file.storageKind || "external")) continue;
    const target = normalizeExistingOrResolved(file.realPath || file.filePath);
    if (!target) continue;
    if (normalizedHome && isInside(target, normalizedHome)) continue;
    if (isInsideAny(target, normalizedWorkspaceRoots)) continue;
    out.push(target);
  }

  return uniqueNormalized(out);
}

export function buildWin32SandboxGrants({
  policy,
  cwd,
}: Win32SandboxGrantOptions = {}) {
  if (!policy || policy.mode === "full-access") {
    return {
      readPaths: [],
      optionalReadPaths: [],
      writePaths: [],
      optionalWritePaths: [],
      denyReadPaths: [],
      denyWritePaths: [],
    };
  }

  const workspaceRoots = uniqueNormalized(policy.workspaceRoots || [policy.workspace].filter(Boolean));
  const isWorkspaceGitDir = (target) =>
    basenameForPlatformPath(target) === ".git" && isInsideAny(target, workspaceRoots);

  const writePaths = uniqueNormalized([cwd]);
  const optionalWritePaths = uniqueExistingNormalized(policy.writablePaths || [])
    .filter((p) => !isInsideAny(p, writePaths));
  const writeGrantRoots = [...writePaths, ...optionalWritePaths];
  const denyWritePaths = uniqueExistingNormalized(policy.protectedPaths || [])
    .filter((p) => isInsideAny(p, writeGrantRoots));
  const functionalityFirstDenyWritePaths = denyWritePaths
    .filter((p) => !isWorkspaceGitDir(p));

  return {
    readPaths: [],
    optionalReadPaths: [],
    writePaths,
    optionalWritePaths,
    denyReadPaths: [],
    denyWritePaths: functionalityFirstDenyWritePaths,
  };
}
