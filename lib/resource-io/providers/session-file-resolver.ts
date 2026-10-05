import fs from "fs";
import path from "path";
import { capabilityDenied, ResourceIOError } from "../errors.ts";
import { resourceKeyForRef } from "../resource-refs.ts";
import type {
  MaterializeResult,
  ResourceDescriptor,
  ResourceMutationResult,
  ResourceReadResult,
  ResourceRef,
  ResourceStat,
  ResourceTrashResult,
  ResourceVersion,
} from "../types.ts";

type Options = {
  sessionFiles: {
    get: (fileId: string, options?: { sessionId?: string | null; sessionPath?: string | null }) => any;
  };
};

export class SessionFileResolverProvider {
  readonly id = "session_file" as const;

  declare sessionFiles: Options["sessionFiles"];

  constructor({ sessionFiles }: Options) {
    if (!sessionFiles) throw new Error("sessionFiles is required");
    this.sessionFiles = sessionFiles;
  }

  capabilities() {
    return {
      stat: true,
      read: true,
      materialize: true,
      writeExpectedVersion: false,
      write: false,
      edit: false,
      list: false,
      search: false,
      watch: false,
      copy: false,
      rename: false,
      move: false,
      trash: false,
      delete: false,
      mkdir: false,
    };
  }

  async stat(ref: ResourceRef): Promise<ResourceStat> {
    const { normalized, entry, filePath } = this.resolveEntry(ref);
    const stat = statIfPresent(filePath);
    return {
      resourceKey: resourceKeyForRef(normalized),
      resource: descriptorForEntry(normalized, entry, filePath),
      exists: Boolean(stat),
      isDirectory: Boolean(stat?.isDirectory()),
      ...(stat ? { version: versionFromStat(stat) } : {}),
      filePath,
    };
  }

  async read(ref: ResourceRef): Promise<ResourceReadResult> {
    const { normalized, entry, filePath } = this.resolveEntry(ref);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new ResourceIOError(`session file is not a regular file: ${normalized.fileId}`, {
        code: "resource_not_file",
        status: 409,
      });
    }
    return {
      resourceKey: resourceKeyForRef(normalized),
      resource: descriptorForEntry(normalized, entry, filePath),
      content: fs.readFileSync(filePath),
      version: versionFromStat(stat),
      filePath,
    };
  }

  async materialize(ref: ResourceRef): Promise<MaterializeResult> {
    const { normalized, entry, filePath } = this.resolveEntry(ref);
    const stat = fs.statSync(filePath);
    return {
      resourceKey: resourceKeyForRef(normalized),
      resource: descriptorForEntry(normalized, entry, filePath),
      filePath,
      version: versionFromStat(stat),
    };
  }

  async write(_ref?: ResourceRef, _content?: string | Buffer): Promise<ResourceMutationResult> { throw capabilityDenied("write", this.id); }
  async writeExpectedVersion(_ref?: ResourceRef, _content?: string | Buffer, _expectedVersion?: ResourceVersion): Promise<never> { throw capabilityDenied("writeExpectedVersion", this.id); }
  async edit(_ref?: ResourceRef, _edits?: unknown[]): Promise<ResourceMutationResult> { throw capabilityDenied("edit", this.id); }
  async list(_ref?: ResourceRef): Promise<never> { throw capabilityDenied("list", this.id); }
  async search(_ref?: ResourceRef): Promise<never> { throw capabilityDenied("search", this.id); }
  async copy(_from?: ResourceRef, _to?: ResourceRef): Promise<never> { throw capabilityDenied("copy", this.id); }
  async rename(_from?: ResourceRef, _to?: ResourceRef): Promise<never> { throw capabilityDenied("rename", this.id); }
  async move(_from?: ResourceRef, _to?: ResourceRef): Promise<never> { throw capabilityDenied("move", this.id); }
  async trash(_ref?: ResourceRef): Promise<ResourceTrashResult> { throw capabilityDenied("trash", this.id); }
  async delete(_ref?: ResourceRef): Promise<ResourceMutationResult> { throw capabilityDenied("delete", this.id); }
  async mkdir(_ref?: ResourceRef): Promise<ResourceMutationResult> { throw capabilityDenied("mkdir", this.id); }

  resolveEntry(ref: ResourceRef) {
    if (ref.kind !== "session-file") {
      throw new ResourceIOError(`session_file provider cannot resolve ${ref.kind}`, {
        code: "invalid_resource_ref",
        status: 400,
      });
    }
    const options = {
      ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
      ...(ref.sessionPath ? { sessionPath: ref.sessionPath } : {}),
    };
    const entry = this.sessionFiles.get(ref.fileId, options);
    if (!entry) {
      throw new ResourceIOError(`session file not found: ${ref.fileId}`, {
        code: "resource_not_found",
        status: 404,
      });
    }
    if (entry.status === "expired") {
      throw new ResourceIOError(`session file expired: ${ref.fileId}`, {
        code: "resource_expired",
        status: 410,
      });
    }
    const filePath = entry.realPath || entry.filePath;
    if (!filePath || !path.isAbsolute(filePath)) {
      throw new ResourceIOError(`session file path is invalid: ${ref.fileId}`, {
        code: "invalid_resource_path",
        status: 500,
      });
    }
    return { normalized: ref, entry, filePath };
  }
}

function descriptorForEntry(ref: Extract<ResourceRef, { kind: "session-file" }>, entry: any, filePath: string): ResourceDescriptor {
  return {
    kind: "session-file",
    fileId: ref.fileId,
    ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
    ...(ref.sessionPath ? { sessionPath: ref.sessionPath } : {}),
    provider: "session_file",
    filePath,
    displayName: entry.displayName || entry.filename || path.basename(filePath),
  };
}

function statIfPresent(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return null;
    throw err;
  }
}

function versionFromStat(stat: fs.Stats): ResourceVersion {
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.isDirectory() ? null : stat.size,
  };
}
