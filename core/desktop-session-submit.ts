// @ts-nocheck
/**
  * */

/**
 * @param {object} engine
 * @param {object} opts
 * @param {string} opts.sessionPath
 * @param {string} opts.text
 * @param {Array<{type:'image', data:string, mimeType:string}>} [opts.images]
 * @param {string[]} [opts.imageAttachmentPaths]
 * @param {Array<{type:'video', data:string, mimeType:string}>} [opts.videos]
 * @param {string[]} [opts.videoAttachmentPaths]
 * @param {Array<{type:'audio', data:string, mimeType:string}>} [opts.audios]
 * @param {string[]} [opts.audioAttachmentPaths]
  *
 * @param {(delta: string, accumulated: string) => void} [opts.onDelta]
 * @param {object} [opts.displayMessage]
  *
 * @param {object|null|undefined} [opts.uiContext]
 * @returns {Promise<{ text: string | null, toolMedia: string[] }>}
 */
import path from "path";
import crypto from "crypto";
import fs from "fs/promises";
import { extOfName, inferFileKind } from "../lib/file-metadata.ts";
import { collectMediaItems } from "../lib/tools/media-details.ts";
import { formatSettingsUpdateText } from "../lib/tools/settings-update-result.ts";
import { materializeBridgeInboundFiles } from "../lib/session-files/bridge-inbound-files.ts";
import { serializeSessionFile } from "../lib/session-files/session-file-response.ts";
import { sessionFilesCacheDir } from "../lib/session-files/session-file-registry.ts";
import { buildUiContextTurnContext } from "./ui-context-reminder.ts";
import { runAgentReview, buildReferencedSessionContext, assertAgentReviewActive, isAgentReviewPending } from './agent-review-turns.ts';
import { COMPOSER_PRESENTATION } from './composer-presentation.ts';
import { isQuickActionId, QUICK_ACTIONS } from '../shared/quick-actions.ts';

const LONG_CONTEXT_CHAR_THRESHOLD = 80_000;
const LONG_CONTEXT_EXCERPT_CHARS = 4_000;
const LONG_CONTEXT_LABEL = "long-user-message.md";
const SESSION_QUEUE_IDLE_POLL_MS = 120;
const SESSION_QUEUE_MAX_WAIT_MS = 15 * 60 * 1000;
const desktopSessionSubmissionQueues = new Map();

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isSessionBusyError(err) {
  return (err?.message || String(err || "")) === "session_busy";
}

async function waitForSessionIdle(engine, sessionPath, reviewRequestId) {
  if (typeof engine.isSessionStreaming !== "function") return;
  const startedAt = Date.now();
  while (engine.isSessionStreaming(sessionPath, reviewRequestId)) {
    if (Date.now() - startedAt > SESSION_QUEUE_MAX_WAIT_MS) {
      throw new Error("session_busy");
    }
    await sleep(SESSION_QUEUE_IDLE_POLL_MS);
  }
}

function enqueueDesktopSessionSubmission(sessionPath, job) {
  const previous = desktopSessionSubmissionQueues.get(sessionPath);
  let run;
  if (previous) {
    run = previous.catch(() => {}).then(job);
  } else {
    try {
      run = Promise.resolve(job());
    } catch (err) {
      run = Promise.reject(err);
    }
  }
  const tail = run.catch(() => {}).finally(() => {
    if (desktopSessionSubmissionQueues.get(sessionPath) === tail) {
      desktopSessionSubmissionQueues.delete(sessionPath);
    }
  });
  desktopSessionSubmissionQueues.set(sessionPath, tail);
  return run;
}

async function promptSessionQueued(engine, sessionPath, promptText, promptOpts) {
  while (true) {
    assertAgentReviewActive(engine, sessionPath, promptOpts?.reviewRequestId);
    await waitForSessionIdle(engine, sessionPath, promptOpts?.reviewRequestId);
    try {
      await engine.promptSession(sessionPath, promptText, promptOpts);
      return;
    } catch (err) {
      if (!isSessionBusyError(err)) throw err;
      await sleep(SESSION_QUEUE_IDLE_POLL_MS);
    }
  }
}

