import fs from "fs";
import path from "path";
import {
  createSessionFileResourceEnvelope,
  fileIdFromSessionFileResourceId,
} from "../lib/resources/resource-envelope.ts";

export class ResourceError extends Error {
  status: number;
  code: string;

  constructor(message, { status = 500, code = "resource_error" } = {}) {
    super(message);
    this.name = "ResourceError";
    this.status = status;
    this.code = code;
  }
}

type SessionFileLike = {
  id?: string;
  realPath?: string | null;
  filePath?: string | null;
  status?: string | null;
  mime?: string | null;
  filename?: string | null;
  displayName?: string | null;
  label?: string | null;
  mtimeMs?: number | null;
  size?: number | null;
  isDirectory?: boolean | null;
  missingAt?: number | null;
};

type SessionFilesLike = {
  get(fileId: string, options?: { sessionPath?: string | null }): SessionFileLike | null | undefined;
};

type ResourceServiceOptions = {
  agentsDir?: string;
  sessionFiles?: SessionFilesLike;
  runtimeContext?: { studioId?: string; [key: string]: unknown };
  now?: () => number;
};

export class ResourceService {
  _agentsDir: string;
  _sessionFiles: SessionFilesLike;
  _runtimeContext: { studioId: string; [key: string]: unknown };
  _now: () => number;
  _sessionPathByFileId: Map<string, string>;

  constructor({ agentsDir, sessionFiles, runtimeContext, now = () => Date.now() }: ResourceServiceOptions = {}) {
    if (!agentsDir) throw new Error("agentsDir is required for ResourceService");
    if (!sessionFiles) throw new Error("sessionFiles is required for ResourceService");
    if (!runtimeContext?.studioId) throw new Error("runtimeContext.studioId is required for ResourceService");
    const checkedRuntimeContext = runtimeContext as { studioId: string; [key: string]: unknown };
    this._agentsDir = agentsDir;
    this._sessionFiles = sessionFiles;
    this._runtimeContext = checkedRuntimeContext;
    this._now = now;
    this._sessionPathByFileId = new Map();
  }

  getResource(resourceId) {
    const file = this._reconcileFileAvailability(this._findSessionFileByResourceId(resourceId));
    if (!file) return null;
    return createSessionFileResourceEnvelope(file, { studioId: this._runtimeContext.studioId });
  }

  resolveContent(resourceId) {
    const file = this._reconcileFileAvailability(this._findSessionFileByResourceId(resourceId));
    if (!file) {
      throw new ResourceError("resource not found", {
        status: 404,
        code: "resource_not_found",
      });
    }

    const resource = createSessionFileResourceEnvelope(file, { studioId: this._runtimeContext.studioId });
    if (!resource) {
      throw new ResourceError("invalid resource id", {
        status: 400,
        code: "invalid_resource_id",
      });
    }
    if (file.status === "expired") {
      throw new ResourceError("resource expired", {
        status: 410,
        code: "resource_expired",
      });
    }
    if (file.isDirectory) {
      throw new ResourceError("resource content is not available for directories", {
        status: 409,
        code: "resource_is_directory",
      });
    }

    const sourcePath = file.realPath || file.filePath;
    if (!sourcePath || !path.isAbsolute(sourcePath)) {
      throw new ResourceError("resource content path is invalid", {
        status: 500,
        code: "invalid_resource_content_path",
      });
    }

    let realPath;
    try {
      realPath = fs.realpathSync(sourcePath);
    } catch {
      throw new ResourceError("resource content missing", {
        status: 404,
        code: "resource_content_missing",
      });
    }

    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      throw new ResourceError("resource content is not a regular file", {
        status: 409,
        code: "resource_not_file",
      });
    }

    return {
      resourceId: resource.resourceId,
      resource,
      filePath: realPath,
      mime: file.mime || "application/octet-stream",
      size: stat.size,
      filename: file.filename || file.displayName || file.label || path.basename(realPath),
      mtimeMs: stat.mtimeMs,
      etag: `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`,
    };
  }

  _findSessionFileByResourceId(resourceId) {
    const fileId = fileIdFromSessionFileResourceId(resourceId);
    if (!fileId) {
      throw new ResourceError("invalid resource id", {
        status: 400,
        code: "invalid_resource_id",
      });
    }

    const loaded = this._sessionFiles.get(fileId);
    if (loaded) return loaded;

    const sessionPath = this._findSessionPathForFileId(fileId);
    if (!sessionPath) return null;
    return this._sessionFiles.get(fileId, { sessionPath });
  }

  _reconcileFileAvailability(file) {
    if (!file || file.status === "expired") return file;

    const sourcePath = file.realPath || file.filePath;
    if (!sourcePath || !path.isAbsolute(sourcePath)) return file;

    let realPath;
    let stat;
    try {
      realPath = fs.realpathSync(sourcePath);
      stat = fs.statSync(realPath);
    } catch {
      return {
        ...file,
        status: "missing",
        missingAt: file.missingAt ?? this._now(),
      };
    }

    const size = stat.isDirectory() ? null : stat.size;
    const isDirectory = stat.isDirectory();
    if (
      file.status === "available"
      && file.realPath === realPath
      && file.mtimeMs === stat.mtimeMs
      && file.size === size
      && file.isDirectory === isDirectory
      && file.missingAt == null
    ) {
      return file;
    }

    return {
      ...file,
      realPath,
      status: "available",
      missingAt: null,
      mtimeMs: stat.mtimeMs,
      size,
      isDirectory,
    };
  }

  _findSessionPathForFileId(fileId) {
    if (this._sessionPathByFileId.has(fileId)) {
      return this._sessionPathByFileId.get(fileId);
    }

    for (const sidecarPath of collectSessionFileSidecars(this._agentsDir)) {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
      } catch {
        continue;
      }
      if (raw?.version !== 1 || !raw.files || typeof raw.files !== "object") continue;

      const sessionPath = raw.sessionPath || sidecarPath.slice(0, -".files.json".length);
      for (const id of Object.keys(raw.files)) {
        if (!this._sessionPathByFileId.has(id)) {
          this._sessionPathByFileId.set(id, sessionPath);
        }
      }
      if (Object.prototype.hasOwnProperty.call(raw.files, fileId)) {
        return sessionPath;
      }
    }

    return null;
  }
}

function collectSessionFileSidecars(rootDir) {
  const out = [];
  collectSidecarsRecursive(rootDir, out);
  return out;
}

function collectSidecarsRecursive(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSidecarsRecursive(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl.files.json")) {
      out.push(fullPath);
    }
  }
}
