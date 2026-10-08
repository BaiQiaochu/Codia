// desktop/src/react/utils/screenshot.ts
import { useStore } from '../stores';
import { sessionScopedValue } from '../stores/session-slice';
import { selectSelectedIdsBySession } from '../stores/session-selectors';
import { getDesktopApi } from './desktop-api';
import { extractScreenshotPayload, buildThemeName } from './screenshot-extract';
import { readScreenshotSegmentVisibleCharLimit, splitScreenshotMessages } from './screenshot-segments';
import { yuanFallbackAvatar } from './agent-helpers';
import type { ChatMessage } from '../stores/chat-types';
import type { ScreenshotPayload } from './screenshot-extract';

type StoreSnapshot = ReturnType<typeof useStore.getState>;
type ScreenshotRenderPayload = ScreenshotPayload & {
  saveDir?: string | null;
  locale?: string | null;
  segmentIndex?: number;
  segmentTotal?: number;
  filePath?: string | null;
  fileName?: string | null;
  articleType?: string | null;
  language?: string | null;
};
type ScreenshotRenderResult = { success?: boolean; canceled?: boolean; error?: string; dir?: string; filePath?: string };
type AvatarCache = { assistant: string | null; user: string | null };
type ArticleScreenshotOptions = {
  saveDir?: string | null;
  filePath?: string | null;
  fileName?: string | null;
  articleType?: string | null;
  language?: string | null;
};
type MarkdownFileScreenshotOptions = {
  saveDir?: string | null;
  fileName?: string | null;
};

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeScreenshotResult(result: unknown): ScreenshotRenderResult {
  if (result && typeof result === 'object') return result as ScreenshotRenderResult;
  return { success: false, error: 'invalid screenshot result' };
}

function notifyScreenshot(text: string, type: 'success' | 'error', deskDir?: string, filePath?: string): void {
  window.dispatchEvent(new CustomEvent('gsap-inline-notice', {
    detail: { text, type, deskDir, filePath },
  }));
}

function currentScreenshotLocale(): string | null {
  return window.i18n?.locale || null;
}

async function dispatchScreenshot(payload: ScreenshotRenderPayload): Promise<void> {
  const t = window.t ?? ((p: string) => p);
  const desktopApi = getDesktopApi();
  if (!desktopApi?.screenshotRender) {
    notifyScreenshot(t('common.screenshotFailed'), 'error');
    return;
  }

  try {
    const result = normalizeScreenshotResult(await desktopApi.screenshotRender(payload));
    if (result.success) {
      notifyScreenshot(t('common.screenshotSaved'), 'success', result.dir, result.filePath);
    } else {
      notifyScreenshot(`${t('common.screenshotFailed')}: ${result.error || 'unknown error'}`, 'error');
    }
  } catch (err) {
    notifyScreenshot(`${t('common.screenshotFailed')}: ${getErrorMessage(err)}`, 'error');
  }
}

function beginScreenshotProgress(totalBlocks: number, totalPages: number): () => void {
  const state = useStore.getState() as StoreSnapshot & {
    beginScreenshotTask?: (progress: {
      completedBlocks: number;
      totalBlocks: number;
      currentPage: number;
      totalPages: number;
    }) => void;
    endScreenshotTask?: () => void;
  };
  state.beginScreenshotTask?.({
    completedBlocks: 0,
    totalBlocks,
    currentPage: totalPages > 0 ? 1 : 0,
    totalPages,
  });

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const latest = useStore.getState() as StoreSnapshot & { endScreenshotTask?: () => void };
    latest.endScreenshotTask?.();
  };
}

function updateScreenshotProgress(progress: { completedBlocks?: number; currentPage?: number }): void {
  const state = useStore.getState() as StoreSnapshot & {
    updateScreenshotProgress?: (progress: { completedBlocks?: number; currentPage?: number }) => void;
  };
  state.updateScreenshotProgress?.(progress);
}

async function resolveAvatarCache(state: StoreSnapshot): Promise<AvatarCache> {
  const [assistant, user] = await Promise.all([
    state.currentAgentId
      ? fetchAvatarAsDataUrl('assistant', state.currentAgentId).catch(() => null)
      : Promise.resolve(null),
    fetchAvatarAsDataUrl('user', null).catch(() => null),
  ]);
  const [assistantFallback, userFallback] = await Promise.all([
    assistant
      ? Promise.resolve(assistant)
      : resolveAssistantFallbackAvatar(state).catch(() => null),
    user
      ? Promise.resolve(user)
      : Promise.resolve(userFallbackAvatar(state.userName || 'User')),
  ]);

  return {
    assistant: assistantFallback,
    user: userFallback,
  };
}

