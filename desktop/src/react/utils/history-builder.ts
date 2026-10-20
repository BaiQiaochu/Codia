/**
 * history-builder.ts — 将 /api/sessions/messages 的 API 响应转换为 ChatListItem[]
 *
 * 替代 app-messages-shim.ts loadMessages() 中的 DOM 构建循环。
 */

import type { ChatMessage, ChatListItem, ContentBlock } from '../stores/chat-types';
import type { TodoItem } from '../types';
import { parseMoodFromContent, parseCardFromContent, parseUserAttachments, parseBashInvokesFromContent } from './message-parser';
import { renderMarkdown } from './markdown';
import { parseSkillInvocationNote } from './skill-invocation-note';
import { splitAssistantMeta } from './assistant-meta-parser';
import { extOfName } from './file-kind';

/* eslint-disable @typescript-eslint/no-explicit-any -- API 历史消息 JSON 结构动态，难以静态收窄 */

const DEFERRED_RESULT_PREFIXES = ['codia', ['h', 'ana'].join('')];
const deferredResultPattern = new RegExp(`<(?:${DEFERRED_RESULT_PREFIXES.join('|')})-background-result\\s`);
const deferredTasksPattern = new RegExp(`<(?:${DEFERRED_RESULT_PREFIXES.join('|')})-deferred-tasks>`);
type InterludeContentBlock = Extract<ContentBlock, { type: 'interlude' }>;

// ── API 响应类型 ──

export interface HistoryApiResponse {
  messages: Array<{
    id?: string;
    entryId?: string;
    runId?: string;
    role: string;
    content: string;
    thinking?: string;
    toolCalls?: Array<{ name: string; args?: Record<string, unknown> }>;
    images?: Array<{ data: string; mimeType: string }>;
    timestamp?: number | string | null;
    sourceIndex?: number;
    skills?: string[];
    plugins?: ChatMessage['plugins'];
    attachments?: ChatMessage['attachments'];
    quickAction?: ChatMessage['quickAction'];
    agentMentions?: ChatMessage['agentMentions'];
    sessionRefs?: ChatMessage['sessionRefs'];
    agentReview?: ChatMessage['agentReview'];
    reviewSourceSessionId?: string;
  }>;
  blocks?: Array<any>;
  // COMPAT(v0.98): 以下三个老字段在新服务端不再返回，v0.98 后可删
  fileOutputs?: Array<{
    afterIndex: number;
    files: Array<{ filePath: string; label: string; ext: string }>;
  }>;
  artifacts?: Array<{
    afterIndex: number;
    artifactId: string;
    artifactType: string;
    title: string;
    content: string;
    language?: string;
  }>;
  cards?: Array<{
    afterIndex: number;
    card: { type: string; pluginId: string; route: string; title?: string; description?: string };
  }>;
  todos?: TodoItem[];
  hasMore?: boolean;
}

// ── 兼容层 ──

/**
 * COMPAT(v0.98): 兼容层，v0.98 后可整个删除。
 *
 * 将老格式（fileOutputs/artifacts/cards）转为新 blocks[] 格式。
 * 新服务端返回 blocks[]，此函数只在升级过渡期（老服务端 → 新前端）命中。
 * 如果没有 data.blocks，还需从 toolCalls 重建 cron/settings 确认卡片，
 * 因为老 session 的 toolResult.details 没有 jobData/settingKey 字段。
 */
function normalizeBlocks(data: HistoryApiResponse): Array<any> {
  if (data.blocks) {
    return data.blocks
      .map(normalizeHistoryBlock)
      .filter((block): block is Record<string, any> => !!block);
  }
  const blocks: Array<any> = [];
  for (const fo of (data.fileOutputs || [])) {
    for (const f of fo.files) {
      blocks.push({ type: 'file', afterIndex: fo.afterIndex, filePath: f.filePath, label: f.label, ext: f.ext });
    }
  }
  for (const ar of (data.artifacts || [])) {
    blocks.push({ type: 'artifact', afterIndex: ar.afterIndex, artifactId: ar.artifactId, artifactType: ar.artifactType, title: ar.title, content: ar.content, language: ar.language });
  }
  for (const cd of (data.cards || [])) {
    blocks.push({ type: 'plugin_card', afterIndex: cd.afterIndex, card: { ...cd.card, type: cd.card.type || 'iframe' } });
  }

  // COMPAT: 从 toolCalls 重建 cron/settings 确认卡片（仅老 session 无 blocks[] 时）
  for (let i = 0; i < (data.messages || []).length; i++) {
    const m = data.messages[i];
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      if (tc.name === 'update_settings' && tc.args) {
        const a = tc.args as Record<string, string>;
        if (a.action === 'apply' || (!a.action && a.key && a.value)) {
          blocks.push({
            type: 'settings_confirm',
            afterIndex: i,
            confirmId: '',
            settingKey: a.key || '',
            cardType: (a.key === 'sandbox' || a.key === 'memory.enabled') ? 'toggle' : 'list',
            currentValue: '',
            proposedValue: a.value || '',
            label: a.key || '',
            status: 'confirmed',
          });
        }
      }
      if (tc.name === 'cron' && tc.args) {
        const a = tc.args as Record<string, any>;
        if (a.action === 'add') {
          blocks.push({
            type: 'cron_confirm',
            afterIndex: i,
            confirmId: '',
            jobData: { type: a.type, schedule: a.schedule, prompt: a.prompt, label: a.label },
            status: 'approved',
          });
        }
      }
    }
  }

  return blocks;
}