export async function submitDesktopSessionMessage(engine, opts = {}) {
  const queueKey = engine?.getSessionIdForPath?.(opts.sessionPath) || opts.sessionPath;
  if (!opts.reviewInternal && opts.displayMessage?.agentMentions?.length) {
    if (desktopSessionSubmissionQueues.has(queueKey) && !isAgentReviewPending(engine, opts.sessionPath)) throw new Error('session_busy');
    return runAgentReview(engine, opts, submitDesktopSessionMessage);
  }
  if (engine && isAgentReviewPending(engine, opts.sessionPath, opts.reviewRequestId)) throw new Error('session_busy');
  const {
    sessionPath,
    text,
    images,
    imageAttachmentPaths,
    videos,
    videoAttachmentPaths,
    audios,
    audioAttachmentPaths,
    inboundFiles,
    onDelta,
    displayMessage,
    sessionFileRefs,
    uiContext,
  } = opts;

  if (!engine || typeof engine.ensureSessionLoaded !== "function" || typeof engine.promptSession !== "function") {
    throw new Error("desktop-session-submit: engine session API unavailable");
  }
  if (!sessionPath) throw new Error("desktop-session-submit: sessionPath is required");
  if (!text && !images?.length && !videos?.length && !audios?.length) {
    throw new Error("desktop-session-submit: text, images, videos, or audios required");
  }

  return enqueueDesktopSessionSubmission(queueKey, async () => {
  await waitForSessionIdle(engine, sessionPath, opts.reviewRequestId);
  const session = await engine.ensureSessionLoaded(sessionPath);
  if (!session) throw new Error(`desktop-session-submit: failed to load session ${sessionPath}`);

  if (uiContext !== undefined) {
    engine.setUiContext?.(sessionPath, uiContext ?? null);
  }

  let promptImageAttachmentPaths = imageAttachmentPaths || [];
  let promptVideoAttachmentPaths = videoAttachmentPaths || [];
  let promptAudioAttachmentPaths = audioAttachmentPaths || [];
  let displayAttachments = displayMessage?.attachments;
  let promptText = text || "";
  if (!opts.reviewInternal && displayMessage?.sessionRefs?.length) {
    promptText += await buildReferencedSessionContext(engine, displayMessage.sessionRefs);
  }
  if (isQuickActionId(displayMessage?.quickAction)) {
    promptText = `${QUICK_ACTIONS[displayMessage.quickAction].prompt}\n\n${promptText}`;
  }
  let promptSessionFileRefs = normalizeSessionFileRefs(sessionFileRefs, sessionPath);

  if (displayAttachments?.length) {
    const registeredDisplay = registerDisplayAttachments({
      codiaHome: engine.codiaHome,
      sessionPath,
      attachments: displayAttachments,
      registerSessionFile: engine.registerSessionFile?.bind(engine),
    });
    displayAttachments = registeredDisplay.attachments;
    promptImageAttachmentPaths = uniquePaths([
      ...promptImageAttachmentPaths,
      ...registeredDisplay.imageAttachmentPaths,
    ]);
    promptVideoAttachmentPaths = uniquePaths([
      ...promptVideoAttachmentPaths,
      ...registeredDisplay.videoAttachmentPaths,
    ]);
    if (audios?.length || promptAudioAttachmentPaths.length) {
      promptAudioAttachmentPaths = uniquePaths([
        ...promptAudioAttachmentPaths,
        ...registeredDisplay.audioAttachmentPaths,
      ]);
    }
    promptSessionFileRefs = mergeSessionFileRefs(
      promptSessionFileRefs,
      sessionFileRefsFromAttachments(displayAttachments, sessionPath),
    );
  }

  if (inboundFiles?.length) {
    const materialized = await materializeBridgeInboundFiles({
      codiaHome: engine.codiaHome,
      sessionPath,
      files: inboundFiles,
      registerSessionFile: engine.registerSessionFile?.bind(engine),
    });
    promptImageAttachmentPaths = uniquePaths([
      ...promptImageAttachmentPaths,
      ...materialized.imageAttachmentPaths,
    ]);
    displayAttachments = [
      ...(displayAttachments || []),
      ...materialized.displayAttachments,
    ];
    promptSessionFileRefs = mergeSessionFileRefs(
      promptSessionFileRefs,
      sessionFileRefsFromAttachments(materialized.displayAttachments, sessionPath),
    );
  }

  const previousDisplayAttachmentCount = displayAttachments?.length || 0;
  const longContext = await materializeLongContextIfNeeded({
    codiaHome: engine.codiaHome || engine.codiaHome,
    sessionPath,
    promptText,
    displayAttachments,
    registerSessionFile: engine.registerSessionFile?.bind(engine),
  });
  promptText = longContext.promptText;
  displayAttachments = longContext.displayAttachments;
  if ((displayAttachments?.length || 0) > previousDisplayAttachmentCount) {
    promptSessionFileRefs = mergeSessionFileRefs(
      promptSessionFileRefs,
      sessionFileRefsFromAttachments(displayAttachments, sessionPath),
    );
  }

  assertAgentReviewActive(engine, sessionPath, opts.reviewRequestId);
  if (displayMessage && engine.recordCustomEntry) {
    await engine.recordCustomEntry(sessionPath, COMPOSER_PRESENTATION, {
      ...displayMessage, attachments: displayAttachments, reviewRequestId: opts.reviewRequestId,
    });
  }
  if (!opts.skipUserEvent) engine.emitEvent?.({
    type: "session_user_message",
    message: {
      id: displayMessage?.clientMessageId,
      quickAction: displayMessage?.quickAction,
      sessionRefs: displayMessage?.sessionRefs,
      agentMentions: displayMessage?.agentMentions,
      reviewSourceSessionId: displayMessage?.reviewSourceSessionId,
      text: displayMessage?.text ?? text ?? "",
      timestamp: Date.now(),
      attachments: displayAttachments,
      quotedText: displayMessage?.quotedText,
      skills: displayMessage?.skills,
      workspaceTool: displayMessage?.workspaceTool,
      deskContext: displayMessage?.deskContext ?? null,
      source: displayMessage?.source || "desktop",
      bridgeSessionKey: displayMessage?.bridgeSessionKey || null,
      fromReplay: displayMessage?.fromReplay === true,
    },
  }, sessionPath);
  queueVoiceInputTranscriptions({
    speechRecognition: engine.speechRecognition,
    sessionPath,
    attachments: displayAttachments,
  });
  engine.emitEvent?.({ type: "session_status", isStreaming: true }, sessionPath);

  promptText = addAttachedImageMarkers(promptText, promptImageAttachmentPaths);
  promptText = addAttachedVideoMarkers(promptText, promptVideoAttachmentPaths);
  promptText = addAttachedAudioMarkers(promptText, promptAudioAttachmentPaths);
  promptText = addSessionFileRefMarkers(promptText, promptSessionFileRefs);

  let captured = "";
  const toolMedia = [];
  const unsub = session.subscribe?.((event) => {
    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "text_delta") {
        const delta = sub.delta || "";
        captured += delta;
        try { onDelta?.(delta, captured); } catch {}
      }
    } else if (event.type === "tool_execution_end" && !event.isError) {
      toolMedia.push(...collectMediaItems(event.result?.details?.media));
      const card = event.result?.details?.card;
      if (card?.description) {
        captured += (captured ? "\n\n" : "") + card.description;
      }
      const settingsUpdateText = formatSettingsUpdateText(event.result?.details?.settingsUpdate);
      if (settingsUpdateText) {
        captured += (captured ? "\n\n" : "") + settingsUpdateText;
      }
    }
  });

  try {
    const turnContext = buildUiContextTurnContext(uiContext, session.sessionManager?.getCwd?.() || null);
    const promptOpts = {
      ...(opts.reviewRequestId ? { reviewRequestId: opts.reviewRequestId } : {}),
      ...(images?.length ? { images } : {}),
      ...(videos?.length ? { videos } : {}),
      ...(audios?.length ? { audios } : {}),
      ...(promptImageAttachmentPaths.length ? { imageAttachmentPaths: promptImageAttachmentPaths } : {}),
      ...(promptVideoAttachmentPaths.length ? { videoAttachmentPaths: promptVideoAttachmentPaths } : {}),
      ...(promptAudioAttachmentPaths.length ? { audioAttachmentPaths: promptAudioAttachmentPaths } : {}),
      ...(turnContext ? { context: turnContext } : {}),
    };
    await promptSessionQueued(engine, sessionPath, promptText, Object.keys(promptOpts).length ? promptOpts : undefined);
    if (opts.reviewInternal) {
      const last = session.messages?.at(-1);
      if (last?.role === 'assistant' && last.stopReason === 'error') throw new Error(last.errorMessage || '模型请求失败。');
    }
  } finally {
    try { unsub?.(); } catch {}
    if (!opts.reviewRequestId) engine.emitEvent?.({ type: "session_status", isStreaming: false }, sessionPath);
  }

  return {
    text: captured.trim() || null,
    toolMedia,
  };
  });
}

