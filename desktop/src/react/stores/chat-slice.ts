/**
 * chat-slice.ts — Per-session 消息数据 + 滚动位置
 */

import type {
  ChatListItem,
  ChatMessage,
  ContentBlock,
  SessionConfirmationBlock,
  SessionMessages,
  SessionModel,
  SessionRegistryFile,
} from './chat-types';
import { invalidateSessionCache } from './selectors/file-refs';
import { invalidateStreamBuffer, invalidateStreamResumeMeta } from './stream-invalidator';
import { clearMessageLiveVersion } from './message-live-version';
import { sessionScopedKey, sessionScopedValue } from './session-slice';

type BlockPatch = Record<string, unknown>;
type SessionConfirmationState = {
  pendingSessionConfirmationsByPath: Record<string, SessionConfirmationBlock>;
};

export interface ChatSlice {
  chatSessions: Record<string, SessionMessages>;
  sessionRegistryFilesByPath: Record<string, SessionRegistryFile[]>;
  hiddenSessionResourceIdsByPath: Record<string, string[]>;
  sessionModelsByPath: Record<string, SessionModel>;
  _loadMessagesVersion: Record<string, number>;
  scrollPositions: Record<string, number>;

  initSession: (path: string, items: ChatListItem[], hasMore: boolean, revision?: string | null) => void;
  prependItems: (path: string, items: ChatListItem[], hasMore: boolean) => void;
  appendItem: (path: string, item: ChatListItem) => void;
  updateLastMessage: (path: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  updateMessageById: (path: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => boolean;
  truncateSessionFromMessage: (path: string, messageId: string) => boolean;
  appendInterludeItem: (sessionPath: string, block: Extract<ContentBlock, { type: 'interlude' }>) => boolean;
  resolveBlockByTaskId: (sessionPath: string, taskId: string, resolution: ContentBlock) => boolean;
  patchBlockByTaskId: (sessionPath: string, taskId: string, patch: BlockPatch) => void;
  _pendingBlockPatches: Record<string, BlockPatch>;
  setSessionRegistryFiles: (path: string, files: SessionRegistryFile[]) => void;
  upsertSessionRegistryFile: (path: string, file: SessionRegistryFile) => void;
  hideSessionResources: (path: string, ids: readonly string[]) => void;

  updateSessionModel: (path: string, model: SessionModel) => void;
  bumpLoadMessagesVersion: (path: string) => number;
  setLoadingMore: (path: string, loading: boolean) => void;
  clearSession: (path: string) => void;
  saveScrollPosition: (path: string, scrollTop: number) => void;
}

const MAX_CACHED_SESSIONS = 8;

function keyForSession(state: Record<string, unknown>, path: string): string {
  return sessionScopedKey(state, path) || path;
}

function scopedMapValue<T>(state: Record<string, unknown>, map: Record<string, T>, path: string): T | undefined {
  return sessionScopedValue(state, map, path) as T | undefined;
}

function putScopedMapValue<T>(
  state: Record<string, unknown>,
  map: Record<string, T>,
  path: string,
  value: T,
): Record<string, T> {
  const key = keyForSession(state, path);
  const next = { ...map, [key]: value };
  if (key !== path) delete next[path];
  return next;
}

function deleteScopedMapValue<T>(
  state: Record<string, unknown>,
  map: Record<string, T>,
  path: string,
): Record<string, T> {
  const key = keyForSession(state, path);
  const next = { ...map };
  delete next[key];
  if (key !== path) delete next[path];
  return next;
}

function invalidateSessionOwnedCaches(state: Record<string, unknown>, path: string): void {
  const key = keyForSession(state, path);
  invalidateSessionCache(path);
  if (key !== path) invalidateSessionCache(key);
  invalidateStreamBuffer(path);
  if (key !== path) invalidateStreamBuffer(key);
  invalidateStreamResumeMeta(path);
  if (key !== path) invalidateStreamResumeMeta(key);
  clearMessageLiveVersion(path);
}

function invalidateSessionFileRefCache(state: Record<string, unknown>, path: string): void {
  const key = keyForSession(state, path);
  invalidateSessionCache(path);
  if (key !== path) invalidateSessionCache(key);
}

export const createChatSlice = (
  set: (partial: Partial<ChatSlice> | ((s: ChatSlice) => Partial<ChatSlice>)) => void,
  get: () => ChatSlice,
): ChatSlice => ({
  chatSessions: {},
  sessionRegistryFilesByPath: {},
  hiddenSessionResourceIdsByPath: {},
  sessionModelsByPath: {},
  _loadMessagesVersion: {},
  scrollPositions: {},

  initSession: (path, items, hasMore, revision = null) => set((s) => {
    const key = keyForSession(s as unknown as Record<string, unknown>, path);
    const sessions = { ...s.chatSessions };
    const registryFiles = { ...s.sessionRegistryFilesByPath };
    const hiddenResourceIds = { ...s.hiddenSessionResourceIdsByPath };
    const scrollPositions = { ...s.scrollPositions };
    const normalizedItems = removeDuplicateAssistantMediaReplayItems(items);
    sessions[key] = {
      items: normalizedItems,
      hasMore,
      loadingMore: false,
      oldestId: firstMessageId(normalizedItems),
      revision,
    };
    if (key !== path) delete sessions[path];
    const keys = Object.keys(sessions);
    if (keys.length > MAX_CACHED_SESSIONS) {
      const oldest = keys.find((k) => k !== key);
      if (oldest) {
        delete sessions[oldest];
        delete registryFiles[oldest];
        delete hiddenResourceIds[oldest];
        delete scrollPositions[oldest];
        invalidateSessionCache(oldest);
        invalidateStreamBuffer(oldest);
        invalidateStreamResumeMeta(oldest);
      }
    }
    return { chatSessions: sessions, sessionRegistryFilesByPath: registryFiles, hiddenSessionResourceIdsByPath: hiddenResourceIds, scrollPositions };
  }),

  prependItems: (path, items, hasMore) => set((s) => {
    const session = scopedMapValue<SessionMessages>(s as unknown as Record<string, unknown>, s.chatSessions, path);
    if (!session) return {};
    const merged = removeDuplicateAssistantMediaReplayItems([...items, ...session.items]);
    return {
      chatSessions: putScopedMapValue(s as unknown as Record<string, unknown>, s.chatSessions, path, {
          ...session,
          items: merged,
          hasMore,
          loadingMore: false,
          oldestId: firstMessageId(merged) || session.oldestId,
        }),
    };
  }),

  appendItem: (path, item) => set((s) => {
    const session = scopedMapValue<SessionMessages>(s as unknown as Record<string, unknown>, s.chatSessions, path);
    if (!session) return {};
    return {
      chatSessions: putScopedMapValue(
        s as unknown as Record<string, unknown>,
        s.chatSessions,
        path,
        { ...session, items: removeDuplicateAssistantMediaReplayItems([...session.items, item]) },
      ),
    };
  }),

  updateLastMessage: (path, updater) => set((s) => {
    const session = scopedMapValue<SessionMessages>(s as unknown as Record<string, unknown>, s.chatSessions, path);
    if (!session || session.items.length === 0) return {};
    const items = [...session.items];
      const lastIdx = items.length - 1;
      const last = items[lastIdx];
      if (last.type !== 'message') return {};
      items[lastIdx] = { type: 'message', data: updater(last.data) };
      const normalizedItems = removeDuplicateAssistantMediaReplayItems(items);
      return {
        chatSessions: putScopedMapValue(
          s as unknown as Record<string, unknown>,
          s.chatSessions,
          path,
          { ...session, items: normalizedItems },
        ),
      };
  }),

  updateMessageById: (path, messageId, updater) => {
    const session = scopedMapValue<SessionMessages>(
      get() as unknown as Record<string, unknown>,
      get().chatSessions,
      path,
    );
    if (!session) return false;
    const targetIdx = session.items.findIndex((item) =>
      item.type === 'message' &&
      item.data.id === messageId &&
      item.data.role === 'assistant',
    );
    if (targetIdx < 0) return false;

    set((s) => {
      const latest = scopedMapValue<SessionMessages>(
        s as unknown as Record<string, unknown>,
        s.chatSessions,
        path,
      );
      if (!latest) return {};
      const latestIdx = latest.items.findIndex((item) =>
        item.type === 'message' &&
        item.data.id === messageId &&
        item.data.role === 'assistant',
      );
      if (latestIdx < 0) return {};
      const items = [...latest.items];
      const current = items[latestIdx];
      if (current.type !== 'message' || current.data.role !== 'assistant') return {};
      items[latestIdx] = { type: 'message', data: updater(current.data) };
      const dedupedItems = removeDuplicateAssistantMediaReplay(items, latestIdx);
      if (dedupedItems !== items) {
        invalidateSessionFileRefCache(s as unknown as Record<string, unknown>, path);
      }
      return {
        chatSessions: putScopedMapValue(
          s as unknown as Record<string, unknown>,
          s.chatSessions,
          path,
          { ...latest, items: dedupedItems },
        ),
      };
    });
    return true;
  },

  truncateSessionFromMessage: (path, messageId) => {
    const session = scopedMapValue<SessionMessages>(
      get() as unknown as Record<string, unknown>,
      get().chatSessions,
      path,
    );
    if (!session) return false;
    const targetIdx = session.items.findIndex((item) =>
      item.type === 'message' &&
      (item.data.id === messageId || item.data.sourceEntryId === messageId),
    );
    if (targetIdx < 0) return false;

    set((s) => {
      const latest = scopedMapValue<SessionMessages>(
        s as unknown as Record<string, unknown>,
        s.chatSessions,
        path,
      );
      if (!latest) return {};
      const latestIdx = latest.items.findIndex((item) =>
        item.type === 'message' &&
        (item.data.id === messageId || item.data.sourceEntryId === messageId),
      );
      if (latestIdx < 0) return {};
      invalidateSessionOwnedCaches(s as unknown as Record<string, unknown>, path);
      return {
        chatSessions: putScopedMapValue(
          s as unknown as Record<string, unknown>,
          s.chatSessions,
          path,
          {
            ...latest,
            items: latest.items.slice(0, latestIdx),
          },
        ),
      };
    });
    return true;
  },

  _pendingBlockPatches: {} as Record<string, BlockPatch>,

  appendInterludeItem: (sessionPath, block) => {
    if (!scopedMapValue<SessionMessages>(
      get() as unknown as Record<string, unknown>,
      get().chatSessions,
      sessionPath,
    )) return false;

    let consumed = false;
    set((s) => {
      const session = scopedMapValue<SessionMessages>(
        s as unknown as Record<string, unknown>,
        s.chatSessions,
        sessionPath,
      );
      if (!session) return {};
      const items = [...session.items];
      if (hasEquivalentInterludeItem(items, block)) {
        consumed = true;
        return {};
      }
      const taskId = block.taskId || null;
      if (taskId && isFailedMediaInterludeBlock(block, taskId) && hasFailedMediaGenerationItem(items, taskId)) {
        consumed = true;
        return {};
      }

      items.push({
        type: 'interlude',
        id: block.id || `interlude:${block.taskId || 'task'}:${block.status || 'status'}:${Date.now()}`,
        data: block,
      });
      consumed = true;
      invalidateSessionFileRefCache(s as unknown as Record<string, unknown>, sessionPath);
      return {
        chatSessions: putScopedMapValue(
          s as unknown as Record<string, unknown>,
          s.chatSessions,
          sessionPath,
          { ...session, items },
        ),
      };
    });

    return consumed;
  },

  resolveBlockByTaskId: (sessionPath, taskId, resolution) => {
    if (!scopedMapValue<SessionMessages>(
      get() as unknown as Record<string, unknown>,
      get().chatSessions,
      sessionPath,
    )) return false;

    let consumed = false;
    set((s) => {
      const session = scopedMapValue<SessionMessages>(
        s as unknown as Record<string, unknown>,
        s.chatSessions,
        sessionPath,
      );
      if (!session) return {};
      const items = [...session.items];

      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i];
        if (item.type !== 'message' || item.data.role !== 'assistant') continue;
        const blocks = item.data.blocks;
        if (!blocks) continue;
        const blockIdx = blocks.findIndex((block) => (
          isPendingMediaGenerationBlock(block, taskId) ||
          isResolvedTaskBlock(block, taskId)
        ));
        if (blockIdx < 0) continue;

        consumed = true;
        const isFailedMediaResolution = isFailedMediaGenerationBlock(resolution, taskId);
        if (isResolvedTaskBlock(blocks[blockIdx], taskId)) {
          if (isFailedMediaResolution) {
            const cleaned = removeFailedMediaInterludeItems(items, taskId);
            if (cleaned.changed) {
              invalidateSessionFileRefCache(s as unknown as Record<string, unknown>, sessionPath);
              return {
                chatSessions: putScopedMapValue(
                  s as unknown as Record<string, unknown>,
                  s.chatSessions,
                  sessionPath,
                  { ...session, items: cleaned.items },
                ),
              };
            }
          }
          return {};
        }

        const nextBlocks = [...blocks];
        nextBlocks[blockIdx] = resolution;
        items[i] = { ...item, data: { ...item.data, blocks: nextBlocks } };
        const nextItems = isFailedMediaResolution
          ? removeFailedMediaInterludeItems(items, taskId).items
          : items;
        invalidateSessionFileRefCache(s as unknown as Record<string, unknown>, sessionPath);
        return {
          chatSessions: putScopedMapValue(
            s as unknown as Record<string, unknown>,
            s.chatSessions,
            sessionPath,
            { ...session, items: nextItems },
          ),
        };
      }

      return {};
    });

    return consumed;
  },

  setSessionRegistryFiles: (path, files) => set((s) => {
    invalidateSessionFileRefCache(s as unknown as Record<string, unknown>, path);
    return {
      sessionRegistryFilesByPath: putScopedMapValue(
        s as unknown as Record<string, unknown>,
        s.sessionRegistryFilesByPath,
        path,
        [...files],
      ),
    };
  }),

  hideSessionResources: (path, ids) => set((s) => {
    const current = scopedMapValue<readonly string[]>(
      s as unknown as Record<string, unknown>,
      s.hiddenSessionResourceIdsByPath,
      path,
    ) || [];
    const next = Array.from(new Set([...current, ...ids]));
    invalidateSessionFileRefCache(s as unknown as Record<string, unknown>, path);
    return {
      hiddenSessionResourceIdsByPath: putScopedMapValue(
        s as unknown as Record<string, unknown>,
        s.hiddenSessionResourceIdsByPath,
        path,
        next,
      ),
    };
  }),

  upsertSessionRegistryFile: (path, file) => set((s) => {
    const key = registryFileKey(file);
    if (!key) return {};
    const files = scopedMapValue<SessionRegistryFile[]>(
      s as unknown as Record<string, unknown>,
      s.sessionRegistryFilesByPath,
      path,
    ) || [];
    const idx = files.findIndex(existing => registryFileKey(existing) === key);
    const next = idx >= 0 ? [...files] : [...files, file];
    if (idx >= 0) next[idx] = { ...files[idx], ...file };
    invalidateSessionFileRefCache(s as unknown as Record<string, unknown>, path);
    return {
      sessionRegistryFilesByPath: putScopedMapValue(
        s as unknown as Record<string, unknown>,
        s.sessionRegistryFilesByPath,
        path,
        next,
      ),
    };
  }),

  patchBlockByTaskId: (sessionPath, taskId, patch) => {
    const session = scopedMapValue<SessionMessages>(
      get() as unknown as Record<string, unknown>,
      get().chatSessions,
      sessionPath,
    );
    if (!session) {
      const pending = get()._pendingBlockPatches;
      pending[taskId] = { ...(pending[taskId] || {}), ...patch };
      return;
    }
    const items = [...session.items];
    let found = false;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item.type !== 'message' || item.data.role !== 'assistant') continue;
      const blocks = item.data.blocks;
      if (!blocks) continue;
      const blockIdx = blocks.findIndex((b) => b.type === 'subagent' && b.taskId === taskId);
      if (blockIdx === -1) continue;
      const targetBlock = blocks[blockIdx];
      if (!targetBlock || targetBlock.type !== 'subagent') continue;
      const newBlocks = [...blocks];
      newBlocks[blockIdx] = { ...targetBlock, ...patch };
      const newItems = [...items];
      newItems[i] = { ...item, data: { ...item.data, blocks: newBlocks } };
      set((s) => ({
        chatSessions: putScopedMapValue(
          s as unknown as Record<string, unknown>,
          s.chatSessions,
          sessionPath,
          { ...(scopedMapValue<SessionMessages>(s as unknown as Record<string, unknown>, s.chatSessions, sessionPath) || session), items: newItems },
        ),
      }));
      found = true;
      break;
    }
    if (!found) {
      const pending = get()._pendingBlockPatches;
      pending[taskId] = { ...(pending[taskId] || {}), ...patch };
    }
  },

  updateSessionModel: (path, model) => {
    if (!model?.id || !model?.provider) {
      console.warn('[chat-slice] updateSessionModel rejected: missing id/provider', path, model);
      return;
    }
    set((s) => ({
      sessionModelsByPath: putScopedMapValue(
        s as unknown as Record<string, unknown>,
        s.sessionModelsByPath,
        path,
        model,
      ),
    }));
  },

  bumpLoadMessagesVersion: (path) => {
    const current = scopedMapValue<number>(
      get() as unknown as Record<string, unknown>,
      get()._loadMessagesVersion,
      path,
    ) ?? 0;
    const next = current + 1;
    set((s) => ({
      _loadMessagesVersion: putScopedMapValue(
        s as unknown as Record<string, unknown>,
        s._loadMessagesVersion,
        path,
        next,
      ),
    }));
    return next;
  },

  setLoadingMore: (path, loading) => set((s) => {
    const session = scopedMapValue<SessionMessages>(s as unknown as Record<string, unknown>, s.chatSessions, path);
    if (!session) return {};
    return {
      chatSessions: putScopedMapValue(
        s as unknown as Record<string, unknown>,
        s.chatSessions,
        path,
        { ...session, loadingMore: loading },
      ),
    };
  }),

  clearSession: (path) => set((s) => {
    const state = s as unknown as Record<string, unknown>;
    const sessionState = s as ChatSlice & Partial<SessionConfirmationState>;
    const sessions = deleteScopedMapValue(state, s.chatSessions, path);
    const registryFiles = deleteScopedMapValue(state, s.sessionRegistryFilesByPath, path);
    const hiddenResourceIds = deleteScopedMapValue(state, s.hiddenSessionResourceIdsByPath, path);
    const models = deleteScopedMapValue(state, s.sessionModelsByPath, path);
    const versions = deleteScopedMapValue(state, s._loadMessagesVersion, path);
    const scrollPositions = deleteScopedMapValue(state, s.scrollPositions, path);
    const pendingConfirmations = { ...(sessionState.pendingSessionConfirmationsByPath || {}) };
    const pendingSessionConfirmationsByPath = deleteScopedMapValue(state, pendingConfirmations, path);
    invalidateSessionOwnedCaches(state, path);
    const result: Partial<ChatSlice> & Partial<SessionConfirmationState> = {
      chatSessions: sessions,
      sessionRegistryFilesByPath: registryFiles,
      hiddenSessionResourceIdsByPath: hiddenResourceIds,
      sessionModelsByPath: models,
      _loadMessagesVersion: versions,
      scrollPositions,
      pendingSessionConfirmationsByPath,
    };
    return result;
  }),

  saveScrollPosition: (path, scrollTop) => set((s) => ({
    scrollPositions: putScopedMapValue(
      s as unknown as Record<string, unknown>,
      s.scrollPositions,
      path,
      scrollTop,
    ),
  })),
});