// ── 构建 ──

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() ? value : null;
}

function normalizeBlockAfterIndex(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
}

function basenamePortable(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function normalizeHistoryBlock(raw: unknown): Record<string, any> | null {
  if (!isRecord(raw)) return null;
  const type = nonEmptyString(raw.type);
  const afterIndex = normalizeBlockAfterIndex(raw.afterIndex);
  if (!type || afterIndex === null) return null;

  if (type === 'file') {
    const filePath = nonEmptyString(raw.filePath);
    if (!filePath) return null;
    const label = nonEmptyString(raw.label) || basenamePortable(filePath);
    const ext = nonEmptyString(raw.ext) || extOfName(label) || extOfName(filePath) || '';
    return { ...raw, type, afterIndex, filePath, label, ext };
  }

  if (type === 'plugin_card') {
    if (!isRecord(raw.card)) return null;
    const pluginId = nonEmptyString(raw.card.pluginId);
    const route = nonEmptyString(raw.card.route);
    if (!pluginId || !route) return null;
    return { ...raw, type, afterIndex, card: { ...raw.card, pluginId, route } };
  }

  if (type === 'cron_confirm') {
    if (!isRecord(raw.jobData)) return null;
    return {
      ...raw,
      type,
      afterIndex,
      jobData: raw.jobData,
      status: nonEmptyString(raw.status) || 'approved',
    };
  }

  if (type === 'suggestion_card') {
    const kind = nonEmptyString(raw.kind);
    const title = nonEmptyString(raw.title);
    if (!kind || !title) return null;
    return {
      ...raw,
      type,
      afterIndex,
      kind,
      title,
      status: nonEmptyString(raw.status) || 'pending',
    };
  }

  if (type === 'screenshot') {
    if (!nonEmptyString(raw.base64) || !nonEmptyString(raw.mimeType)) return null;
  } else if (type === 'settings_update') {
    if (!isRecord(raw.update)) return null;
  } else if (type === 'skill') {
    if (!nonEmptyString(raw.skillName)) return null;
  }

  return { ...raw, type, afterIndex };
}

function isInterludeHistoryBlock(block: Record<string, any>): block is InterludeContentBlock & { afterIndex: number; sourceIndex?: number } {
  return block.type === 'interlude';
}

function interludeContentBlock(block: Record<string, any>, fallbackId: string): InterludeContentBlock {
  const { afterIndex: _afterIndex, ...content } = block;
  return {
    ...content,
    type: 'interlude',
    id: nonEmptyString(content.id) || fallbackId,
    variant: nonEmptyString(content.variant) || 'deferred_result',
    text: nonEmptyString(content.text) || '',
  } as InterludeContentBlock;
}

function isMediaInterludeAnchor(block: Record<string, any>, taskId: string): boolean {
  return (
    (block.type === 'media_generation' && block.taskId === taskId) ||
    (block.type === 'file' && block.replacesTaskId === taskId)
  );
}

function settledMediaTaskIdFromHistoryBlock(block: Record<string, any>): string | null {
  if (block.type === 'file') return nonEmptyString(block.replacesTaskId);
  if (block.type === 'media_generation' && block.status !== 'pending') {
    return nonEmptyString(block.taskId);
  }
  return null;
}

function assistantMediaReplaySignature(message: HistoryApiResponse['messages'][number]): string {
  const normalizedContent = String(message.content || '').replace(/\s+/g, ' ').trim();
  const normalizedThinking = String(message.thinking || '').replace(/\s+/g, ' ').trim();
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  return JSON.stringify([normalizedContent, normalizedThinking, toolCalls]);
}

function isFailedMediaStatus(status: unknown): boolean {
  return status === 'failed' || status === 'aborted';
}

function isFailedMediaGenerationBlock(block: Record<string, any>, taskId: string): boolean {
  return block.type === 'media_generation' &&
    block.taskId === taskId &&
    isFailedMediaStatus(block.status);
}

function isFailedMediaInterludeDuplicate(interlude: Record<string, any>, inlineBlocks: Record<string, any>[]): boolean {
  const taskId = nonEmptyString(interlude.taskId);
  if (!taskId || !isFailedMediaStatus(interlude.status)) return false;
  return inlineBlocks.some((block) => isFailedMediaGenerationBlock(block, taskId));
}

function shouldPlaceInterludeBeforeMessage(interlude: Record<string, any>, inlineBlocks: Record<string, any>[]): boolean {
  if (interlude.timelinePlacement === 'after_anchor_message') return false;
  const taskId = nonEmptyString(interlude.taskId);
  if (!taskId) return false;
  return inlineBlocks.some((block) => isMediaInterludeAnchor(block, taskId));
}

function normalizeSourceIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function sourceOrderedItems(
  items: ChatListItem[],
  data: HistoryApiResponse,
  allBlocks: Array<any>,
): ChatListItem[] {
  if (!items.length) return items;
  const orderById = new Map<string, number>();
  for (let i = 0; i < data.messages.length; i += 1) {
    const sourceIndex = normalizeSourceIndex(data.messages[i].sourceIndex);
    if (sourceIndex === null) continue;
    orderById.set(data.messages[i].id || `hist-${i}`, sourceIndex);
  }
  for (const block of allBlocks) {
    if (!isInterludeHistoryBlock(block)) continue;
    const sourceIndex = normalizeSourceIndex(block.sourceIndex);
    const id = nonEmptyString(block.id);
    if (sourceIndex === null || !id) continue;
    orderById.set(id, sourceIndex);
  }
  if (orderById.size === 0) return items;

  const entries = items.map((item, index) => {
    const id = item.type === 'message' ? item.data.id : item.id;
    return { item, index, sourceIndex: orderById.get(id) ?? null };
  });
  if (entries.some((entry) => entry.sourceIndex === null)) return items;

  return entries
    .sort((a, b) => (
      (a.sourceIndex as number) - (b.sourceIndex as number) ||
      a.index - b.index
    ))
    .map((entry) => entry.item);
}

export function buildItemsFromHistory(data: HistoryApiResponse): ChatListItem[] {
  const items: ChatListItem[] = [];
  const seenSettledMediaTaskSignatures = new Map<string, string>();

  // 按 afterIndex 分组统一 blocks
  const allBlocks = normalizeBlocks(data);
  const blockMap: Record<number, Array<any>> = {};
  for (const b of allBlocks) {
    (blockMap[b.afterIndex] ??= []).push(b);
  }

  for (let i = 0; i < data.messages.length; i++) {
    const m = data.messages[i];
    const id = m.id || `hist-${i}`;
    const timestamp = normalizeTimestamp(m.timestamp);

    if (m.role === 'user') {
      // strip steer 前缀（内部标记，不应展示给用户）
      const rawContent = (m.content || '').replace(/^（插话，无需 MOOD）\n?/, '');

      // 过滤系统注入的后台任务通知（steer 消息），不展示给用户
      if (
        deferredResultPattern.test(rawContent)
        || deferredTasksPattern.test(rawContent)
      ) {
        continue;
      }

      const parsed = parseUserAttachments(rawContent);
      const { files, attachedImages, attachedVideos, deskContext, quotedText } = parsed;
      const { text, skills: envelopeSkills } = parseSkillInvocationNote(parsed.text);
      const skills = m.skills?.length ? m.skills : envelopeSkills;
      const fileAtts = files.map(f => ({
        path: f.path,
        name: f.name,
        isDir: f.isDirectory,
      }));
      const imageBlocks = m.images || [];
      const markerImageAtts = attachedImages.map((ref, idx) => {
        const img = imageBlocks[idx];
        return {
          path: ref.path,
          name: ref.name,
          isDir: false,
          base64Data: img?.data,
          mimeType: img?.mimeType,
          visionAuxiliary: !img,
        };
      });
      const imageAtts = imageBlocks.slice(attachedImages.length).map((img, idx) => ({
        path: `image-${idx}`,
        name: `image-${idx}.${(img.mimeType || 'image/png').split('/')[1] || 'png'}`,
        isDir: false,
        base64Data: img.data,
        mimeType: img.mimeType,
      }));
      const markerVideoAtts = attachedVideos.map(ref => ({
        path: ref.path,
        name: ref.name,
        isDir: false,
      }));
      const allAtts = [...fileAtts, ...markerImageAtts, ...markerVideoAtts, ...imageAtts];
      const msg: ChatMessage = {
        id,
        sourceEntryId: m.entryId,
        role: 'user',
        text,
        textHtml: text ? renderMarkdown(text) : undefined,
        attachments: m.attachments || (allAtts.length ? allAtts : undefined),
        quickAction: m.quickAction,
        agentMentions: m.agentMentions,
        sessionRefs: m.sessionRefs,
        agentReview: m.agentReview,
        reviewSourceSessionId: m.reviewSourceSessionId,
        deskContext: deskContext || undefined,
        quotedText: quotedText || undefined,
        skills: m.skills?.length ? m.skills : (skills.length ? skills : undefined),
        plugins: m.plugins,
        timestamp,
      };
      items.push({ type: 'message', data: msg });
    } else if (m.role === 'assistant') {
      const blocks: ContentBlock[] = [];
      const {
        text: assistantContent,
        thinking: inlineThinking,
        mood: plainMood,
        moodYuan: plainMoodYuan,
      } = splitAssistantMeta(m.content);
      const thinking = [m.thinking, inlineThinking].filter(Boolean).join('\n');

      // 1. Thinking
      if (thinking) {
        blocks.push({ type: 'thinking', content: thinking, sealed: true });
      }

      // 2. Mood + main text
      const { mood, yuan, text: afterMood } = parseMoodFromContent(assistantContent);
      if (mood && yuan) {
        blocks.push({ type: 'mood', yuan, text: mood });
      }
      if (plainMood && plainMoodYuan) {
        blocks.push({ type: 'mood', yuan: plainMoodYuan, text: plainMood });
      }

      // 3. Tool calls
      if (m.toolCalls?.length) {
        blocks.push({
          type: 'tool_group',
          tools: m.toolCalls.map(tc => ({
            name: tc.name,
            args: tc.args,
            done: true,
            success: true,
          })),
          collapsed: m.toolCalls.length > 1,
        });
      }

      // 4. Main text after mood/card extraction
      const { cards, text: mainText } = parseCardFromContent(afterMood);
      for (const segment of parseBashInvokesFromContent(mainText).segments) {
        if (segment.type === 'text') {
          blocks.push({ type: 'text', html: renderMarkdown(segment.text) });
        } else {
          blocks.push({ type: 'invoke', name: segment.name, content: segment.content });
        }
      }

      // 5. Cards (before file outputs)
      for (const card of cards) {
        blocks.push({ type: 'plugin_card', card });
      }

      // 6. Content Blocks from unified sideband
      const msgBlocks = blockMap[i] || [];
      const assistantSignature = assistantMediaReplaySignature(m);
      const duplicateMediaTaskIds = new Set<string>();
      const inlineBlocks = msgBlocks
        .filter((block) => !isInterludeHistoryBlock(block))
        .filter((block) => {
          const taskId = settledMediaTaskIdFromHistoryBlock(block);
          if (!taskId || !seenSettledMediaTaskSignatures.has(taskId)) return true;
          duplicateMediaTaskIds.add(taskId);
          return false;
        });
      const isDuplicateMediaReplayMessage = duplicateMediaTaskIds.size > 0
        && [...duplicateMediaTaskIds].some((taskId) => seenSettledMediaTaskSignatures.get(taskId) === assistantSignature);
      if (isDuplicateMediaReplayMessage) continue;

      const interludeBlocks = msgBlocks
        .filter(isInterludeHistoryBlock)
        .filter((block) => {
          const taskId = nonEmptyString(block.taskId);
          return !taskId || !seenSettledMediaTaskSignatures.has(taskId);
        })
        .filter((block) => !isFailedMediaInterludeDuplicate(block, inlineBlocks));
      const beforeInterludes = interludeBlocks.filter((block) => shouldPlaceInterludeBeforeMessage(block, inlineBlocks));
      const afterInterludes = interludeBlocks.filter((block) => !shouldPlaceInterludeBeforeMessage(block, inlineBlocks));
      for (const b of inlineBlocks) blocks.push(b);

      for (let j = 0; j < beforeInterludes.length; j += 1) {
        const data = interludeContentBlock(beforeInterludes[j], `interlude:${i}:before:${j}`);
        items.push({
          type: 'interlude',
          id: data.id || `interlude:${i}:before:${j}`,
          data,
        });
      }

      const msg: ChatMessage = { id, sourceEntryId: m.entryId, role: 'assistant', blocks, timestamp, runId: m.runId };
      if (blocks.length > 0) {
        items.push({ type: 'message', data: msg });
      }
      for (const block of inlineBlocks) {
        const taskId = settledMediaTaskIdFromHistoryBlock(block);
        if (taskId) seenSettledMediaTaskSignatures.set(taskId, assistantSignature);
      }
      for (let j = 0; j < afterInterludes.length; j += 1) {
        const data = interludeContentBlock(afterInterludes[j], `interlude:${i}:after:${j}`);
        items.push({
          type: 'interlude',
          id: data.id || `interlude:${i}:after:${j}`,
          data,
        });
      }
    }
  }

  return sourceOrderedItems(items, data, allBlocks);
}

function normalizeTimestamp(value: number | string | null | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}
