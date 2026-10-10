/**
 * StreamBufferManager — per-session 流式事件节流缓冲
 *
 * WS 事件到达时写入 buffer（纯 JS 对象，不触发 React），
 * 每 FLUSH_INTERVAL ms 批量 flush 到 Zustand store。
 *
 * 设计为 singleton，不依赖 React 组件生命周期。
 * app-ws-shim 直接调用 streamBufferManager.handle(msg)。
 */

import type { ChatMessage, ContentBlock, SessionRegistryFile } from '../stores/chat-types';
import type {
  RuntimeTimelineEvent,
  RuntimeTimelineEventType,
  RuntimeTimelineMediaKind,
} from '../stores/runtime-timeline-slice';
import { useStore } from '../stores';
import { sessionScopedKey, sessionScopedValue } from '../stores/session-slice';
import { renderMarkdown } from '../utils/markdown';
import { cleanMoodText, parseBashInvokesFromContent } from '../utils/message-parser';
import { splitAssistantMeta } from '../utils/assistant-meta-parser';
import { normalizeYuanKey } from '../utils/yuan';
import { findOpenToolIndex, toolCallFromStartEvent, toolCallIdFromEvent } from '../utils/tool-call-identity';
import {
  registerStreamBufferInvalidator,
  registerStreamBufferSnapshot,
  type StreamBufferSnapshot,
} from '../stores/stream-invalidator';
import { bumpMessageLiveVersion } from '../stores/message-live-version';

/* eslint-disable @typescript-eslint/no-explicit-any -- 流式消息 handle(msg) 接收动态 JSON */

const STREAM_FLUSH_FPS = 30;
const FLUSH_INTERVAL = Math.round(1000 / STREAM_FLUSH_FPS);

export function streamFlushIntervalForLength(length: number): number {
  if (length <= 8_000) return FLUSH_INTERVAL;
  if (length <= 32_000) return 75;
  if (length <= 128_000) return 150;
  if (length <= 512_000) return 300;
  return 500;
}

function buildTextInvokeBlocks(text: string): ContentBlock[] {
  return parseBashInvokesFromContent(text).segments.map((segment) => (
    segment.type === 'text'
      ? { type: 'text', html: renderMarkdown(segment.text), source: segment.text }
      : { type: 'invoke', name: segment.name, content: segment.content }
  ));
}

interface Buffer {
  sessionPath: string;
  sessionId: string | null;
  streamId: string | null;
  textAcc: string;
  thinkingAcc: string;
  moodAcc: string;
  moodYuan: string;
  inThinking: boolean;
  inMood: boolean;
  inCard: boolean;
  cardAttrs: { type: string; plugin: string; route: string; title?: string } | null;
  cardDescAcc: string;
  lastFlushTime: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** 当前 turn 绑定的 assistant message id */
  messageId: string | null;
  turnTraceId: string | null;
  generationStarted: boolean;
  activeToolEventIds: Record<string, string[]>;
  activeMediaEventIds: Record<string, string[]>;
  messageSegment: number;
  splitBeforeNextContent: boolean;
}

let generatedTraceCounter = 0;
let generatedEventCounter = 0;
let generatedMessageCounter = 0;

function createBuffer(sessionPath: string, sessionId: string | null = null): Buffer {
  return {
    sessionPath,
    sessionId,
    streamId: null,
    textAcc: '',
    thinkingAcc: '',
    moodAcc: '',
    moodYuan: 'codia',
    inThinking: false,
    inMood: false,
    inCard: false,
    cardAttrs: null,
    cardDescAcc: '',
    lastFlushTime: 0,
    flushTimer: null,
    messageId: null,
    turnTraceId: null,
    generationStarted: false,
    activeToolEventIds: {},
    activeMediaEventIds: {},
    messageSegment: 0,
    splitBeforeNextContent: false,
  };
}

function normalizeSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bufferKeyForSession(sessionPath: string, sessionId: string | null = null): string {
  const explicitSessionId = normalizeSessionId(sessionId);
  if (explicitSessionId) return explicitSessionId;
  const state = useStore.getState();
  return sessionScopedKey(state, sessionPath) || sessionPath;
}