function registryFileKey(file: SessionRegistryFile): string | null {
  const fileId = file.fileId || file.id;
  if (fileId) return `id:${fileId}`;
  const filePath = file.filePath || file.realPath;
  return filePath ? `path:${filePath}` : null;
}

function isPendingMediaGenerationBlock(block: ContentBlock, taskId: string): boolean {
  return block.type === 'media_generation' &&
    block.taskId === taskId &&
    block.status === 'pending';
}

function isResolvedTaskBlock(block: ContentBlock, taskId: string): boolean {
  if (block.type === 'file') return block.replacesTaskId === taskId;
  return block.type === 'media_generation' &&
    block.taskId === taskId &&
    block.status !== 'pending';
}

function normalizeAssistantReplayText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function assistantReplayTextSignature(message: ChatMessage): string {
  return normalizeAssistantReplayText((message.blocks || [])
    .map((block) => {
      if (block.type === 'text') return block.source || block.html || '';
      if (block.type === 'invoke') return `${block.name}\n${block.content || ''}`;
      return '';
    })
    .filter(Boolean)
    .join('\n'));
}

function settledMediaReplayKeys(message: ChatMessage): Set<string> {
  const keys = new Set<string>();
  for (const block of message.blocks || []) {
    for (const key of settledMediaReplayKeysForBlock(block)) keys.add(key);
  }
  return keys;
}

