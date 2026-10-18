// @ts-nocheck
import fs from "fs";
import path from "node:path";
import { isDesktopSessionPath, isValidSessionPath } from "../../core/message-utils.ts";
import { ArtifactSnapshotStore, ArtifactSnapshotError } from "../../lib/session-files/artifact-snapshots.ts";
import { Readable } from "stream";
import { Hono } from "hono";
import { ResourceError } from "../../core/resource-service.ts";
import {
  issueResourceTicket,
  ResourceTicketError,
  verifyResourceTicket,
} from "../../core/resource-ticket-service.ts";
import { createRequestContext, jsonError } from "../http/boundary.ts";

export function createResourcesRoute(engine) {
  const route = new Hono();

  route.get("/resources/:resourceId", (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const resource = getResource(engine, c.req.param("resourceId"), requestContext);
      if (!resource) return jsonError(c, { code: "resource_not_found", status: 404 });
      if (resource.origin === "artifact_snapshot") verifiedSnapshot(engine, resource, requestContext);
      return c.json(resource);
    } catch (err) {
      return resourceRouteError(c, err);
    }
  });

  route.post("/resources/:resourceId/ticket", (c) => {
    try {
      const resourceId = c.req.param("resourceId");
      const requestContext = createRequestContext(c, engine);
      const content = materializeSnapshotContent(engine, resolveResourceContent(engine, resourceId, requestContext), requestContext);
      const studioId = content.resource?.studioId || requestContext.studioId;
      const issued = issueResourceTicket({
        codiaHome: engine?.codiaHome,
        resourceId,
        studioId,
        principalId: requestContext.principalId,
      });
      return c.json({
        ticket: issued.ticket,
        ticketId: issued.ticketId,
        resourceId,
        expiresAt: issued.expiresAt,
        contentUrl: `/api/resources/${encodeURIComponent(resourceId)}/content?ticket=${encodeURIComponent(issued.ticket)}`,
      });
    } catch (err) {
      return resourceRouteError(c, err);
    }
  });

  route.get("/resources/:resourceId/content", (c) => serveResourceContent(c, engine, false));
  route.on("HEAD", "/resources/:resourceId/content", (c) => serveResourceContent(c, engine, true));

  return route;
}

function getResource(engine, resourceId, requestContext) {
  const access = getResourceAccess(engine);
  if (access) return access.getMetadata(resourceId, requestContext);
  const options = { requestContext };
  if (typeof engine?.getResource === "function") return engine.getResource(resourceId, options);
  return engine?.resources?.getResource?.(resourceId, options) || null;
}

function resolveResourceContent(engine, resourceId, requestContext) {
  const access = getResourceAccess(engine);
  if (access) return access.resolveContent(resourceId, requestContext);
  const options = { requestContext };
  if (typeof engine?.resolveResourceContent === "function") {
    return engine.resolveResourceContent(resourceId, options);
  }
  if (typeof engine?.resources?.resolveContent === "function") {
    return engine.resources.resolveContent(resourceId, options);
  }
  throw new ResourceError("resource service unavailable", {
    status: 500,
    code: "resource_service_unavailable",
  });
}

function resolveTrustedResourceContent(engine, resourceId) {
  const options = { requestContext: { authPrincipal: { kind: "resource_ticket" } } };
  const access = getResourceAccess(engine);
  if (typeof access?.resolveTrustedContent === "function") {
    return access.resolveTrustedContent(resourceId, options.requestContext);
  }
  if (typeof engine?.resolveResourceContent === "function") {
    return engine.resolveResourceContent(resourceId, options);
  }
  if (typeof engine?.resources?.resolveContent === "function") {
    return engine.resources.resolveContent(resourceId, options);
  }
  throw new ResourceError("resource service unavailable", {
    status: 500,
    code: "resource_service_unavailable",
  });
}

function getResourceAccess(engine) {
  if (typeof engine?.getResourceAccessService === "function") return engine.getResourceAccessService();
  return engine?.resourceAccess || null;
}

