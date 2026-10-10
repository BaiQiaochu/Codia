import { codiaFetch } from '../../hooks/use-codia-fetch';
import { ensureSession, loadSessions } from '../../stores/session-actions';
import { useStore } from '../../stores';
import { sessionScopedValue } from '../../stores/session-slice';
import type { AttachedFile } from '../../stores/input-slice';
import type { ContentBlock } from '../../stores/chat-types';
import type { PluginCardDetails } from '../../types';
import { isImageFile } from '../../utils/format';
import { renderMarkdown } from '../../utils/markdown';
import type { ChatVideoMode } from './ModelSelector';

export interface ChatVideoDraft {
  text: string;
  files?: readonly AttachedFile[];
}

interface VideoRouteResult {
  ok?: boolean;
  error?: string;
  content?: Array<{ type?: string; text?: string }>;
  details?: { card?: PluginCardDetails; [key: string]: unknown };
}

function ensureVisibleSession(sessionPath: string) {
  const state = useStore.getState();
  if (!sessionScopedValue(state, state.chatSessions, sessionPath)) {
    state.initSession(sessionPath, [], false);
  }
}

async function resolveCurrentSessionPath(): Promise<string | null> {
  const state = useStore.getState();
  if (state.currentSessionPath) return state.currentSessionPath;
  const ok = await ensureSession();
  if (!ok) return null;
  loadSessions();
  return useStore.getState().currentSessionPath || null;
}

function appendUserPrompt(sessionPath: string, prompt: string) {
  ensureVisibleSession(sessionPath);
  useStore.getState().appendItem(sessionPath, {
    type: 'message',
    data: {
      id: `chat-video-user-${Date.now()}`,
      role: 'user',
      text: prompt,
      textHtml: renderMarkdown(prompt),
      timestamp: Date.now(),
    },
  });
}

function contentText(result: VideoRouteResult): string {
  return Array.isArray(result.content)
    ? result.content
      .map(block => typeof block?.text === 'string' ? block.text : '')
      .filter(Boolean)
      .join('\n')
      .trim()
    : '';
}

function appendVideoResult(sessionPath: string, prompt: string, result: VideoRouteResult) {
  ensureVisibleSession(sessionPath);
  const blocks: ContentBlock[] = [];
  const text = contentText(result);
  if (text) blocks.push({ type: 'text', html: renderMarkdown(text) });
  if (result.details?.card) {
    const card = result.details.card;
    blocks.push({
      type: 'plugin_card',
      card: {
        ...card,
        pluginId: card.pluginId || 'image-gen',
      },
    });
  }
  useStore.getState().appendItem(sessionPath, {
    type: 'message',
    data: {
      id: `chat-video-${Date.now()}`,
      role: 'assistant',
      blocks: blocks.length > 0
        ? blocks
        : [{ type: 'text', html: renderMarkdown(`Video task submitted: ${prompt}`) }],
      timestamp: Date.now(),
    },
  });
}

function appendVideoFailure(sessionPath: string, message: string) {
  ensureVisibleSession(sessionPath);
  useStore.getState().appendItem(sessionPath, {
    type: 'message',
    data: {
      id: `chat-video-error-${Date.now()}`,
      role: 'assistant',
      blocks: [{ type: 'text', html: renderMarkdown(`Video task failed: ${message}`) }],
      timestamp: Date.now(),
    },
  });
}

function referenceImages(files: readonly AttachedFile[] | undefined): string[] {
  return (files || [])
    .filter(file => !file.isDirectory && isImageFile(file.name) && !!file.path)
    .map(file => file.path);
}

export async function submitChatVideoGeneration({
  draft,
  mode,
}: {
  draft: ChatVideoDraft;
  mode: ChatVideoMode;
}): Promise<boolean> {
  const prompt = String(draft.text || '').trim();
  if (!prompt) return false;

  const sessionPath = await resolveCurrentSessionPath();
  if (!sessionPath) return false;

  appendUserPrompt(sessionPath, prompt);

  try {
    const res = await codiaFetch('/api/plugins/image-gen/generate-video', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-codia-Session-Path': sessionPath,
      },
      body: JSON.stringify({
        prompt,
        provider: mode.provider,
        model: mode.model,
        images: referenceImages(draft.files),
        sessionPath,
      }),
      timeout: 10 * 60 * 1000,
    });
    const data = await res.json().catch(() => ({})) as VideoRouteResult;
    if (!res.ok || data.ok === false || data.error) {
      appendVideoFailure(sessionPath, data.error || 'Video generation request failed');
      useStore.getState().addToast?.(data.error || 'Video generation request failed', 'error');
      return false;
    }
    appendVideoResult(sessionPath, prompt, data);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendVideoFailure(sessionPath, message);
    useStore.getState().addToast?.(message, 'error');
    return false;
  }
}