async function materializeLongContextIfNeeded({
  codiaHome,
  sessionPath,
  promptText,
  displayAttachments,
  registerSessionFile,
}) {
  const text = String(promptText || "");
  if (text.length <= LONG_CONTEXT_CHAR_THRESHOLD) {
    return { promptText, displayAttachments };
  }
  if (!codiaHome || typeof registerSessionFile !== "function") {
    return { promptText, displayAttachments };
  }

  const dir = sessionFilesCacheDir(codiaHome, sessionPath);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, uniqueLongContextFilename());
  await fs.writeFile(filePath, text, "utf-8");

  const sessionFile = serializeSessionFile(registerSessionFile({
    sessionPath,
    filePath,
    label: LONG_CONTEXT_LABEL,
    origin: "user_long_context",
    storageKind: "managed_cache",
  }));
  if (!sessionFile) {
    return { promptText, displayAttachments };
  }

  const attachment = {
    fileId: sessionFile.fileId || sessionFile.id,
    path: filePath,
    name: LONG_CONTEXT_LABEL,
    isDir: false,
    mimeType: sessionFile.mime || "text/markdown",
    status: sessionFile.status,
    missingAt: sessionFile.missingAt,
  };

  return {
    promptText: buildLongContextPrompt({
      text,
      filePath,
      sessionFile,
    }),
    displayAttachments: [
      ...(displayAttachments || []),
      attachment,
    ],
  };
}