function serveResourceContent(c, engine, headOnly) {
  try {
    const resourceId = c.req.param("resourceId");
    const ticket = c.req.query("ticket");
    const requestContext = ticket ? null : createRequestContext(c, engine);
    const content = materializeSnapshotContent(engine, ticket
      ? resolveTicketContent(c, engine, resourceId, ticket)
      : resolveResourceContent(engine, resourceId, requestContext), requestContext, !!ticket);
    if (c.req.header("if-none-match") && c.req.header("if-none-match") === content.etag) {
      c.header("ETag", content.etag);
      return c.body(null, 304);
    }

    const range = parseRangeHeader(c.req.header("range"), content.size);
    if (range?.unsatisfiable) {
      c.header("Content-Range", `bytes */${content.size}`);
      c.header("Accept-Ranges", "bytes");
      return c.body(null, 416);
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : content.size - 1;
    const length = content.size === 0 ? 0 : end - start + 1;
    const status = range ? 206 : 200;

    c.header("Content-Type", content.mime || "application/octet-stream");
    c.header("Accept-Ranges", "bytes");
    c.header("Content-Length", String(length));
    c.header("Cache-Control", "private, max-age=0, must-revalidate");
    if (content.etag) c.header("ETag", content.etag);
    if (range) c.header("Content-Range", `bytes ${start}-${end}/${content.size}`);
    if (content.filename) c.header("Content-Disposition", contentDisposition(content.filename));
    if (headOnly || content.size === 0) return c.body(null, status);

    // The exact verified snapshot bytes are served, never a second path-based read.
    if (content.snapshotBytes) return c.body(new Uint8Array(content.snapshotBytes.subarray(start, end + 1)), status);
    const stream = fs.createReadStream(content.filePath, { start, end });
    return c.body(Readable.toWeb(stream), status);
  } catch (err) {
    return resourceRouteError(c, err);
  }
}

function verifiedSnapshot(engine, resource, requestContext, ticketVerified = false) {
  const file = engine.getSessionFile?.(resource.fileId);
  const sessionPath = file?.sessionPath;
  if (!file || file.origin !== "artifact_snapshot" || !sessionPath
    || !isValidSessionPath(sessionPath, engine.agentsDir) || !isDesktopSessionPath(sessionPath, engine.agentsDir)) {
    throw new ResourceError("snapshot ownership missing", { status: 404, code: "snapshot_not_found" });
  }
  try {
    const root = fs.realpathSync(engine.agentsDir);
    const actual = fs.realpathSync(sessionPath);
    const relative = path.relative(root, actual);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)
      || actual !== path.resolve(sessionPath) || !fs.lstatSync(actual).isFile()) throw new Error();
  } catch { throw new ResourceError("invalid snapshot session", { status: 403, code: "snapshot_session_forbidden" }); }
  if (!ticketVerified && !requestContext?.authorize?.("sessions.read", {
    kind: "session", sessionPath, sessionId: engine.getSessionIdForPath?.(sessionPath) || undefined,
  })?.allowed) throw new ResourceError("snapshot session access denied", { status: 403, code: "snapshot_session_forbidden" });
  const store = new ArtifactSnapshotStore(engine.codiaHome);
  const snapshot = store.list(sessionPath).find(item => item.snapshotFileId === file.id);
  const source = snapshot && engine.getSessionFile?.(snapshot.sourceFileId, { sessionPath });
  const ownedCopy = engine.getSessionFile?.(file.id, { sessionPath });
  if (!snapshot || !source || source.sessionPath !== sessionPath || source.listed === false
    || !ownedCopy || ownedCopy.sessionPath !== sessionPath) {
    throw new ResourceError("snapshot ownership mismatch", { status: 404, code: "snapshot_not_found" });
  }
  return { store, snapshot, sessionPath };
}

function materializeSnapshotContent(engine, content, requestContext, ticketVerified = false) {
  if (content.resource?.origin !== "artifact_snapshot") return content;
  const { store, snapshot, sessionPath } = verifiedSnapshot(engine, content.resource, requestContext, ticketVerified);
  const bytes = store.read(sessionPath, snapshot);
  return { ...content, snapshotBytes: bytes, size: bytes.length, etag: `"sha256-${snapshot.sha256}"` };
}

function resolveTicketContent(c, engine, resourceId, ticket) {
  verifyResourceTicket({
    codiaHome: engine?.codiaHome,
    ticket,
    resourceId,
  });
  return resolveTrustedResourceContent(engine, resourceId);
}

function parseRangeHeader(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return { unsatisfiable: true };

  let start;
  let end;
  if (match[1] === "" && match[2] === "") return { unsatisfiable: true };
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { unsatisfiable: true };
    start = Math.max(size - suffixLength, 0);
    end = Math.max(size - 1, 0);
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { unsatisfiable: true };
  if (size <= 0 || start >= size || start > end) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

function contentDisposition(filename) {
  const fallback = asciiFilenameFallback(filename);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function asciiFilenameFallback(filename) {
  const source = typeof filename === "string" ? filename : "";
  const dot = source.lastIndexOf(".");
  const ext = dot >= 0 ? source.slice(dot + 1) : "";
  const safeExt = /^[A-Za-z0-9]{1,12}$/.test(ext) ? `.${ext}` : "";
  const stem = source
    .slice(0, dot >= 0 ? dot : source.length)
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\\r\n;/]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return /^[A-Za-z0-9._-]+$/.test(stem)
    ? `${stem}${safeExt}`
    : `download${safeExt}`;
}

function resourceRouteError(c, err) {
  if (err instanceof ResourceTicketError) {
    return jsonError(c, { code: err.code, detail: err.message, status: err.status });
  }
  if (err instanceof ResourceError || err instanceof ArtifactSnapshotError) {
    return jsonError(c, { code: err.code, detail: err.message, status: err.status });
  }
  return jsonError(c, {
    code: "resource_error",
    detail: err?.message || String(err),
    status: 500,
  });
}