async function buildScreenshotPayloadForMessages(
  messages: ChatMessage[],
  theme: string,
  state: StoreSnapshot,
  avatars: AvatarCache,
  imageCache: Map<string, string>,
  segment: { index: number; total: number },
): Promise<ScreenshotRenderPayload> {
  const payload: ScreenshotRenderPayload = extractScreenshotPayload(messages, theme);
  payload.saveDir = state.homeFolder || null;
  payload.locale = currentScreenshotLocale();
  if (segment.total > 1) {
    payload.segmentIndex = segment.index;
    payload.segmentTotal = segment.total;
  }

  if (!payload.messages) return payload;

  const globalAgentName = state.agentName || '助手';
  const userName = state.userName || '';

  for (const msg of payload.messages) {
    if (msg.role === 'assistant') {
      msg.name = globalAgentName;
      msg.avatarDataUrl = avatars.assistant;
    } else {
      msg.name = userName || 'User';
      msg.avatarDataUrl = avatars.user;
    }

    for (const block of msg.blocks) {
      if (block.type !== 'image' || !block.content || block.content.startsWith('data:')) continue;
      const cached = imageCache.get(block.content);
      if (cached) {
        block.content = cached;
        continue;
      }
      try {
        const dataUrl = await fetchImageAsDataUrl(block.content, inferImageMimeType(block.content));
        imageCache.set(block.content, dataUrl);
        block.content = dataUrl;
      } catch {
        // Unreadable images should not fail the whole screenshot.
      }
    }
  }

  return payload;
}

export async function takeScreenshot(targetMessageId: string, sessionPath: string): Promise<void> {
  const state = useStore.getState();
  const ids = selectSelectedIdsBySession(state, sessionPath);
  const messageIds = ids.length > 0 ? ids : [targetMessageId];

  const session = sessionScopedValue(state, state.chatSessions, sessionPath);
  if (!session) return;

  const messages: ChatMessage[] = [];
  for (const item of session.items) {
    if (item.type !== 'message') continue;
    if (messageIds.includes(item.data.id)) {
      messages.push(item.data);
    }
  }
  if (messages.length === 0) return;

  const color = localStorage.getItem('gsap-screenshot-color') || 'gsap';
  const width = localStorage.getItem('gsap-screenshot-width') || 'mobile';
  const theme = buildThemeName(color, width);

  const t = window.t ?? ((p: string) => p);
  const desktopApi = getDesktopApi();
  if (!desktopApi?.screenshotRender) {
    notifyScreenshot(t('common.screenshotFailed'), 'error');
    return;
  }

  const segmentLimit = readScreenshotSegmentVisibleCharLimit();
  const chunks = splitScreenshotMessages(messages, segmentLimit);
  const endProgress = beginScreenshotProgress(messages.length, chunks.length);
  try {
    const avatars = await resolveAvatarCache(state);
    const imageCache = new Map<string, string>();
    const results: ScreenshotRenderResult[] = [];
    let completedBlocks = 0;

    for (let i = 0; i < chunks.length; i += 1) {
      updateScreenshotProgress({ currentPage: i + 1 });
      const payload = await buildScreenshotPayloadForMessages(
        chunks[i],
        theme,
        state,
        avatars,
        imageCache,
        { index: i + 1, total: chunks.length },
      );
      const result = normalizeScreenshotResult(await desktopApi.screenshotRender(payload));
      if (!result.success) {
        throw new Error(result.error || t('common.screenshotFailed'));
      }
      results.push(result);
      completedBlocks += chunks[i].length;
      updateScreenshotProgress({ completedBlocks });
    }

    const saveDir = results.find(result => result.dir)?.dir;
    const filePath = results.find(result => result.filePath)?.filePath;
    const savedText = chunks.length > 1
      ? t('common.screenshotSavedMultiple', { count: chunks.length })
      : t('common.screenshotSaved');
    notifyScreenshot(savedText, 'success', saveDir, filePath);
  } catch (err) {
    notifyScreenshot(`${t('common.screenshotFailed')}: ${getErrorMessage(err)}`, 'error');
  } finally {
    endProgress();
  }
}

export async function takeArticleScreenshot(markdown: string, options: ArticleScreenshotOptions = {}): Promise<void> {
  const color = localStorage.getItem('gsap-screenshot-color') || 'gsap';
  const width = localStorage.getItem('gsap-screenshot-width') || 'mobile';
  const theme = buildThemeName(color, width);
  const homeFolder = useStore.getState().homeFolder || null;

  await dispatchScreenshot({
    mode: 'article',
    theme,
    markdown,
    saveDir: options.saveDir ?? homeFolder,
    locale: currentScreenshotLocale(),
    filePath: options.filePath ?? null,
    fileName: options.fileName ?? null,
    articleType: options.articleType ?? null,
    language: options.language ?? null,
  });
}