function resolveSessionYuan(sessionPath: string): string {
  const state = useStore.getState();
  const sessionAgentId = state.sessions.find((session: any) => session.path === sessionPath)?.agentId ?? null;
  if (!sessionAgentId) return normalizeYuanKey(state.agentYuan || 'codia');
  const agentYuan = state.agents.find((agent: any) => agent.id === sessionAgentId)?.yuan;
  return normalizeYuanKey(agentYuan || state.agentYuan || 'codia');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function basenameFromPath(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop() || value;
}

function firstDeferredMediaFile(result: unknown): Record<string, any> | string | null {
  if (Array.isArray(result)) {
    return result.find((item) => isObjectRecord(item) || typeof item === 'string') || null;
  }
  if (!isObjectRecord(result)) return null;
  if (Array.isArray(result.sessionFiles) && result.sessionFiles.length > 0) {
    return result.sessionFiles.find((item) => isObjectRecord(item) || typeof item === 'string') || null;
  }
  if (Array.isArray(result.files) && result.files.length > 0) {
    return result.files.find((item) => isObjectRecord(item) || typeof item === 'string') || null;
  }
  return firstDeferredMediaFile(result.result);
}

function deferredResultSessionFiles(result: unknown): SessionRegistryFile[] {
  const files: SessionRegistryFile[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isObjectRecord(value)) return;
    if (Array.isArray(value.sessionFiles)) {
      visit(value.sessionFiles);
      return;
    }
    if (isObjectRecord(value.result)) {
      visit(value.result);
      return;
    }
    const filePath = asString(value.filePath ?? value.realPath ?? value.path);
    const fileId = asString(value.fileId ?? value.id);
    if (!filePath && !fileId) return;
    const label = asString(value.label ?? value.displayName ?? value.filename)
      || (filePath ? basenameFromPath(filePath) : fileId || 'file');
    files.push({
      ...value,
      ...(fileId ? { fileId, id: asString(value.id) || fileId } : {}),
      ...(filePath ? { filePath, realPath: asString(value.realPath) || filePath } : {}),
      label,
      displayName: asString(value.displayName) || label,
      filename: asString(value.filename) || label,
    } as SessionRegistryFile);
  };
  visit(result);
  return files;
}

function upsertDeferredResultSessionFiles(sessionPath: string, msg: any): void {
  const files = deferredResultSessionFiles(msg?.result);
  if (files.length === 0) return;
  const store = useStore.getState();
  for (const file of files) {
    store.upsertSessionRegistryFile?.(sessionPath, file);
  }
}

function contentBlockFromDeferredResult(msg: any): ContentBlock | null {
  const taskId = asString(msg?.taskId);
  if (!taskId) return null;
  const kind = asString(msg?.meta?.mediaKind) || asString(msg?.kind) || (
    asString(msg?.meta?.type)?.startsWith('video') ? 'video' : 'image'
  );

  if (msg?.status === 'success' || msg?.status === 'resolved') {
    const file = firstDeferredMediaFile(msg?.result);
    const filePath = typeof file === 'string'
      ? asString(file)
      : asString(file?.filePath ?? file?.realPath);
    if (!file || !filePath) {
      return {
        type: 'media_generation',
        taskId,
        kind,
        status: 'failed',
        reason: '生成结果没有可显示文件',
      };
    }
    const label = typeof file === 'string'
      ? basenameFromPath(filePath)
      : (asString(file.label ?? file.displayName ?? file.filename) || basenameFromPath(filePath));
    const ext = typeof file === 'string'
      ? (basenameFromPath(label).split('.').pop() || '')
      : (asString(file.ext) || basenameFromPath(label).split('.').pop() || '');
    return {
      type: 'file',
      replacesTaskId: taskId,
      ...(typeof file !== 'string' && asString(file.fileId ?? file.id) ? { fileId: asString(file.fileId ?? file.id) } : {}),
      filePath,
      label,
      ext,
      ...(typeof file !== 'string' && asString(file.mime) ? { mime: asString(file.mime) } : {}),
      ...(typeof file !== 'string' && asString(file.kind) ? { kind: asString(file.kind) } : {}),
      ...(typeof file !== 'string' && asString(file.storageKind) ? { storageKind: asString(file.storageKind) } : {}),
      ...(typeof file !== 'string' && asString(file.status) ? { status: asString(file.status) } : {}),
      ...(typeof file !== 'string' && file.missingAt !== undefined ? { missingAt: file.missingAt } : {}),
      ...(typeof file !== 'string' && isObjectRecord(file.resource) ? { resource: file.resource as any } : {}),
    };
  }

  if (msg?.status === 'failed' || msg?.status === 'aborted') {
    return {
      type: 'media_generation',
      taskId,
      kind,
      status: msg.status,
      reason: asString(msg?.reason) || (msg.status === 'aborted' ? 'task was stopped' : 'generation failed'),
    };
  }

  return null;
}

function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

function timelineLabel(type: RuntimeTimelineEventType, msg?: any): string {
  switch (type) {
    case 'queued':
      return '排队';
    case 'model_route': {
      const provider = asString(msg?.provider ?? msg?.model?.provider);
      const model = asString(msg?.model?.id ?? msg?.modelId ?? msg?.model);
      return [provider, model].filter(Boolean).join(' / ') || '路由模型';
    }
    case 'thinking':
      return '思考';
    case 'generating':
      return '生成中';
    case 'tool_call':
      return asString(msg?.name) || asString(msg?.tool?.name) || '调用工具';
    case 'media_generation':
      return asString(msg?.kind) || asString(msg?.media?.kind) || '媒体生成';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    default:
      return '运行事件';
  }
}

function mediaKind(value: unknown): RuntimeTimelineMediaKind | undefined {
  const kind = String(value);
  return kind === 'image' || kind === 'audio' || kind === 'music' || kind === 'video' ? kind : undefined;
}

function runtimeErrorCategory(value: unknown): 'model' | 'tool' | 'media' | 'plugin' | 'pwa' | 'network' | 'runtime' {
  const category = String(value || '');
  if (
    category === 'tool' ||
    category === 'media' ||
    category === 'plugin' ||
    category === 'pwa' ||
    category === 'network' ||
    category === 'runtime'
  ) return category;
  return 'model';
}

