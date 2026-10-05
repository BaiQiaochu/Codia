// @ts-nocheck
import { submitDesktopSessionMessage } from "./desktop-session-submit.ts";

const ATTACHMENT_MARKER_RE = /^\[(attached_(?:image|video):[^\]]+)\]\s*$/;

export async function replayLatestUserTurn(engine, opts = {}, deps = {}) {
  const submit = deps.submit || submitDesktopSessionMessage;
  const {
    sessionPath,
    sourceEntryId,
    clientMessageId,
    replacementText,
    displayMessage,
    uiContext,
  } = opts;

  if (!engine || typeof engine.ensureSessionLoaded !== "function") {
    throw new Error("latest user replay requires engine.ensureSessionLoaded");
  }
  if (!sessionPath) throw new Error("sessionPath is required");
  if (typeof engine.isSessionStreaming === "function" && engine.isSessionStreaming(sessionPath)) {
    throw new Error("session_busy");
  }
  if (replacementText != null && !String(replacementText).trim()) {
    throw new Error("replacement text is required");
  }

  const session = await engine.ensureSessionLoaded(sessionPath);
  if (!session?.sessionManager) {
    throw new Error(`failed to load session ${sessionPath}`);
  }

  const latest = findLatestUserEntry(session.sessionManager.getBranch());
  if (!latest) throw new Error("No latest user message to replay");
  if (sourceEntryId && latest.id !== sourceEntryId) {
    throw new Error("Requested message is not the latest user message");
  }

  const original = promptPayloadFromUserMessage(latest.message);
  const promptText = displayMessage?.quickAction || displayMessage?.sessionRefs?.length
    ? mergeAttachmentMarkers(original.text, String(replacementText ?? displayMessage?.text ?? ''))
    : replacementText == null
    ? original.text
    : mergeAttachmentMarkers(original.text, String(replacementText));

  if (typeof session.navigateTree === "function") {
    const result = await session.navigateTree(latest.id, { summarize: false });
    if (result?.cancelled) throw new Error("latest user replay cancelled");
  } else if (latest.parentId) {
    session.sessionManager.branch(latest.parentId);
    replaceAgentMessagesFromBranch(session);
  } else {
    session.sessionManager.resetLeaf();
    replaceAgentMessagesFromBranch(session);
  }

  engine.emitEvent?.({
    type: "session_branch_reset",
    messageId: latest.id,
    clientMessageId: clientMessageId || null,
  }, sessionPath);

  return await submit(engine, {
    sessionPath,
    text: promptText,
    images: original.images.length ? original.images : undefined,
    displayMessage: {
      ...(displayMessage || {}),
      text: displayMessage?.text ?? (replacementText == null ? visibleUserText(original.text) : String(replacementText)),
      fromReplay: true,
    },
    uiContext,
  });
}

function findLatestUserEntry(branch) {
  if (!Array.isArray(branch)) return null;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message?.role === "user") return entry;
  }
  return null;
}

function promptPayloadFromUserMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };

  const text = content
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text)
    .join("");
  const images = content
    .filter(block => block?.type === "image")
    .map(block => ({ ...block }));
  return { text, images };
}

function mergeAttachmentMarkers(originalText, replacementText) {
  const markers = [];
  for (const line of String(originalText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!ATTACHMENT_MARKER_RE.test(trimmed)) break;
    markers.push(trimmed);
  }
  return markers.length ? `${markers.join("\n")}\n${replacementText}` : replacementText;
}

function visibleUserText(text) {
  const lines = String(text || "").split(/\r?\n/);
  while (lines.length && ATTACHMENT_MARKER_RE.test(lines[0].trim())) {
    lines.shift();
  }
  return lines.join("\n").trim();
}

function replaceAgentMessagesFromBranch(session) {
  session.refreshContext();
}
