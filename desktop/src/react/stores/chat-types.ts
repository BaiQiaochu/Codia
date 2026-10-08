import type { ComposerReferences, AgentReviewState } from '../../../../shared/quick-actions';
/**
 * chat-types.ts — 聊天消息数据模型
 *
 * 历史消息和流式消息共用同一套类型。
 * ContentBlock 按展示顺序排列（thinking → mood → tools → text），
 * 不按流式到达顺序。
 */


// ── 工具调用 ──

export interface ToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  done: boolean;
  success: boolean;
  details?: { card?: import('../types').PluginCardDetails; [key: string]: unknown };
}

// ── 用户附件 ──

export interface UserAttachment {
  fileId?: string;
  path: string;
  name: string;
  isDir: boolean;
  base64Data?: string;
  mimeType?: string;
  presentation?: 'attachment' | 'voice-input' | string;
  listed?: boolean;
  status?: 'available' | 'expired' | string;
  missingAt?: number | null;
  visionAuxiliary?: boolean;
  transcription?: VoiceTranscription;
  waveform?: AudioWaveform;
}

export interface AudioWaveform {
  version: 1;
  peaks: number[];
  durationMs?: number;
  source?: 'computed' | 'fallback';
}

export interface VoiceTranscription {
  status: 'pending' | 'ready' | 'failed';
  text?: string;
  providerId?: string;
  modelId?: string;
  protocolId?: string;
  language?: string;
  durationMs?: number;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface DeskContext {
  dir: string;
  fileCount: number;
}

export interface SessionRegistryFile {
  id?: string;
  fileId?: string;
  sessionPath?: string;
  filePath?: string;
  realPath?: string;
  label?: string;
  displayName?: string;
  filename?: string;
  ext?: string;
  mime?: string;
  kind?: string;
  status?: 'available' | 'expired' | string;
  missingAt?: number | null;
  origin?: string;
  operations?: string[];
  createdAt?: number;
  mtimeMs?: number;
  size?: number | null;
  isDirectory?: boolean;
  presentation?: 'attachment' | 'voice-input' | string;
  listed?: boolean;
  resource?: ResourceEnvelope;
  transcription?: VoiceTranscription;
  waveform?: AudioWaveform;
}

export interface ResourceEnvelope {
  schemaVersion: 1;
  resourceId: string;
  name: string;
  studioId: string;
  type: 'file' | string;
  source: 'session_file' | string;
  sourceId?: string;
  fileId?: string;
  displayName?: string;
  filename?: string;
  ext?: string | null;
  mime?: string;
  size?: number | null;
  kind?: string;
  isDirectory?: boolean;
  origin?: string;
  operations?: string[];
  createdAt?: number | string;
  mtimeMs?: number;
  lifecycle: {
    status: 'available' | 'expired' | string;
    missingAt: number | string | null;
  };
  storage: {
    provider: 'session_file' | string;
    storageKind?: string;
    localOnly?: boolean;
  };
  links: {
    self: string;
    content?: string;
  };
}

// ── 内容块 ──

// 物种 A：文本装饰器（流式组装，upsert 到 blocks 数组）
export interface SessionConfirmationBlock {
  type: 'session_confirmation';
  confirmId: string;
  kind: string;
  surface: 'input' | 'message';
  status: 'pending' | 'confirmed' | 'rejected' | 'timeout' | 'aborted';
  title: string;
  body?: string;
  subject?: {
    label: string;
    detail?: string;
  };
  severity?: 'normal' | 'elevated' | 'danger';
  actions?: {
    confirmLabel?: string;
    rejectLabel?: string;
  };
  payload?: Record<string, unknown>;
}

export interface SettingsUpdatePayload {
  status: 'applied' | 'failed' | string;
  action?: string;
  key: string;
  title?: string;
  summary?: string;
  changes?: Array<{
    key: string;
    label?: string;
    before?: string | number | boolean | null;
    after?: string | number | boolean | null;
  }>;
}

export interface SuggestionCardBlock {
  type: 'suggestion_card';
  kind: 'automation_draft' | string;
  confirmId?: string;
  operation?: 'create' | 'update' | string;
  status: 'pending' | 'approved' | 'rejected' | string;
  title: string;
  description?: string;
  target?: {
    type?: string;
    id?: string | null;
    label?: string | null;
  };
  detail?: {
    kind?: string;
    operation?: 'create' | 'update' | string;
    jobData?: Record<string, unknown>;
    [key: string]: unknown;
  };
  actions?: Array<{
    id?: string;
    kind?: string;
    label?: string;
  }>;
}

export type TextDecorator =
  | { type: 'text'; html: string; source?: string; _raw?: string }
  | { type: 'thinking'; content: string; sealed: boolean }
  | { type: 'mood'; yuan: string; text: string }
  | { type: 'invoke'; name: string; content: string }
  | { type: 'tool_group'; tools: ToolCall[]; collapsed: boolean }

// Rich content blocks pushed by server-side tool extraction.
export type RichBlock =
  | { type: 'file'; fileId?: string; resourceId?: string; resource?: ResourceEnvelope; filePath: string; label: string; ext: string; mime?: string; kind?: string; storageKind?: string; presentation?: 'attachment' | 'voice-input' | string; listed?: boolean; status?: 'available' | 'expired' | string; missingAt?: number | null; mtimeMs?: number; size?: number | null; waveform?: AudioWaveform; replacesTaskId?: string }
  | { type: 'interactive_card'; cardId: string; title: string; code: string }
  | { type: 'media_generation'; taskId: string; kind: 'image' | 'video' | string; status: 'pending' | 'failed' | 'aborted' | string; prompt?: string; batchId?: string; reason?: string }
  | { type: 'workflow'; taskId: string; taskTitle: string; streamStatus: 'running' | 'done' | 'failed' | 'aborted' | 'closed' | string; summary?: string | null; startedAt?: number | null; finishedAt?: number | null }
  | { type: 'artifact'; artifactId: string; artifactType: string; title: string; content: string; language?: string | null; fileId?: string; filePath?: string; label?: string; ext?: string; mime?: string; kind?: string; storageKind?: string; presentation?: 'attachment' | 'voice-input' | string; listed?: boolean; status?: 'available' | 'expired' | string; missingAt?: number | null; mtimeMs?: number; size?: number | null }
  | { type: 'screenshot'; base64: string; mimeType: string }
  | { type: 'skill'; skillName: string; skillFilePath: string; fileId?: string; installedFile?: Record<string, unknown>; installedSkillSource?: Record<string, unknown> }
  | { type: 'cron_confirm'; confirmId?: string; jobData: Record<string, unknown>; status: 'pending' | 'approved' | 'rejected' }
  | SuggestionCardBlock
  | { type: 'settings_update'; update: SettingsUpdatePayload }
  | { type: 'settings_confirm'; confirmId?: string; settingKey: string; cardType: 'toggle' | 'list' | 'text'; currentValue: string; proposedValue: string; options?: string[]; optionLabels?: Record<string, string>; label: string; description?: string; frontend?: boolean; status: 'pending' | 'confirmed' | 'rejected' | 'timeout' }
  | {
    type: 'interlude';
    id?: string;
    deliveryId?: string;
    variant: 'deferred_result' | string;
    timelinePlacement?: 'after_anchor_message' | string;
    taskId?: string;
    status?: 'success' | 'failed' | 'aborted' | string;
    sourceKind?: 'subagent' | 'workflow' | 'tool' | string;
    sourceLabel?: string;
    previewAgentId?: string | null;
    previewSessionPath?: string | null;
    text: string;
    detailMarkdown?: string;
  }
  | SessionConfirmationBlock
  | {
    type: 'subagent';
    taskId: string;
    task: string;
    taskTitle: string;
    agentId?: string | null;
    agentName?: string | null;
    requestedAgentId?: string | null;
    requestedAgentName?: string | null;
    executorAgentId?: string | null;
    executorAgentNameSnapshot?: string | null;
    streamKey: string;
    streamStatus: 'running' | 'done' | 'failed' | 'aborted' | 'closed';
    summary?: string | null;
    threadId?: string | null;
    threadKind?: string | null;
    label?: string | null;
    access?: string | null;
    childSessionPath?: string | null;
    reuseInstance?: string | null;
  }
  | { type: 'plugin_card'; card: import('../types').PluginCardDetails };

export type ContentBlock = TextDecorator | RichBlock;

// ── 消息 ──

export interface ChatMessage {
  quickAction?: ComposerReferences['quickAction'];
  agentMentions?: ComposerReferences['agentMentions'];
  sessionRefs?: ComposerReferences['sessionRefs'];
  agentReview?: AgentReviewState;
  reviewSourceSessionId?: string;
  id: string;              // 服务端返回的稳定 ID（JSONL 行号）
  role: 'user' | 'assistant';
  sourceEntryId?: string;
  // User
  text?: string;
  textHtml?: string;
  quotedText?: string;
  attachments?: UserAttachment[];
  deskContext?: DeskContext | null;
  skills?: string[];
  workspaceTool?: {
    id: string;
    title: string;
    description?: string;
  };
  // Assistant
  blocks?: ContentBlock[];
  turnTraceId?: string;
  // 通用
  timestamp?: number;
}

// ── Virtuoso 列表项 ──

export type ChatListItem =
  | { type: 'message'; data: ChatMessage }
  | { type: 'interlude'; id: string; data: Extract<ContentBlock, { type: 'interlude' }> }
  | { type: 'compaction'; id: string; yuan: string };

// ── Per-session 模型快照 ──
// 挂在 chat-slice 的 sessionModelsByPath keyed map 上，
// 与消息缓存 SessionMessages 解耦：模型信息可以在消息还没加载时独立写入，
// 不会因为在 chatSessions 里创建 stub 而骗过"是否已加载"的判据（issue #405）。

export interface SessionModel {
  id: string;
  name: string;
  provider: string;
  input?: ('text' | 'image' | 'video' | 'audio')[];
  vision?: boolean;
  video?: boolean;
  videoTransport?: string | null;
  videoTransportSupported?: boolean;
  audio?: boolean;
  audioTransport?: string | null;
  audioTransportSupported?: boolean;
  compat?: ({
    gsapVideoInput?: boolean;
  } & Record<string, unknown>) | null;
  reasoning?: boolean;
  xhigh?: boolean;
  thinkingLevels?: ('off' | 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')[];
  defaultThinkingLevel?: 'off' | 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  contextWindow?: number;
}

// ── Per-session 消息状态 ──
// entry 存在 ⟺ 消息状态已初始化（initSession 调用过）。
// 不要为了存别的东西（例如模型快照）就写 stub 进来——会把这个语义打破。

export interface SessionMessages {
  items: ChatListItem[];
  hasMore: boolean;
  loadingMore: boolean;
  oldestId?: string;
  revision?: string | null;
}

// ── 流式缓冲（不入 Zustand） ──

export interface StreamBuffer {
  sessionPath: string;
  textAcc: string;
  thinkingAcc: string;
  moodAcc: string;
  moodYuan: string;
  inThinking: boolean;
  inMood: boolean;
  lastFlushTime: number;
}