class StreamBufferManager {
  private buffers = new Map<string, Buffer>();
  private bufferKeysByPath = new Map<string, string>();

  private adoptBufferKey(fromKey: string, toKey: string, buf: Buffer): void {
    if (fromKey === toKey) return;
    this.buffers.delete(fromKey);
    this.buffers.set(toKey, buf);
    for (const [pathKey, bufferKey] of this.bufferKeysByPath) {
      if (bufferKey === fromKey) this.bufferKeysByPath.set(pathKey, toKey);
    }
  }

  private deleteBufferKey(key: string): void {
    this.buffers.delete(key);
    for (const [pathKey, bufferKey] of [...this.bufferKeysByPath]) {
      if (bufferKey === key) this.bufferKeysByPath.delete(pathKey);
    }
  }

  private lookupBuffer(sessionPath: string, sessionId: string | null = null): Buffer | null {
    const key = bufferKeyForSession(sessionPath, sessionId);
    let buf = this.buffers.get(key) || null;
    if (buf) return buf;

    const aliasKey = this.bufferKeysByPath.get(sessionPath) || null;
    if (aliasKey) {
      buf = this.buffers.get(aliasKey) || null;
      if (buf) {
        this.adoptBufferKey(aliasKey, key, buf);
        this.bufferKeysByPath.set(sessionPath, key);
        return buf;
      }
    }

    if (key !== sessionPath) {
      buf = this.buffers.get(sessionPath) || null;
      if (buf) {
        this.adoptBufferKey(sessionPath, key, buf);
        this.bufferKeysByPath.set(sessionPath, key);
        return buf;
      }
    }

    return null;
  }

  /** 获取或创建 session buffer */
  private getBuffer(sessionPath: string, sessionId: string | null = null): Buffer {
    const key = bufferKeyForSession(sessionPath, sessionId);
    let buf = this.lookupBuffer(sessionPath, sessionId);
    if (!buf) {
      buf = createBuffer(sessionPath, normalizeSessionId(sessionId));
      this.buffers.set(key, buf);
    }
    buf.sessionPath = sessionPath;
    buf.sessionId = normalizeSessionId(sessionId) || buf.sessionId;
    this.bufferKeysByPath.set(sessionPath, key);
    return buf;
  }

  private hasTurnState(buf: Buffer): boolean {
    return !!(
      buf.messageId ||
      buf.textAcc ||
      buf.thinkingAcc ||
      buf.moodAcc ||
      buf.inThinking ||
      buf.inMood ||
      buf.inCard ||
      buf.cardAttrs ||
      buf.cardDescAcc
    );
  }

