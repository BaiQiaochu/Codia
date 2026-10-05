import fs from "fs/promises";
import { summarizeSessionForRc } from "./rc-summary.ts";

const STREAM_WAIT_TIMEOUT_MS = 30_000;
const STREAM_POLL_INTERVAL_MS = 200;

export async function handleRcPendingInput(ctx) {
  const { engine, agentId, sessionKey, text, reply, isGroup = false, chatId = null, messageThreadId = null } = ctx;
  const rcState = engine.rcState;
  if (!rcState) return { handled: false };

  const pending = rcState.getPending(sessionKey);
  if (!pending) return { handled: false };
  if (pending.type !== "rc-select") return { handled: false };

  if (isGroup) {
    rcState.clearPending(sessionKey);
    await _safeReply(reply, "群聊里不能使用 /rc 接管，请到私聊里重新执行 /rc。");
    return { handled: true };
  }

  const num = _parseSelectionNumber(text);
  if (num === null) {
    await _safeReply(reply, `请输入数字编号（1-${pending.options.length}）。`);
    return { handled: true };
  }
  if (num < 1 || num > pending.options.length) {
    await _safeReply(reply, `编号超出范围（有效范围 1-${pending.options.length}）。`);
    return { handled: true };
  }

  rcState.clearPending(sessionKey);

  const selected = pending.options[num - 1];
  const sessionPath = selected.path;
  const title = selected.title || "未命名会话";

  const initialCheck = await _validateAttachTarget(engine, rcState, sessionKey, sessionPath, agentId);
  if (initialCheck) {
    await _safeReply(reply, initialCheck);
    return { handled: true };
  }

  await _safeReply(reply, "正在接管桌面 session...");

  const idle = await _waitForSessionIdle(engine, sessionPath);
  if (!idle) {
    await _safeReply(reply, "目标会话持续回复中（超过 30s），接管取消。稍后重试 /rc。");
    return { handled: true };
  }

  const preSummaryCheck = await _validateAttachTarget(engine, rcState, sessionKey, sessionPath, agentId);
  if (preSummaryCheck) {
    await _safeReply(reply, preSummaryCheck);
    return { handled: true };
  }

  const agent = engine.getAgent?.(agentId);
  let summary = null;
  try {
    summary = await summarizeSessionForRc(engine, agent, sessionPath);
  } catch (err) {
    console.warn(`[rc] summarize threw: ${err.message}`);
  }

  const preAttachCheck = await _validateAttachTarget(engine, rcState, sessionKey, sessionPath, agentId);
  if (preAttachCheck) {
    await _safeReply(reply, preAttachCheck);
    return { handled: true };
  }

  try {
    rcState.attach(sessionKey, sessionPath, {
      platform: _platformFromSessionKey(sessionKey),
      chatId,
      agentId,
      messageThreadId,
    });
  } catch (err) {
    await _safeReply(reply, _normalizeAttachFailure(err));
    return { handled: true };
  }

  try {
    engine.emitEvent?.({
      type: "bridge_rc_attached",
      sessionKey,
      sessionPath,
      title,
      platform: _platformFromSessionKey(sessionKey),
    }, sessionPath);
  } catch (err) {
    console.warn(`[rc] emit attached event failed: ${err.message}`);
  }

  const body = summary
    ? `已接管桌面会话「${title}」\n${summary}`
    : `已接管对话：${title}`;
  await _safeReply(reply, body);

  return { handled: true };
}

function _platformFromSessionKey(sessionKey) {
  const match = /^([a-z]+)_/i.exec(sessionKey || "");
  return match ? match[1] : "bridge";
}

function _parseSelectionNumber(text) {
  const trimmed = (text || "").trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

async function _validateAttachTarget(engine, rcState, sessionKey, sessionPath, agentId) {
  const exists = await _desktopSessionExists(engine, sessionPath, agentId);
  if (!exists) return "目标会话已不存在，接管取消。请重新 /rc。";

  const holderSessionKey = rcState.getAttachedBridgeSessionKey?.(sessionPath);
  if (holderSessionKey && holderSessionKey !== sessionKey) {
    return "目标会话已被另一个 bridge 会话接管，接管取消。请重新 /rc。";
  }
  return null;
}

async function _desktopSessionExists(engine, sessionPath, agentId) {
  let hadAuthoritativeCheck = false;
  if (typeof engine?.listSessions === "function") {
    hadAuthoritativeCheck = true;
    const sessions = await engine.listSessions();
    return sessions.some((session) => session?.path === sessionPath && (!agentId || session?.agentId === agentId));
  }
  if (typeof engine?.getSessionByPath === "function") {
    hadAuthoritativeCheck = true;
    if (engine.getSessionByPath(sessionPath)) return true;
  }
  if (typeof engine?.ensureSessionLoaded === "function") {
    hadAuthoritativeCheck = true;
    try {
      if (await engine.ensureSessionLoaded(sessionPath)) return true;
    } catch {
      return false;
    }
  }
  try {
    await fs.access(sessionPath);
    return true;
  } catch {
    return !hadAuthoritativeCheck;
  }
}

function _normalizeAttachFailure(err) {
  const msg = err?.message || "";
  if (msg.includes("bridge 会话接管")) return msg;
  return "目标会话已被另一个 bridge 会话接管，接管取消。请重新 /rc。";
}

async function _waitForSessionIdle(engine, sessionPath) {
  const deadline = Date.now() + STREAM_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const streaming = engine.isSessionStreaming?.(sessionPath) ?? false;
    if (!streaming) return true;
    await new Promise((resolve) => setTimeout(resolve, STREAM_POLL_INTERVAL_MS));
  }
  return !(engine.isSessionStreaming?.(sessionPath) ?? false);
}

async function _safeReply(reply, text) {
  try { await reply(text); } catch (err) {
    console.warn(`[rc] reply failed: ${err.message}`);
  }
}