function settledMediaReplayKeysForBlock(block: ContentBlock): Set<string> {
  const keys = new Set<string>();
  if (block.type === 'file') {
    if (block.fileId) keys.add(`file:${block.fileId}`);
    if (block.resourceId) keys.add(`resource:${block.resourceId}`);
    if (block.resource?.resourceId) keys.add(`resource:${block.resource.resourceId}`);
    addMediaPathKey(keys, block.filePath);
    addMediaPathKey(keys, (block as { realPath?: string }).realPath);
    if (block.replacesTaskId) keys.add(`task:${block.replacesTaskId}`);
  } else if (block.type === 'media_generation' && block.status !== 'pending') {
    keys.add(`task:${block.taskId}`);
  }
  return keys;
}

function addMediaPathKey(keys: Set<string>, value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) return;
  const raw = value.trim();
  keys.add(`path:${raw}`);
  keys.add(`path-normalized:${raw.replace(/\\/g, '/').toLowerCase()}`);
}

function isSettledMediaReplayBlock(block: ContentBlock): boolean {
  return block.type === 'file' ||
    (block.type === 'media_generation' && block.status !== 'pending');
}

function hasOnlySettledMediaReplayBlocks(message: ChatMessage): boolean {
  const blocks = message.blocks || [];
  return blocks.length > 0 && blocks.every(isSettledMediaReplayBlock);
}

