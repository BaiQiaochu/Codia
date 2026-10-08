// @ts-nocheck
import fs from "fs";
import path from "path";
import { SessionManager } from "../../lib/pi-sdk/index.ts";
import { isActiveSessionPath } from "../message-utils.ts";

/**
  *
 * @typedef {{status:'not-found'|'no-history'|'rotated'|'deleted'}} SessionOpResult
 */

export function createSessionOps({ engine }) {
  return {
    isStreaming(ref) {
      if (ref.kind === "bridge") return engine.isBridgeSessionStreaming(ref.sessionKey);
      return engine.isSessionStreaming?.(ref.sessionPath) ?? false;
    },

    async abort(ref) {
      if (ref.kind === "bridge") return engine.abortBridgeSession(ref.sessionKey);
      return engine.abortSession?.(ref.sessionPath) ?? false;
    },

    injectAssistantMessage(ref, text) {
      if (ref.kind === "bridge") {
        const ok = engine.bridgeSessionManager?.injectMessage(ref.sessionKey, text, { agentId: ref.agentId });
        return ok ?? false;
      }
      return _injectDesktopAssistantMessage(engine, ref, text);
    },

    async rotate(ref) {
      if (ref.kind === "desktop") return _rotateDesktop(engine, ref);
      return _rotateBridge(engine, ref);
    },

    async delete(ref) {
      if (ref.kind === "desktop") return _deleteDesktop(engine, ref);
      return _deleteBridge(engine, ref);
    },

    async compact(ref) {
      if (ref.kind === "bridge") {
        if (typeof engine.compactBridgeSession !== "function") {
          throw new Error("compact: engine.compactBridgeSession not available");
        }
        return await engine.compactBridgeSession(ref.sessionKey, { agentId: ref.agentId });
      }
      if (typeof engine.compactDesktopSession === "function") {
        return await engine.compactDesktopSession(ref.sessionPath);
      }
      const session = engine.getSessionByPath?.(ref.sessionPath);
      if (!session) throw new Error("session not found");
      if (session.isCompacting) throw new Error("Already compacting");
      await session.compact();
      return null;
    },

    async freshCompact(ref) {
      if (ref.kind !== "bridge") {
        throw new Error("freshCompact for desktop kind not supported");
      }
      if (typeof engine.freshCompactBridgeSession !== "function") {
        throw new Error("freshCompact: engine.freshCompactBridgeSession not available");
      }
      return await engine.freshCompactBridgeSession(ref.sessionKey, {
        agentId: ref.agentId,
        reason: "manual",
      });
    },
  };
}

function _archivedFilename(file, ts) {
  if (!file.endsWith(".jsonl")) {
    throw new Error(`_archivedFilename: entry.file must end with .jsonl, got "${file}"`);
  }
  const rand = Math.random().toString(36).slice(2, 8);
  return file.replace(/\.jsonl$/, `.archived-${ts}-${rand}.jsonl`);
}

function _assertDesktopSessionPath(engine, ref) {
  const sessionPath = ref.sessionPath ? path.resolve(ref.sessionPath) : "";
  if (!sessionPath) throw new Error("desktop sessionPath is required");
  if (!sessionPath.endsWith(".jsonl")) {
    throw new Error(`desktop sessionPath must end with .jsonl, got "${sessionPath}"`);
  }
  if (engine.agentsDir) {
    const rel = path.relative(path.resolve(engine.agentsDir), sessionPath);
    const parts = rel.split(path.sep);
    if (parts[2] === "archived") {
      throw new Error(`desktop sessionPath must not be archived: ${sessionPath}`);
    }
  }
  if (engine.agentsDir && !isActiveSessionPath(sessionPath, engine.agentsDir)) {
    throw new Error(`desktop sessionPath must be an active agent session: ${sessionPath}`);
  }
  return sessionPath;
}