  private resetTurnState(buf: Buffer): void {
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }
    buf.textAcc = '';
    buf.thinkingAcc = '';
    buf.moodAcc = '';
    buf.inThinking = false;
    buf.inMood = false;
    buf.inCard = false;
    buf.cardAttrs = null;
    buf.cardDescAcc = '';
    buf.messageId = null;
    buf.turnTraceId = null;
    buf.generationStarted = false;
    buf.activeToolEventIds = {};
    buf.activeMediaEventIds = {};
    buf.messageSegment = 0;
    buf.splitBeforeNextContent = false;
  }

  private beginNextMessageSegment(buf: Buffer): void {
    this.flush(buf);
    buf.textAcc = '';
    buf.thinkingAcc = '';
    buf.moodAcc = '';
    buf.inThinking = false;
    buf.inMood = false;
    buf.inCard = false;
    buf.cardAttrs = null;
    buf.cardDescAcc = '';
    buf.messageId = null;
    buf.splitBeforeNextContent = false;
  }

  private hasUserMessageAfterTarget(buf: Buffer): boolean {
    if (!buf.messageId) return false;
    const store = useStore.getState();
    const session = sessionScopedValue(store, store.chatSessions, buf.sessionPath);
    if (!session) return false;
    const targetIdx = session.items.findIndex((item) =>
      item.type === 'message' &&
      item.data.id === buf.messageId &&
      item.data.role === 'assistant',
    );
    if (targetIdx < 0) return false;
    return session.items.slice(targetIdx + 1).some((item) =>
      item.type === 'message' && item.data.role === 'user',
    );
  }

  private detachFromOlderAssistantAfterUser(buf: Buffer): void {
    if (!this.hasUserMessageAfterTarget(buf)) return;
    this.resetTurnState(buf);
  }

  private bindStream(buf: Buffer, msg: any): boolean {
    const incoming = asString(msg?.streamId);
    if (!incoming) return true;
    if (!buf.streamId) {
      buf.streamId = incoming;
      return true;
    }
    if (buf.streamId === incoming) return true;

    if (msg.type === 'turn_end' || msg.type === 'error') {
      return false;
    }

    if (this.hasTurnState(buf)) {
      this.flush(buf);
    }
    this.resetTurnState(buf);
    buf.streamId = incoming;
    return true;
  }

  private bindTurnTrace(buf: Buffer, msg: any): void {
    const incoming = asString(msg?.turnTraceId) || asString(msg?.traceId);
    if (!incoming) return;
    if (!buf.turnTraceId) {
      buf.turnTraceId = incoming;
      return;
    }
    if (buf.turnTraceId === incoming) return;
    if (msg.type === 'turn_end' || msg.type === 'error') return;

    if (this.hasTurnState(buf)) {
      this.flush(buf);
    }
    this.resetTurnState(buf);
    buf.turnTraceId = incoming;
  }

  private resolveTurnTraceId(buf: Buffer, msg?: any): string {
    const incoming = asString(msg?.turnTraceId) || asString(msg?.traceId);
    if (incoming) buf.turnTraceId = incoming;
    if (!buf.turnTraceId) {
      generatedTraceCounter += 1;
      buf.turnTraceId = `turn-${Date.now()}-${generatedTraceCounter}`;
    }
    return buf.turnTraceId;
  }

  private bindCurrentMessageTrace(buf: Buffer): void {
    if (!buf.turnTraceId || !buf.messageId) return;
    const store = useStore.getState();
    store.bindRuntimeTimelineMessage(buf.turnTraceId, buf.messageId);
    store.updateMessageById(buf.sessionPath, buf.messageId, (msg) => (
      msg.turnTraceId === buf.turnTraceId ? msg : { ...msg, turnTraceId: buf.turnTraceId || undefined }
    ));
  }

  private recordTimelineEvent(
    buf: Buffer,
    msg: any,
    type: RuntimeTimelineEventType,
    status: RuntimeTimelineEvent['status'],
    eventId?: string,
  ): string {
    const turnTraceId = this.resolveTurnTraceId(buf, msg);
    const id = eventId || `${turnTraceId}:${type}`;
    const provider = asString(msg?.provider ?? msg?.model?.provider);
    const modelId = asString(msg?.model?.id ?? msg?.modelId ?? msg?.model);
    const event: RuntimeTimelineEvent = {
      id,
      turnTraceId,
      sessionPath: buf.sessionPath,
      type,
      label: timelineLabel(type, msg),
      status,
      startedAt: asString(msg?.startedAt) || nowIso(),
      endedAt: status === 'success' || status === 'error' ? (asString(msg?.endedAt) || nowIso()) : undefined,
      durationMs: typeof msg?.durationMs === 'number' ? msg.durationMs : undefined,
      model: type === 'model_route' ? { provider, id: modelId, name: asString(msg?.modelName) || modelId } : undefined,
      tool: type === 'tool_call' ? { name: asString(msg?.name) || asString(msg?.tool?.name), category: asString(msg?.category) } : undefined,
      media: type === 'media_generation'
        ? {
          kind: mediaKind(msg?.kind ?? msg?.media?.kind),
          provider: asString(msg?.provider),
          model: asString(msg?.model),
        }
        : undefined,
      details: type === 'failed'
        ? { message: asString(msg?.message) || asString(msg?.error) || 'Runtime error' }
        : undefined,
      diagnosticId: asString(msg?.diagnosticId),
    };
    useStore.getState().upsertRuntimeTimelineEvent(event);
    this.bindCurrentMessageTrace(buf);
    return id;
  }

  /** 确保 store 中已为该 session 追加了一条空 assistant message */
  private ensureMessage(buf: Buffer): void {
    const store = useStore.getState();
    const session = sessionScopedValue(store, store.chatSessions, buf.sessionPath);
    if (!session) return; // session 未初始化（可能还没 loadMessages）

    const targetId = buf.messageId;
    const existing = targetId
      ? session.items.find((item) =>
        item.type === 'message' &&
        item.data.id === targetId &&
        item.data.role === 'assistant',
      )
      : null;
    if (existing) {
      buf.messageId = targetId;
      this.bindCurrentMessageTrace(buf);
      return;
    }

    if (!targetId) {
      generatedMessageCounter += 1;
      buf.messageSegment += 1;
    }
    const streamSegmentSuffix = buf.messageSegment > 1 ? `-${buf.messageSegment}` : '';
    const id = targetId || (buf.streamId
      ? `stream-${buf.streamId}${streamSegmentSuffix}`
      : `stream-${Date.now()}-${generatedMessageCounter}`);
    const msg: ChatMessage = { id, role: 'assistant', blocks: [], turnTraceId: buf.turnTraceId || undefined };
    store.appendItem(buf.sessionPath, { type: 'message', data: msg });
    bumpMessageLiveVersion(buf.sessionPath);
    buf.messageId = id;
    this.bindCurrentMessageTrace(buf);
  }

  private updateTargetMessage(buf: Buffer, updater: (msg: ChatMessage) => ChatMessage): void {
    this.ensureMessage(buf);
    if (!buf.messageId) return;
    const updated = useStore.getState().updateMessageById(buf.sessionPath, buf.messageId, updater);
    if (!updated) {
      console.warn('[stream] target assistant message missing after ensureMessage:', buf.sessionPath, buf.messageId);
      return;
    }
    bumpMessageLiveVersion(buf.sessionPath);
  }

  /** 调度节流 flush */
  private scheduleFlush(buf: Buffer): void {
    const now = Date.now();
    const bufferedLength = buf.textAcc.length + buf.thinkingAcc.length + buf.moodAcc.length;
    const flushInterval = streamFlushIntervalForLength(bufferedLength);
    if (now - buf.lastFlushTime >= flushInterval) {
      this.flush(buf);
    } else if (!buf.flushTimer) {
      buf.flushTimer = setTimeout(() => {
        buf.flushTimer = null;
        this.flush(buf);
      }, flushInterval - (now - buf.lastFlushTime));
    }
  }

  /** 把 buffer 中累积的内容一次性 flush 到 Zustand */
  private flush(buf: Buffer): void {
    buf.lastFlushTime = Date.now();
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }

    this.updateTargetMessage(buf, (msg) => {
      const blocks: ContentBlock[] = [...(msg.blocks || [])];
      const visibleMeta = splitAssistantMeta(
        buf.textAcc.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, ''),
      );
      const thinkingContent = [buf.thinkingAcc, visibleMeta.thinking].filter(Boolean).join('\n');

      // ── Thinking ──
      if (thinkingContent || buf.inThinking) {
        const idx = blocks.findIndex(b => b.type === 'thinking');
        const thinkingBlock: ContentBlock = {
          type: 'thinking',
          content: thinkingContent,
          sealed: !buf.inThinking,
        };
        if (idx >= 0) blocks[idx] = thinkingBlock;
        else blocks.unshift(thinkingBlock); // thinking 在最前面
      }

      // ── Mood ──
      const moodContent = [buf.inMood ? buf.moodAcc : cleanMoodText(buf.moodAcc), visibleMeta.mood]
        .filter(Boolean)
        .join('\n');
      const moodYuan = visibleMeta.moodYuan || buf.moodYuan;

      if (moodContent || buf.inMood) {
        const idx = blocks.findIndex(b => b.type === 'mood');
        const moodBlock: ContentBlock = {
          type: 'mood',
          yuan: moodYuan,
          text: moodContent,
        };
        if (idx >= 0) blocks[idx] = moodBlock;
        else {
          // mood 在 thinking 后面
          const insertAt = blocks.findIndex(b => b.type !== 'thinking');
          blocks.splice(insertAt >= 0 ? insertAt : blocks.length, 0, moodBlock);
        }
      }

      // ── Text ──
      if (buf.textAcc) {
        const displayText = visibleMeta.text;
        const idx = blocks.findIndex(b => b.type === 'text' || b.type === 'invoke');
        const textBlocks = displayText ? buildTextInvokeBlocks(displayText) : [];
        if (idx >= 0) {
          const nextBlocks: ContentBlock[] = blocks.filter(b => b.type !== 'text' && b.type !== 'invoke');
          nextBlocks.splice(Math.min(idx, nextBlocks.length), 0, ...textBlocks);
          blocks.splice(0, blocks.length, ...nextBlocks);
        } else if (textBlocks.length > 0) {
          blocks.splice(blocks.length, 0, ...(textBlocks as ContentBlock[]));
        }
      }

      return { ...msg, blocks };
    });
  }

  // ── 公开事件处理器 ──

  handle(msg: any): void {
    const sessionPath = msg.sessionPath;
    if (!sessionPath) {
      console.warn('[ws] stream event missing sessionPath:', msg.type);
      return;
    }
    const buf = this.getBuffer(sessionPath, normalizeSessionId(msg.sessionId));
    if (!this.bindStream(buf, msg)) return;
    this.bindTurnTrace(buf, msg);

    switch (msg.type) {
      case 'turn_queued':
        this.detachFromOlderAssistantAfterUser(buf);
        this.recordTimelineEvent(buf, msg, 'queued', 'success');
        break;

      case 'model_route':
        this.detachFromOlderAssistantAfterUser(buf);
        this.recordTimelineEvent(buf, msg, 'model_route', 'success');
        break;

      case 'generation_start':
        this.detachFromOlderAssistantAfterUser(buf);
        buf.generationStarted = true;
        this.recordTimelineEvent(buf, msg, 'generating', 'running');
        this.ensureMessage(buf);
        break;

      case 'text_delta':
        this.detachFromOlderAssistantAfterUser(buf);
        if (buf.splitBeforeNextContent) this.beginNextMessageSegment(buf);
        this.resolveTurnTraceId(buf, msg);
        if (!buf.generationStarted) {
          buf.generationStarted = true;
          this.recordTimelineEvent(buf, msg, 'generating', 'running');
        }
        this.ensureMessage(buf);
        buf.textAcc += msg.delta || '';
        this.scheduleFlush(buf);
        break;

      case 'thinking_start':
        this.detachFromOlderAssistantAfterUser(buf);
        if (buf.splitBeforeNextContent) this.beginNextMessageSegment(buf);
        this.recordTimelineEvent(buf, msg, 'thinking', 'running');
        this.ensureMessage(buf);
        buf.inThinking = true;
        buf.thinkingAcc = '';
        this.flush(buf);
        break;

      case 'thinking_delta':
        this.ensureMessage(buf);
        buf.thinkingAcc += msg.delta || '';
        this.scheduleFlush(buf);
        break;

      case 'thinking_end':
        this.recordTimelineEvent(buf, msg, 'thinking', 'success');
        buf.inThinking = false;
        this.flush(buf);
        buf.splitBeforeNextContent = true;
        break;

      case 'mood_start':
        this.detachFromOlderAssistantAfterUser(buf);
        if (buf.splitBeforeNextContent) this.beginNextMessageSegment(buf);
        this.ensureMessage(buf);
        buf.inMood = true;
        buf.moodAcc = '';
        buf.moodYuan = resolveSessionYuan(sessionPath);
        this.flush(buf);
        break;

      case 'mood_text':
        buf.moodAcc += msg.delta || '';
        this.scheduleFlush(buf);
        break;

      case 'mood_end':
        buf.inMood = false;
        this.flush(buf);
        break;

      case 'card_start':
        if (buf.splitBeforeNextContent) this.beginNextMessageSegment(buf);
        this.ensureMessage(buf);
        buf.inCard = true;
        buf.cardAttrs = msg.attrs || null;
        buf.cardDescAcc = '';
        break;

      case 'card_text':
        buf.cardDescAcc += msg.delta || '';
        break;

      case 'card_end': {
        buf.inCard = false;
        if (buf.cardAttrs) {
          this.flush(buf); // flush pending text first
          const card = {
            type: buf.cardAttrs.type || 'iframe',
            pluginId: buf.cardAttrs.plugin || '',
            route: buf.cardAttrs.route || '',
            title: buf.cardAttrs.title,
            description: buf.cardDescAcc,
          };
          this.updateTargetMessage(buf, (m) => ({
            ...m,
            blocks: [...(m.blocks || []), { type: 'plugin_card' as const, card }],
          }));
        }
        buf.cardAttrs = null;
        buf.cardDescAcc = '';
        break;
      }

      case 'tool_start':
        this.detachFromOlderAssistantAfterUser(buf);
        generatedEventCounter += 1;
        {
          const toolEventKey = toolCallIdFromEvent(msg) || msg.name;
          (buf.activeToolEventIds[toolEventKey] ||= []).push(
            this.recordTimelineEvent(
              buf,
              msg,
              'tool_call',
              'running',
              toolCallIdFromEvent(msg) || `${this.resolveTurnTraceId(buf, msg)}:tool:${generatedEventCounter}`,
            ),
          );
        }
        this.ensureMessage(buf);
        // 工具事件频率低，直接写 store
        this.flush(buf); // 先 flush 文本
        this.updateTargetMessage(buf, (m) => {
          const blocks = [...(m.blocks || [])];
          // 找最后一个 tool_group 或创建新的
          let lastTg = blocks.length - 1;
          while (lastTg >= 0 && blocks[lastTg].type !== 'tool_group') lastTg--;
          if (lastTg >= 0 && blocks[lastTg].type === 'tool_group') {
            const tg = blocks[lastTg] as Extract<ContentBlock, { type: 'tool_group' }>;
            blocks[lastTg] = {
              ...tg,
              tools: [...tg.tools, toolCallFromStartEvent(msg)],
              collapsed: false,
            };
            return { ...m, blocks };
          }
          // 新建 tool_group
          blocks.push({
            type: 'tool_group',
            tools: [toolCallFromStartEvent(msg)],
            collapsed: false,
          });
          return { ...m, blocks };
        });
        break;

      case 'tool_end':
        {
          const toolEventKey = toolCallIdFromEvent(msg) || msg.name;
          const queue = buf.activeToolEventIds[toolEventKey] || [];
          const eventId = queue.shift() || `${this.resolveTurnTraceId(buf, msg)}:tool:${msg.name || 'unknown'}`;
          this.recordTimelineEvent(buf, msg, 'tool_call', msg.success === false ? 'error' : 'success', eventId);
        }
        this.updateTargetMessage(buf, (m) => {
          const blocks = [...(m.blocks || [])];
          // 从后往前找含该 tool 名且未 done 的
          for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i].type !== 'tool_group') continue;
            const tg = blocks[i] as Extract<ContentBlock, { type: 'tool_group' }>;
            const toolIdx = findOpenToolIndex(tg.tools, msg);
            if (toolIdx >= 0) {
              const tools = [...tg.tools];
              tools[toolIdx] = {
                ...tools[toolIdx],
                done: true,
                success: !!msg.success,
                durationMs: typeof msg.durationMs === 'number' ? msg.durationMs : undefined,
                details: msg.details,
              };
              const allDone = tools.every(t => t.done);
              blocks[i] = { ...tg, tools, collapsed: allDone && tools.length > 1 };
              return { ...m, blocks };
            }
          }
          return m;
        });
        if (!Object.values(buf.activeToolEventIds).some(queue => queue.length > 0)) {
          buf.splitBeforeNextContent = true;
        }
        break;

      case 'media_generation_start':
        this.detachFromOlderAssistantAfterUser(buf);
        generatedEventCounter += 1;
        (buf.activeMediaEventIds[msg.kind || 'media'] ||= []).push(
          this.recordTimelineEvent(
            buf,
            msg,
            'media_generation',
            'running',
            `${this.resolveTurnTraceId(buf, msg)}:media:${generatedEventCounter}`,
          ),
        );
        this.ensureMessage(buf);
        break;

      case 'media_generation_end': {
        const key = msg.kind || 'media';
        const queue = buf.activeMediaEventIds[key] || [];
        const eventId = queue.shift() || `${this.resolveTurnTraceId(buf, msg)}:media:${key}`;
        this.recordTimelineEvent(buf, msg, 'media_generation', msg.success === false ? 'error' : 'success', eventId);
        upsertDeferredResultSessionFiles(buf.sessionPath, msg);
        const block = contentBlockFromDeferredResult({
          ...msg,
          status: msg.success === false
            ? (msg.status || 'failed')
            : (msg.status || (msg.taskId || msg.result ? 'success' : undefined)),
        });
        if (block) {
          const taskId = replacementTaskId(block);
          if (taskId) {
            if (this.hasTurnState(buf)) this.flush(buf);
            const consumed = useStore.getState().resolveBlockByTaskId(buf.sessionPath, taskId, block);
            if (consumed) bumpMessageLiveVersion(buf.sessionPath);
          }
        }
        break;
      }

      case 'deferred_result': {
        upsertDeferredResultSessionFiles(buf.sessionPath, msg);
        const block = contentBlockFromDeferredResult(msg);
        if (!block) break;
        const taskId = replacementTaskId(block);
        if (taskId) {
          if (this.hasTurnState(buf)) this.flush(buf);
          const consumed = useStore.getState().resolveBlockByTaskId(buf.sessionPath, taskId, block);
          if (consumed) {
            bumpMessageLiveVersion(buf.sessionPath);
            break;
          }
        }
        break;
      }

      case 'content_block': {
        let block = msg.block as ContentBlock;
        if (!block || typeof block !== 'object') break;
        if (isPendingMediaGenerationBlock(block) && sessionHasSettledMediaTask(buf.sessionPath, block.taskId)) {
          break;
        }
        // Apply cached patches (block_update 可能先于 content_block 到达)
        const incomingTaskId = 'taskId' in block && typeof block.taskId === 'string' ? block.taskId : null;
        if (incomingTaskId) {
          const pending = (useStore.getState() as any)._pendingBlockPatches;
          const cached = pending?.[incomingTaskId];
          if (cached) {
            block = { ...block, ...cached };
            delete pending[incomingTaskId];
          }
        }

        if (isInterludeBlock(block)) {
          if (this.hasTurnState(buf)) this.flush(buf);
          const consumed = useStore.getState().appendInterludeItem(buf.sessionPath, block);
          if (consumed) {
            bumpMessageLiveVersion(buf.sessionPath);
            break;
          }
        }

        const taskId = replacementTaskId(block);
        if (taskId) {
          if (this.hasTurnState(buf)) this.flush(buf);
          const consumed = useStore.getState().resolveBlockByTaskId(buf.sessionPath, taskId, block);
          if (consumed) {
            bumpMessageLiveVersion(buf.sessionPath);
            break;
          }
        }

        if (buf.splitBeforeNextContent) this.beginNextMessageSegment(buf);
        this.ensureMessage(buf);
        this.flush(buf);
        this.updateTargetMessage(buf, (m) => ({
          ...m,
          blocks: mergeContentBlock([...(m.blocks || [])], block),
        }));
        break;
      }

      case 'compaction_start':
        break;

      case 'compaction_end':
        break;

      case 'turn_end':
        if (buf.generationStarted) this.recordTimelineEvent(buf, msg, 'generating', 'success');
        this.recordTimelineEvent(buf, msg, 'completed', 'success');
        this.flush(buf);
        // 清理 buffer
        this.resetTurnState(buf);
        buf.streamId = null;
        break;

      case 'error':
        this.ensureMessage(buf);
        {
          const turnTraceId = this.resolveTurnTraceId(buf, msg);
          const category = runtimeErrorCategory(msg.category);
          const userMessage = category === 'tool'
            ? '工具调用失败，已保留诊断信息。'
            : category === 'media'
              ? '媒体生成失败，已保留诊断信息。'
              : '模型调用失败，已保留诊断信息。';
          const diagnosticId = useStore.getState().recordRuntimeDiagnostic({
            traceId: turnTraceId,
            sessionPath,
            severity: 'error',
            category,
            userMessage,
            technicalMessage: asString(msg.message) || asString(msg.error) || '运行时错误',
            suggestion: asString(msg.suggestion) || '请检查供应商、工具权限或网络状态后重试。',
            durationMs: typeof msg.durationMs === 'number' ? msg.durationMs : undefined,
            model: {
              provider: asString(msg.provider ?? msg.model?.provider),
              id: asString(msg.model?.id ?? msg.modelId ?? msg.model),
              name: asString(msg.modelName),
            },
            tool: msg.tool || msg.name ? {
              name: asString(msg.tool?.name ?? msg.name),
              category: asString(msg.tool?.category),
            } : undefined,
            sanitizedDetails: msg.error || msg.details || { message: msg.message },
          });
          useStore.getState().recordRuntimeRecord({
            timestamp: nowIso(),
            severity: 'error',
            category,
            title: userMessage,
            detail: asString(msg.message) || asString(msg.error) || 'Runtime error',
            traceId: turnTraceId,
            diagnosticId,
            sessionPath,
          });
          useStore.getState().addToast(userMessage, 'error', 0, {
            diagnosticId,
            persistent: true,
            dedupeKey: `runtime-error:${turnTraceId}`,
          });
          this.recordTimelineEvent(buf, { ...msg, turnTraceId, diagnosticId }, 'failed', 'error');
        }
        this.resetTurnState(buf);
        buf.streamId = null;
        break;

    }
  }

  beginTurn(sessionPath: string, sessionId: string | null = null): void {
    this.beginUserTurn(sessionPath, sessionId);
  }

  beginUserTurn(sessionPath: string, sessionId: string | null = null): void {
    if (!sessionPath) return;
    const buf = this.lookupBuffer(sessionPath, sessionId);
    if (!buf) return;
    buf.sessionPath = sessionPath;
    if (
      buf.textAcc ||
      buf.thinkingAcc ||
      buf.moodAcc ||
      buf.inThinking ||
      buf.inMood ||
      buf.inCard ||
      buf.cardAttrs ||
      buf.cardDescAcc
    ) {
      this.flush(buf);
    }
    this.resetTurnState(buf);
    buf.streamId = null;
  }

  finishTurn(sessionPath: string, sessionId: string | null = null): void {
    if (!sessionPath) return;
    const buf = this.lookupBuffer(sessionPath, sessionId);
    if (!buf) return;
    buf.sessionPath = sessionPath;
    if (this.hasTurnState(buf)) {
      this.flush(buf);
    }
    this.resetTurnState(buf);
    buf.streamId = null;
  }

  getActiveMessageId(sessionPath: string, sessionId: string | null = null): string | null {
    if (!sessionPath) return null;
    return this.lookupBuffer(sessionPath, sessionId)?.messageId || null;
  }

  /** 清理指定 session 的 buffer */
  clear(sessionPath: string, sessionId: string | null = null): void {
    const key = bufferKeyForSession(sessionPath, sessionId);
    const aliasKey = this.bufferKeysByPath.get(sessionPath) || null;
    const buf = this.lookupBuffer(sessionPath, sessionId);
    if (buf?.flushTimer) clearTimeout(buf.flushTimer);
    this.deleteBufferKey(key);
    if (aliasKey && aliasKey !== key) this.deleteBufferKey(aliasKey);
    if (key !== sessionPath) this.deleteBufferKey(sessionPath);
  }

  /** 清理所有 */
  clearAll(): void {
    for (const [, buf] of this.buffers) {
      if (buf.flushTimer) clearTimeout(buf.flushTimer);
    }
    this.buffers.clear();
    this.bufferKeysByPath.clear();
  }

  snapshot(sessionPath: string, sessionId: string | null = null): StreamBufferSnapshot | null {
    const buf = this.lookupBuffer(sessionPath, sessionId);
    if (!buf) return null;
    const hasContent = !!(buf.textAcc || buf.thinkingAcc || buf.moodAcc);
    if (!hasContent) return null;
    return {
      hasContent: true,
      messageId: buf.messageId,
      text: buf.textAcc,
      thinking: buf.thinkingAcc,
      mood: buf.inMood ? buf.moodAcc : cleanMoodText(buf.moodAcc),
      moodYuan: buf.moodYuan,
      inThinking: buf.inThinking,
      inMood: buf.inMood,
    };
  }
}