export async function takeMarkdownFileScreenshot(
  filePath: string,
  options: MarkdownFileScreenshotOptions = {},
): Promise<void> {
  const t = window.t ?? ((p: string) => p);
  try {
    const markdown = await readMarkdownFileForScreenshot(filePath);
    await takeArticleScreenshot(markdown, {
      saveDir: options.saveDir ?? undefined,
      filePath,
      fileName: options.fileName ?? basenameFromPath(filePath),
      articleType: 'markdown',
      language: 'markdown',
    });
  } catch (err) {
    notifyScreenshot(`${t('common.screenshotFailed')}: ${getErrorMessage(err)}`, 'error');
  }
}

async function readMarkdownFileForScreenshot(filePath: string): Promise<string> {
  const platform = window.platform as unknown as {
    readFileSnapshot?: (path: string) => Promise<string | { content?: unknown; text?: unknown }>;
    readFile?: (path: string) => Promise<string | { content?: unknown; text?: unknown }>;
  } | undefined;
  const snapshot = await platform?.readFileSnapshot?.(filePath).catch(() => null);
  const snapshotText = extractFileText(snapshot);
  if (snapshotText !== null) return snapshotText;
  const direct = await platform?.readFile?.(filePath).catch(() => null);
  const directText = extractFileText(direct);
  if (directText !== null) return directText;
  throw new Error(`failed to read markdown file: ${filePath}`);
}

function extractFileText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.content === 'string') return record.content;
    if (typeof record.text === 'string') return record.text;
  }
  return null;
}

function basenameFromPath(filePath: string): string {
  return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || 'document.md';
}

async function fetchImageAsDataUrl(filePath: string, preferredMimeType?: string | null): Promise<string> {
  const url = window.platform?.getFileUrl?.(filePath) ?? (filePath.match(/^[A-Za-z]:/)
    ? `file:///${filePath.replace(/\\/g, '/')}`
    : `file://${filePath}`);
  return fetchUrlAsDataUrl(url, preferredMimeType);
}

async function fetchUrlAsDataUrl(url: string, preferredMimeType?: string | null): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`failed to fetch image: ${resp.status}`);
  const blob = await resp.blob();
  return blobToDataUrl(blob, preferredMimeType);
}

async function blobToDataUrl(blob: Blob, preferredMimeType?: string | null): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mimeType = preferredMimeType || blob.type || 'application/octet-stream';
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const bufferCtor = (globalThis as unknown as { Buffer?: { from: (bytes: Uint8Array) => { toString: (encoding: string) => string } } }).Buffer;
  if (bufferCtor) return bufferCtor.from(bytes).toString('base64');

  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function inferImageMimeType(filePath: string): string | null {
  const cleanPath = String(filePath || '').split(/[?#]/, 1)[0].toLowerCase();
  if (cleanPath.endsWith('.png')) return 'image/png';
  if (cleanPath.endsWith('.jpg') || cleanPath.endsWith('.jpeg')) return 'image/jpeg';
  if (cleanPath.endsWith('.gif')) return 'image/gif';
  if (cleanPath.endsWith('.webp')) return 'image/webp';
  if (cleanPath.endsWith('.svg')) return 'image/svg+xml';
  return null;
}

function resolveAssetUrl(src: string): string {
  try {
    return new URL(src, window.location.href).toString();
  } catch {
    return src;
  }
}

function userFallbackAvatar(displayName: string): string {
  const initial = String(displayName || 'U').trim().slice(0, 1).toUpperCase() || 'U';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="28" fill="#eef3f8"/><circle cx="48" cy="38" r="16" fill="#94a3b8"/><path d="M22 78c4-18 17-28 26-28s22 10 26 28" fill="#94a3b8"/><text x="48" y="55" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="700" fill="#1f2937">${initial}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function resolveAssistantFallbackAvatar(state: StoreSnapshot): Promise<string | null> {
  const fallbackSrc = yuanFallbackAvatar(state.agentYuan || undefined);
  if (!fallbackSrc) return null;
  if (fallbackSrc.startsWith('data:')) return fallbackSrc;
  try {
    return await fetchUrlAsDataUrl(resolveAssetUrl(fallbackSrc));
  } catch {
    return userFallbackAvatar(state.agentName || '助手');
  }
}

async function fetchAvatarAsDataUrl(role: 'assistant' | 'user', agentId: string | null): Promise<string | null> {
  const desktopApi = getDesktopApi();
  const port = await desktopApi?.getServerPort?.();
  const token = await desktopApi?.getServerToken?.();
  if (!port || !token) return null;

  const url = role === 'user'
    ? `http://127.0.0.1:${port}/api/avatar/user`
    : `http://127.0.0.1:${port}/api/agents/${agentId}/avatar`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const blob = await resp.blob();
  return blobToDataUrl(blob).catch(() => null);
}