function hasAnyKeyAlreadySeen(keys: Set<string>, seen: Set<string>): boolean {
  for (const key of keys) {
    if (seen.has(key)) return true;
  }
  return false;
}

function collectPriorSettledMediaKeys(items: ChatListItem[], targetIdx: number): Set<string> {
  const keys = new Set<string>();
  for (let i = targetIdx - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.type === 'message' && item.data.role === 'user') break;
    if (item.type !== 'message' || item.data.role !== 'assistant') continue;
    for (const key of settledMediaReplayKeys(item.data)) keys.add(key);
  }
  return keys;
}

function hasPriorAssistantTextSignature(items: ChatListItem[], targetIdx: number, signature: string): boolean {
  if (!signature) return false;
  for (let i = targetIdx - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.type === 'message' && item.data.role === 'user') break;
    if (item.type !== 'message' || item.data.role !== 'assistant') continue;
    if (assistantReplayTextSignature(item.data) === signature) return true;
  }
  return false;
}

function removeDuplicateAssistantMediaReplay(items: ChatListItem[], targetIdx: number): ChatListItem[] {
  const target = items[targetIdx];
  if (!target || target.type !== 'message' || target.data.role !== 'assistant') return items;

  const targetSignature = assistantReplayTextSignature(target.data);
  const targetMediaKeys = settledMediaReplayKeys(target.data);
  const targetIsMediaOnlyReplay = targetMediaKeys.size > 0 && hasOnlySettledMediaReplayBlocks(target.data);
  if (!targetSignature && !targetIsMediaOnlyReplay) return items;
  const priorSeenMediaKeys = collectPriorSettledMediaKeys(items, targetIdx);
  const targetIsTextOnlyReplay =
    targetMediaKeys.size === 0 &&
    !!targetSignature &&
    priorSeenMediaKeys.size > 0 &&
    hasPriorAssistantTextSignature(items, targetIdx, targetSignature);
  if (targetIsTextOnlyReplay) {
    const next = [...items];
    next.splice(targetIdx, 1);
    return next;
  }

  for (let i = targetIdx - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.type === 'message' && item.data.role === 'user') break;
    if (item.type !== 'message' || item.data.role !== 'assistant') continue;

    const priorMediaKeys = settledMediaReplayKeys(item.data);
    if (priorMediaKeys.size === 0) continue;
    const hasSameMedia = hasAnyKeyAlreadySeen(targetMediaKeys, priorMediaKeys);
    const isSameTextReplay =
      !!targetSignature &&
      assistantReplayTextSignature(item.data) === targetSignature &&
      (targetMediaKeys.size === 0 || hasSameMedia);
    const isMediaOnlyReplay = targetIsMediaOnlyReplay && hasSameMedia;
    if (!isSameTextReplay && !isMediaOnlyReplay) continue;

    const next = [...items];
    next.splice(targetIdx, 1);
    return next;
  }

  if (targetMediaKeys.size > 0 && hasAnyKeyAlreadySeen(targetMediaKeys, priorSeenMediaKeys)) {
    const blocks = target.data.blocks || [];
    const filteredBlocks = blocks.filter((block) => {
      const keys = settledMediaReplayKeysForBlock(block);
      return keys.size === 0 || !hasAnyKeyAlreadySeen(keys, priorSeenMediaKeys);
    });
    if (filteredBlocks.length !== blocks.length) {
      const next = [...items];
      const filteredHasSettledMedia = filteredBlocks.some(isSettledMediaReplayBlock);
      const filteredIsDuplicateTextOnlyReplay =
        !filteredHasSettledMedia &&
        !!targetSignature &&
        hasPriorAssistantTextSignature(items, targetIdx, targetSignature);
      if (filteredBlocks.length === 0 || filteredIsDuplicateTextOnlyReplay) {
        next.splice(targetIdx, 1);
      } else {
        next[targetIdx] = {
          ...target,
          data: {
            ...target.data,
            blocks: filteredBlocks,
          },
        };
      }
      return next;
    }
  }

  return items;
}