/** 全局 singleton */
export const streamBufferManager = new StreamBufferManager();

function mergeContentBlock(blocks: ContentBlock[], block: ContentBlock): ContentBlock[] {
  if (isInterludeBlock(block)) return blocks;
  if (block.type === 'media_generation' && block.status === 'pending') {
    const resolved = blocks.some((existing) => isResolvedTaskBlock(existing, block.taskId));
    if (resolved) return blocks;
  }
  const taskId = replacementTaskId(block);
  if (!taskId) return [...blocks, block];
  const idx = blocks.findIndex((existing) => (
    existing.type === 'media_generation' &&
    existing.taskId === taskId
  ));
  if (idx < 0) return [...blocks, block];
  const next = [...blocks];
  next[idx] = block;
  return next;
}

function isPendingMediaGenerationBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'media_generation' }> {
  return block.type === 'media_generation' && block.status === 'pending';
}

function replacementTaskId(block: ContentBlock): string | null {
  if (block.type === 'file') return block.replacesTaskId || null;
  if (block.type === 'media_generation' && block.status !== 'pending') return block.taskId;
  return null;
}

function isResolvedTaskBlock(block: ContentBlock, taskId: string): boolean {
  if (block.type === 'file') return block.replacesTaskId === taskId;
  return block.type === 'media_generation' &&
    block.taskId === taskId &&
    block.status !== 'pending';
}

function sessionHasSettledMediaTask(sessionPath: string, taskId: string): boolean {
  const store = useStore.getState();
  const session = sessionScopedValue(store, store.chatSessions, sessionPath);
  return !!session?.items?.some((item) => (
    item.type === 'message' &&
    item.data.role === 'assistant' &&
    (item.data.blocks || []).some((block) => isResolvedTaskBlock(block, taskId))
  ));
}

function isInterludeBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'interlude' }> {
  return block.type === 'interlude';
}

registerStreamBufferInvalidator((sessionPath) => {
  if (sessionPath == null) streamBufferManager.clearAll();
  else streamBufferManager.clear(sessionPath);
});
registerStreamBufferSnapshot((sessionPath) => streamBufferManager.snapshot(sessionPath));