function buildLongContextPrompt({ text, filePath, sessionFile }) {
  const start = text.slice(0, LONG_CONTEXT_EXCERPT_CHARS);
  const end = text.slice(-LONG_CONTEXT_EXCERPT_CHARS);
  const id = sessionFile.fileId || sessionFile.id || "unknown";
  const bytes = Buffer.byteLength(text, "utf-8");

  return [
    `[long_context_file: ${filePath}]`,
    "The user's full message was too long to inline safely, so it was saved as a managed file for this current session.",
    `Session file id: ${id}`,
    `File path: ${filePath}`,
    `Characters: ${text.length}`,
    `Bytes: ${bytes}`,
    "Use this file if the task requires the complete context. Do not read other sessions unless the user explicitly asks.",
    "",
    "Start excerpt:",
    "```text",
    start,
    "```",
    "",
    "End excerpt:",
    "```text",
    end,
    "```",
  ].join("\n");
}

function uniqueLongContextFilename() {
  const suffix = `${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  return `long-user-message_${suffix}.md`;
}

function queueVoiceInputTranscriptions({ speechRecognition, sessionPath, attachments }) {
  if (!speechRecognition || typeof speechRecognition.queueVoiceTranscription !== "function") return;
  for (const attachment of attachments || []) {
    if (attachment?.presentation !== "voice-input" || !attachment.fileId) continue;
    speechRecognition.queueVoiceTranscription({
      sessionPath,
      fileId: attachment.fileId,
    });
  }
}

function registerDisplayAttachments({ codiaHome, sessionPath, attachments, registerSessionFile }) {
  const nextAttachments = [];
  const imageAttachmentPaths = [];
  const videoAttachmentPaths = [];
  const audioAttachmentPaths = [];

  for (const attachment of attachments || []) {
    let next = { ...attachment };
    let sessionFile = null;
    const hasInlineBytes = typeof next.base64Data === "string" && next.base64Data.length > 0;
    let inlineOnlyAttachment = false;

    if (!next.fileId && next.path && path.isAbsolute(next.path) && typeof registerSessionFile === "function") {
      try {
        sessionFile = serializeSessionFile(registerSessionFile({
          sessionPath,
          filePath: next.path,
          label: next.name || path.basename(next.path),
          origin: originForDisplayAttachment(next),
          storageKind: displayAttachmentStorageKind(codiaHome, next.path),
          presentation: displayAttachmentPresentation(next),
          listed: listedForDisplayAttachment(next),
          waveform: next.waveform,
        }));
      } catch (err) {
        if (!hasInlineBytes || !isMissingDisplayAttachmentFile(err)) throw err;
        inlineOnlyAttachment = true;
      }
      if (sessionFile) {
        next = {
          ...next,
          fileId: sessionFile.fileId || sessionFile.id,
          name: next.name || sessionFile.displayName || sessionFile.filename || path.basename(next.path),
          mimeType: next.mimeType || sessionFile.mime,
          isDir: next.isDir || !!sessionFile.isDirectory,
          presentation: sessionFile.presentation || displayAttachmentPresentation(next),
          listed: sessionFile.listed !== undefined ? sessionFile.listed !== false : listedForDisplayAttachment(next),
          status: sessionFile.status,
          missingAt: sessionFile.missingAt,
          waveform: sessionFile.waveform || next.waveform,
        };
      }
    }

    if (!sessionFile && hasInlineBytes && !next.fileId) {
      inlineOnlyAttachment = true;
    }

    if (!inlineOnlyAttachment && next.path && path.isAbsolute(next.path) && next.base64Data) {
      const { base64Data: _base64Data, ...withoutInlineBytes } = next;
      next = withoutInlineBytes;
    }

    const kind = sessionFile?.kind || inferFileKind({
      mime: next.mimeType,
      ext: extOfName(next.name || next.path),
      isDirectory: !!next.isDir,
    });
    if (!inlineOnlyAttachment && !next.isDir && next.path && kind === "image") {
      imageAttachmentPaths.push(next.path);
    } else if (!inlineOnlyAttachment && !next.isDir && next.path && kind === "video") {
      videoAttachmentPaths.push(next.path);
    } else if (!inlineOnlyAttachment && !next.isDir && next.path && kind === "audio") {
      audioAttachmentPaths.push(next.path);
    }
    nextAttachments.push(next);
  }

  return {
    attachments: nextAttachments,
    imageAttachmentPaths: uniquePaths(imageAttachmentPaths),
    videoAttachmentPaths: uniquePaths(videoAttachmentPaths),
    audioAttachmentPaths: uniquePaths(audioAttachmentPaths),
  };
}

function isMissingDisplayAttachmentFile(err) {
  const message = String(err?.message || err || "");
  return err?.code === "ENOENT" || /file not found|no such file|ENOENT/i.test(message);
}

function displayAttachmentPresentation(attachment) {
  return attachment?.presentation === "voice-input" ? "voice-input" : "attachment";
}

function listedForDisplayAttachment(attachment) {
  return displayAttachmentPresentation(attachment) !== "voice-input";
}

function originForDisplayAttachment(attachment) {
  return displayAttachmentPresentation(attachment) === "voice-input" ? "voice_input" : "user_attachment";
}

function displayAttachmentStorageKind(codiaHome, filePath) {
  if (!codiaHome) return "external";
  const root = path.resolve(codiaHome, "session-files");
  const target = path.resolve(filePath);
  const rel = path.relative(root, target);
  if (rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel))) {
    return "managed_cache";
  }
  return "external";
}

function addAttachedImageMarkers(text, imageAttachmentPaths) {
  const promptText = text || "";
  const missing = uniquePaths(imageAttachmentPaths)
    .filter((filePath) => filePath && !promptText.includes(`[attached_image: ${filePath}]`));
  if (!missing.length) return promptText;
  const markerText = missing.map((filePath) => `[attached_image: ${filePath}]`).join("\n");
  return promptText ? `${markerText}\n${promptText}` : markerText;
}

function addAttachedVideoMarkers(text, videoAttachmentPaths) {
  const promptText = text || "";
  const missing = uniquePaths(videoAttachmentPaths)
    .filter((filePath) => filePath && !promptText.includes(`[attached_video: ${filePath}]`));
  if (!missing.length) return promptText;
  const markerText = missing.map((filePath) => `[attached_video: ${filePath}]`).join("\n");
  return promptText ? `${markerText}\n${promptText}` : markerText;
}

function addAttachedAudioMarkers(text, audioAttachmentPaths) {
  const promptText = text || "";
  const missing = uniquePaths(audioAttachmentPaths)
    .filter((filePath) => filePath && !promptText.includes(`[attached_audio: ${filePath}]`));
  if (!missing.length) return promptText;
  const markerText = missing.map((filePath) => `[attached_audio: ${filePath}]`).join("\n");
  return promptText ? `${markerText}\n${promptText}` : markerText;
}

function normalizeSessionFileRefs(refs, fallbackSessionPath) {
  if (!Array.isArray(refs)) return [];
  const normalized = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") continue;
    const fileId = typeof ref.fileId === "string" && ref.fileId.trim() ? ref.fileId.trim() : null;
    if (!fileId) continue;
    normalized.push({
      fileId,
      sessionPath: typeof ref.sessionPath === "string" && ref.sessionPath ? ref.sessionPath : fallbackSessionPath,
      label: typeof ref.label === "string" && ref.label ? ref.label : fileId,
      kind: typeof ref.kind === "string" && ref.kind ? ref.kind : "attachment",
    });
  }
  return normalized;
}

function sessionFileRefsFromAttachments(attachments, sessionPath) {
  return normalizeSessionFileRefs((attachments || []).map((attachment) => ({
    fileId: attachment?.fileId,
    sessionPath,
    label: attachment?.name || attachment?.label || attachment?.path,
    kind: attachment?.isDir ? "directory" : "attachment",
  })), sessionPath);
}

function mergeSessionFileRefs(primary, secondary) {
  const out = [];
  const seen = new Set();
  for (const ref of [...(primary || []), ...(secondary || [])]) {
    if (!ref?.fileId) continue;
    const key = `${ref.sessionPath || ""}:${ref.fileId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function addSessionFileRefMarkers(text, refs) {
  const items = normalizeSessionFileRefs(refs, null);
  if (!items.length) return text || "";
  const markerText = items
    .map((ref) => `[SessionFile] ${JSON.stringify({
      fileId: ref.fileId,
      sessionPath: ref.sessionPath || null,
      label: ref.label,
      kind: ref.kind,
    })}`)
    .join("\n");
  const promptText = text || "";
  return promptText ? `${markerText}\n${promptText}` : markerText;
}

function uniquePaths(paths) {
  return Array.from(new Set((paths || []).filter(Boolean)));
}