function removeDuplicateAssistantMediaReplayItems(items: ChatListItem[]): ChatListItem[] {
  let current = items;
  for (let i = 0; i < current.length; i += 1) {
    const next = removeDuplicateAssistantMediaReplay(current, i);
    if (next !== current) {
      current = next;
      i -= 1;
    }
  }
  return current;
}

function isInterludeBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'interlude' }> {
  return block.type === 'interlude';
}

function isFailedMediaStatus(status: unknown): boolean {
  return status === 'failed' || status === 'aborted';
}

function isFailedMediaGenerationBlock(block: ContentBlock, taskId: string): boolean {
  return block.type === 'media_generation' &&
    block.taskId === taskId &&
    isFailedMediaStatus(block.status);
}

function isFailedMediaInterludeBlock(block: ContentBlock, taskId: string): boolean {
  return isInterludeBlock(block) &&
    block.taskId === taskId &&
    isFailedMediaStatus(block.status);
}

function hasFailedMediaGenerationItem(items: ChatListItem[], taskId: string): boolean {
  return items.some((item) => (
    item.type === 'message' &&
    item.data.role === 'assistant' &&
    (item.data.blocks || []).some((block) => isFailedMediaGenerationBlock(block, taskId))
  ));
}

function removeFailedMediaInterludeItems(items: ChatListItem[], taskId: string): { items: ChatListItem[]; changed: boolean } {
  let changed = false;
  const next = items.filter((item) => {
    if (item.type !== 'interlude') return true;
    const remove = isFailedMediaInterludeBlock(item.data, taskId);
    if (remove) changed = true;
    return !remove;
  });
  return { items: changed ? next : items, changed };
}