function _notifyDesktopSessionReleased(engine, sessionPath) {
  const result = engine.rcState?.invalidateDesktopSession?.(sessionPath);
  for (const attachment of result?.detachedAttachments || []) {
    try {
      engine.emitEvent?.({
        type: "bridge_rc_detached",
        sessionKey: attachment.sessionKey,
        sessionPath: attachment.desktopSessionPath,
      }, attachment.desktopSessionPath);
    } catch {}
  }
  try {
    engine.emitEvent?.({ type: "sessions_changed", sessionPath }, sessionPath);
  } catch {}
}

function _injectDesktopAssistantMessage(engine, ref, text) {
  try {
    const sessionPath = _assertDesktopSessionPath(engine, ref);
    if (!fs.existsSync(sessionPath)) return false;
    const agent = engine.getAgent?.(ref.agentId);
    const sessionDir = agent?.sessionDir || path.dirname(sessionPath);
    const mgr = SessionManager.open(sessionPath, sessionDir);
    mgr.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: String(text ?? "") }],
    });
    return true;
  } catch (err) {
    console.error(`[session-ops] inject desktop assistant message failed: ${err.message}`);
    return false;
  }
}

async function _rotateDesktop(engine, ref) {
  const sessionPath = _assertDesktopSessionPath(engine, ref);
  if (!fs.existsSync(sessionPath)) return { status: "not-found" };

  await engine.closeSession?.(sessionPath);
  try { await engine.setSessionPinned?.(sessionPath, false); } catch {}

  const archiveDir = path.join(path.dirname(sessionPath), "archived");
  fs.mkdirSync(archiveDir, { recursive: true });
  const base = path.basename(sessionPath);
  let dest = path.join(archiveDir, base);
  if (fs.existsSync(dest)) {
    dest = path.join(archiveDir, _archivedFilename(base, Date.now()));
  }
  fs.renameSync(sessionPath, dest);
  const nowSec = Date.now() / 1000;
  fs.utimesSync(dest, nowSec, nowSec);
  _notifyDesktopSessionReleased(engine, sessionPath);
  return { status: "rotated" };
}

async function _deleteDesktop(engine, ref) {
  const sessionPath = _assertDesktopSessionPath(engine, ref);
  if (!fs.existsSync(sessionPath)) return { status: "not-found" };

  await engine.closeSession?.(sessionPath);
  try { await engine.setSessionPinned?.(sessionPath, false); } catch {}
  try { await engine.clearSessionTitle?.(sessionPath); } catch {}
  fs.unlinkSync(sessionPath);
  _notifyDesktopSessionReleased(engine, sessionPath);
  return { status: "deleted" };
}

function _rotateBridge(engine, ref) {
  const agent = engine.getAgent(ref.agentId);
  if (!agent) throw new Error("agent not found");
  const bridgeDir = path.join(agent.sessionDir, "bridge");
  const index = engine.bridgeSessionManager.readIndex(agent);
  const raw = index[ref.sessionKey];
  if (!raw) return { status: "not-found" };
  const entry = typeof raw === "string" ? { file: raw } : { ...raw };
  if (!entry.file) {
    index[ref.sessionKey] = entry;
    engine.bridgeSessionManager.writeIndex(index, agent);
    return { status: "no-history" };
  }
  const src = path.join(bridgeDir, entry.file);
  if (fs.existsSync(src)) {
    const archived = _archivedFilename(entry.file, Date.now());
    fs.renameSync(src, path.join(bridgeDir, archived));
  }
  delete entry.file;
  index[ref.sessionKey] = entry;
  engine.bridgeSessionManager.writeIndex(index, agent);
  return { status: "rotated" };
}

function _deleteBridge(engine, ref) {
  const agent = engine.getAgent(ref.agentId);
  if (!agent) throw new Error("agent not found");
  const bridgeDir = path.join(agent.sessionDir, "bridge");
  const index = engine.bridgeSessionManager.readIndex(agent);
  const raw = index[ref.sessionKey];
  if (!raw) return { status: "not-found" };
  const entry = typeof raw === "string" ? { file: raw } : raw;
  if (entry.file) {
    const p = path.join(bridgeDir, entry.file);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  delete index[ref.sessionKey];
  engine.bridgeSessionManager.writeIndex(index, agent);
  return { status: "deleted" };
}
