import type { ChatListItem, ChatMessage, ContentBlock, ToolCall } from '../../stores/chat-types';
import { isToolCallHiddenFromProcessUi } from '../../utils/tool-call-visibility';

export interface ProcessFoldStats {
  toolCount: number;
  thinkingCount: number;
  unsuccessfulCount: number;
  completedCount?: number;
  runningCount?: number;
  currentTool?: string | null;
  fileCount?: number;
  durationMs?: number;
}

export interface SourceTranscriptRenderItem {
  type: 'source';
  item: ChatListItem;
  originalIndex: number;
}

export interface ProcessFoldMessage {
  item: Extract<ChatListItem, { type: 'message' }>;
  originalIndex: number;
}

export interface ProcessFoldRenderItem {
  type: 'process_fold';
  id: string;
  items: ProcessFoldMessage[];
  originalIndex: number;
  stats: ProcessFoldStats;
  active: boolean;
}

export type TranscriptRenderItem = SourceTranscriptRenderItem | ProcessFoldRenderItem;
export type ProcessFoldTranslator = (key: string, vars?: Record<string, string | number>) => string;

const MIN_PROCESS_MESSAGES_TO_FOLD = 1;
const PROCESS_NARRATION_TEXT_LIMIT = 100;

function isAssistantMessage(item: ChatListItem): item is Extract<ChatListItem, { type: 'message' }> {
  return item.type === 'message' && item.data.role === 'assistant';
}

function isContentBlockCandidate(block: unknown): block is ContentBlock {
  return !!block && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string';
}

function isRenderableTextBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'text' }> {
  return block.type === 'text' && (typeof block.source === 'string' || typeof block.html === 'string');
}

function isRenderableToolGroupBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'tool_group' }> {
  return block.type === 'tool_group' && Array.isArray(block.tools);
}

function visibleBlocks(message: ChatMessage): ContentBlock[] {
  return (Array.isArray(message.blocks) ? message.blocks : [])
    .filter(isContentBlockCandidate)
    .filter((block) => block.type !== 'session_confirmation' || block.surface !== 'input');
}

function isProcessBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'thinking' | 'tool_group' }> {
  return block.type === 'thinking' || isRenderableToolGroupBlock(block);
}

function isProcessNarrationBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'thinking' | 'tool_group' | 'text' }> {
  return block.type === 'thinking' || isRenderableToolGroupBlock(block) || isRenderableTextBlock(block);
}

function visibleToolCalls(block: Extract<ContentBlock, { type: 'tool_group' }>): ToolCall[] {
  return (Array.isArray(block.tools) ? block.tools : [])
    .filter((tool) => !!tool && typeof tool === 'object' && typeof tool.name === 'string')
    .filter((tool) => !isToolCallHiddenFromProcessUi(tool));
}

export function isProcessOnlyAssistantMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false;
  const blocks = visibleBlocks(message);
  if (blocks.length === 0) return false;
  return blocks.every(isProcessBlock);
}

function textBlocks(message: ChatMessage): Extract<ContentBlock, { type: 'text' }>[] {
  return visibleBlocks(message).filter(isRenderableTextBlock);
}

function htmlToPlainText(html?: string | null): string {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function messageTextLength(message: ChatMessage): number {
  return textBlocks(message).reduce((sum, block) => {
    const text = block.source ?? htmlToPlainText(block.html);
    return sum + text.replace(/\s+/g, ' ').trim().length;
  }, 0);
}

function hasText(message: ChatMessage): boolean {
  return textBlocks(message).length > 0;
}

function isShortProcessNarrationMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false;
  const blocks = visibleBlocks(message);
  if (blocks.length === 0 || !hasText(message)) return false;
  if (!blocks.every(isProcessNarrationBlock)) return false;
  return messageTextLength(message) <= PROCESS_NARRATION_TEXT_LIMIT;
}

function protectedFinalTextIndexes(items: ChatListItem[]): Set<number> {
  const protectedIndexes = new Set<number>();
  let latestAssistantTextIndex = -1;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.type !== 'message') continue;

    if (item.data.role === 'user') {
      if (latestAssistantTextIndex >= 0) protectedIndexes.add(latestAssistantTextIndex);
      latestAssistantTextIndex = -1;
      continue;
    }

    if (item.data.role === 'assistant' && hasText(item.data)) {
      latestAssistantTextIndex = i;
    }
  }

  if (latestAssistantTextIndex >= 0) protectedIndexes.add(latestAssistantTextIndex);
  return protectedIndexes;
}

function isFoldableProcessAssistantMessage(message: ChatMessage, isProtectedFinalText: boolean): boolean {
  if (isProcessOnlyAssistantMessage(message)) return true;
  if (isProtectedFinalText) {
    const hasProcessActivity = visibleBlocks(message).some(isProcessBlock);
    return hasProcessActivity && isShortProcessNarrationMessage(message);
  }
  return isShortProcessNarrationMessage(message);
}