function firstMessageId(items: ChatListItem[]): string | undefined {
  return items.find((item) => item.type === 'message')?.data.id;
}

function hasEquivalentInterludeItem(items: ChatListItem[], block: ContentBlock): boolean {
  if (!isInterludeBlock(block)) return false;
  return items.some((item) => {
    if (item.type === 'interlude') {
      return isEquivalentInterlude(item.data, block);
    }
    if (item.type !== 'message' || item.data.role !== 'assistant') return false;
    return hasEquivalentInterludeBlock(item.data.blocks || [], block);
  });
}

function isEquivalentInterlude(existing: Extract<ContentBlock, { type: 'interlude' }>, block: Extract<ContentBlock, { type: 'interlude' }>): boolean {
  const identity = interludeIdentity(block);
  return !!identity && interludeIdentity(existing) === identity;
}

function hasEquivalentInterludeBlock(blocks: ContentBlock[], block: ContentBlock): boolean {
  if (!isInterludeBlock(block)) return false;
  const identity = interludeIdentity(block);
  if (!identity) return false;
  return blocks.some((existing) => (
    isInterludeBlock(existing) &&
    interludeIdentity(existing) === identity
  ));
}

function interludeIdentity(block: Extract<ContentBlock, { type: 'interlude' }>): string | null {
  if (block.deliveryId) return `delivery:${block.deliveryId}`;
  if (block.id) return `id:${block.id}`;
  return null;
}