function collectStats(messages: ProcessFoldMessage[]): ProcessFoldStats {
  let toolCount = 0;
  let thinkingCount = 0;
  let unsuccessfulCount = 0;
  let completedCount = 0;
  let runningCount = 0;
  let currentTool: string | null = null;
  let durationMs = 0;
  const files = new Set<string>();

  for (const entry of messages) {
    for (const block of visibleBlocks(entry.item.data)) {
      if (block.type === 'thinking') {
        thinkingCount += 1;
        continue;
      }
      if (block.type !== 'tool_group') continue;
      const tools = visibleToolCalls(block);
      toolCount += tools.length;
      completedCount += tools.filter((tool) => tool.done).length;
      runningCount += tools.filter((tool) => !tool.done).length;
      const latestRunning = [...tools].reverse().find((tool) => !tool.done);
      const latestVisible = latestRunning || tools.at(-1);
      if (latestVisible?.name) currentTool = latestVisible.name;
      unsuccessfulCount += tools.filter((tool) => tool.done && !tool.success).length;
      for (const tool of tools) {
        if (typeof tool.durationMs === 'number') durationMs += tool.durationMs;
        const args = tool.args || {};
        for (const key of ['path', 'filePath', 'file_path', 'target', 'destination']) {
          const value = args[key];
          if (typeof value === 'string' && value.trim()) files.add(value);
        }
      }
    }
  }

  return {
    toolCount,
    thinkingCount,
    unsuccessfulCount,
    completedCount,
    runningCount,
    currentTool,
    fileCount: files.size,
    durationMs,
  };
}

function lastUserIndex(items: ChatListItem[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.type === 'message' && item.data.role === 'user') return i;
  }
  return -1;
}

function foldId(messages: ProcessFoldMessage[]): string {
  const first = messages[0]?.item.data.id || 'start';
  return `process-fold-${first}`;
}

function sourceItem(item: ChatListItem, originalIndex: number): SourceTranscriptRenderItem {
  return { type: 'source', item, originalIndex };
}

export function buildTranscriptRenderItems(
  items: ChatListItem[],
  options: { isStreaming: boolean },
): TranscriptRenderItem[] {
  const rendered: TranscriptRenderItem[] = [];
  const latestUserIndex = lastUserIndex(items);
  const protectedTextIndexes = protectedFinalTextIndexes(items);

  for (let i = 0; i < items.length;) {
    const item = items[i];
    if (!isAssistantMessage(item) || !isFoldableProcessAssistantMessage(item.data, protectedTextIndexes.has(i))) {
      rendered.push(sourceItem(item, i));
      i += 1;
      continue;
    }

    const segment: ProcessFoldMessage[] = [];
    let cursor = i;
    while (cursor < items.length) {
      const candidate = items[cursor];
      if (
        !isAssistantMessage(candidate)
        || !isFoldableProcessAssistantMessage(candidate.data, protectedTextIndexes.has(cursor))
      ) {
        break;
      }
      segment.push({ item: candidate, originalIndex: cursor });
      cursor += 1;
    }

    const isCurrentTrailingTurn = options.isStreaming && i > latestUserIndex;
    if (segment.length < MIN_PROCESS_MESSAGES_TO_FOLD) {
      for (const entry of segment) rendered.push(sourceItem(entry.item, entry.originalIndex));
      i = cursor;
      continue;
    }

    rendered.push({
      type: 'process_fold',
      id: foldId(segment),
      items: segment,
      originalIndex: i,
      stats: collectStats(segment),
      active: isCurrentTrailingTurn,
    });
    i = cursor;
  }

  return rendered;
}

function fallbackTranslate(key: string, vars?: Record<string, string | number>): string {
  const table: Record<string, string> = {
    'processFold.summary': '执行过程',
    'processFold.running': '正在执行 {name}',
    'processFold.completed': '已完成 {n} 项',
    'processFold.tools': '{n} 个工具',
    'processFold.thinking': '{n} 次思考',
    'processFold.files': '涉及 {n} 个文件',
    'processFold.duration': '耗时 {value}',
    'processFold.unsuccessful': '{n} 次尝试未成功',
    'processFold.action.write': '修改文件',
    'processFold.action.read': '检索项目',
    'processFold.action.command': '运行检查',
    'processFold.action.agent': '协调助手',
    'processFold.action.integration': '调用扩展',
    'processFold.action.tool': '调用 {name}',
  };
  return interpolate(table[key] || key, vars);
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name) => String(vars?.[name] ?? ''));
}

export function buildProcessFoldSummary(
  stats: ProcessFoldStats,
  agentName: string,
  translate: ProcessFoldTranslator = fallbackTranslate,
): string {
  const parts = [translate('processFold.summary', { name: agentName })];
  if ((stats.runningCount || 0) > 0 && stats.currentTool) {
    parts.push(translate('processFold.running', { name: friendlyToolName(stats.currentTool, translate) }));
  }
  if ((stats.completedCount || 0) > 0) {
    parts.push(translate('processFold.completed', { n: stats.completedCount || 0 }));
  } else if (stats.toolCount > 0) {
    parts.push(translate('processFold.tools', { n: stats.toolCount }));
  }
  if (stats.thinkingCount > 0) parts.push(translate('processFold.thinking', { n: stats.thinkingCount }));
  if ((stats.fileCount || 0) > 0) parts.push(translate('processFold.files', { n: stats.fileCount || 0 }));
  if ((stats.durationMs || 0) > 0) parts.push(translate('processFold.duration', { value: formatDuration(stats.durationMs || 0) }));
  if (stats.unsuccessfulCount > 0) parts.push(translate('processFold.unsuccessful', { n: stats.unsuccessfulCount }));
  return parts.join(' · ');
}

function friendlyToolName(name: string, translate: ProcessFoldTranslator): string {
  const normalized = name.toLowerCase().replace(/^mcp__/, '');
  const action = normalized.includes('write') || normalized.includes('edit') || normalized.includes('patch')
    ? 'write'
    : normalized.includes('read') || normalized.includes('grep') || normalized.includes('find') || normalized.includes('search')
      ? 'read'
      : normalized.includes('exec') || normalized.includes('bash') || normalized.includes('terminal')
        ? 'command'
        : normalized.includes('subagent') || normalized.includes('agent')
          ? 'agent'
          : normalized.includes('mcp') || name.startsWith('mcp__')
            ? 'integration'
            : 'tool';
  return translate(`processFold.action.${action}`, { name });
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`;
}
