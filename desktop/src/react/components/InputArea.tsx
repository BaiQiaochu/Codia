import { QUICK_ACTIONS, type ComposerReferences } from '../../../../shared/quick-actions';
import { requestWorkflowTemplate } from '../utils/workflow-template-request';
import { switchTab } from './channels/tab-router';
/**
  *
 *
  * */

import { useState, useEffect, useRef, useCallback, useMemo, type ChangeEvent, type Ref } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useStore } from '../stores';
import { EMPTY_ARRAY, selectIsStreamingSession, toArray, toStringArray } from '../stores/session-selectors';
import { sessionScopedListIncludes, sessionScopedValue } from '../stores/session-slice';
import { selectArtifacts, selectActiveTabId } from '../stores/preview-slice';
import { selectSessionFiles } from '../stores/selectors/file-refs';
import { isImageFile, isVideoFile } from '../utils/format';
import { collectUiContext } from '../utils/ui-context';
import { prepareImageAttachmentForVision } from '../utils/image-attachments';
import { fetchConfig } from '../hooks/use-config';
import { useI18n } from '../hooks/use-i18n';
import { continueDeletedAgentSession, ensureSession, loadSessions } from '../stores/session-actions';
import { loadDeskFiles, searchDeskFiles, toggleJianSidebar } from '../stores/desk-actions';
import { getWebSocket } from '../services/websocket';
import { getModelThinkingLevels, type ThinkingLevel } from '../stores/model-slice';
import { AttachedFilesBar } from './input/AttachedFilesBar';
import { PlanModeButton, type PermissionMode } from './input/PlanModeButton';
import { DocContextButton } from './input/DocContextButton';
import { ContextRing } from './input/ContextRing';
import { ThinkingLevelButton } from './input/ThinkingLevelButton';
import { ModelSelector, type ChatVideoMode } from './input/ModelSelector';
import { SlashCommandMenu } from './input/SlashCommandMenu';
import { MentionMenu, type MentionMenuItem } from './input/MentionMenu';
import { SendButton } from './input/SendButton';
import { QuotedSelectionCard } from './input/QuotedSelectionCard';
import { SessionConfirmationPrompt } from './input/SessionConfirmationPrompt';
import { CapabilityDriftNotice } from './input/CapabilityDriftNotice';
import { InputStatusBars } from './input/InputStatusBars';
import { InputUtilityButtons } from './input/InputUtilityButtons';
import { AnchoredPortal } from '../ui/AnchoredPortal';
import { serializeEditor } from '../utils/editor-serializer';
import { buildFileMentionItems, mergeEditorFileRefs } from '../utils/file-mention-items';
import { buildAgentMentionItems, buildSessionMentionItems, type MentionTab } from '../utils/mention-items';
import { findFileMentionTrigger } from '../utils/file-mention-trigger';
import {
  getVoiceRecognitionCtor,
  getVoiceSettings,
  supportsAudioInputDevices,
  supportsVoiceRecognition,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
} from '../utils/voice';
import { useSkillSlashItems } from '../hooks/use-slash-items';
import { notifyPasteUploadFailure } from '../utils/paste-upload-feedback';
import { extractPlainUrlPaste } from '../utils/plain-url-paste';
import { gsapFetch } from '../hooks/use-gsap-fetch';
import { prepareChatImageUpload } from '../utils/chat-image-upload-compression';
import { requestPromptOptimization } from '../utils/prompt-optimizer';
import { requestResearchReport } from '../utils/research-mode';
import { INPUT_DRAFT_REQUEST_EVENT, readInputDraftRequestDetail } from '../utils/input-draft-events';
import {
  WORKSPACE_TOOL_SELECT_EVENT,
  WORKSPACE_TOOL_OPTIONS,
  readWorkspaceToolSelectionDetail,
  type WorkspaceToolSelection,
} from '../utils/workspace-tool-events';
import { streamBufferManager } from '../hooks/use-stream-buffer';
import { modelSupportsImageInput } from '../utils/model-capabilities';
import { shouldShowThinkingControl } from '../utils/model-thinking';
import { resolveBrowserFilePaths } from '../utils/browser-file-paths';
import { shouldAllowInputFocus } from '../utils/input-focus-policy';
import {
  evaluateChatImageSendPreflight,
  evaluateChatVideoSendPreflight,
  notifyTextModelImageBlocked,
  notifyTextModelVideoFileOnly,
  type ChatImageModel,
} from '../utils/chat-image-send-preflight';
import { openProviderModelSettings } from '../utils/model-settings-navigation';
import { getDesktopApi } from '../utils/desktop-api';
import {
  XING_PROMPT, executeDiary, executeCompact, buildSlashCommands, getSlashMatches,
  executeVideo,
  executeSlashViaWs,
  buildSlashDraftText,
  parseSlashInput,
  resolveSlashSubmitSelection,
  type SlashItem,
} from './input/slash-commands';
import { attachFilesFromPaths } from '../MainContent';
import { formatQuotedSelectionForPrompt } from '../utils/quoted-selection';
import { createInputEditorExtensions } from './input/input-editor-extensions';
import { resolveInputPlaceholder } from './input/input-placeholder';
import { submitChatVideoGeneration } from './input/chat-video-mode';
import styles from './input/InputArea.module.css';
import type { DeskSearchResult } from '../types';
import type { ChatListItem, SessionConfirmationBlock } from '../stores/chat-types';
import type { AttachedFile, DocContextFile, QuotedSelection } from '../stores/input-slice';

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function chatVideoMimeTypeForName(name: string, fallback?: string): string {
  if (fallback?.startsWith('video/')) return fallback;
  const ext = name.toLowerCase().replace(/^.*\./, '');
  const mimeMap: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
  };
  return mimeMap[ext] || 'video/mp4';
}

export type { SlashItem };

function findLatestInputSessionConfirmation(items: ChatListItem[] | undefined, confirmId?: string, pendingOnly?: boolean): SessionConfirmationBlock | null {
  if (!items) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type !== 'message' || item.data.role !== 'assistant') continue;
    const blocks = item.data.blocks || [];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j];
      if (block.type !== 'session_confirmation' || block.surface !== 'input') continue;
      if (confirmId && block.confirmId !== confirmId) continue;
      if (pendingOnly && block.status !== 'pending') continue;
      return block;
    }
  }
  return null;
}

interface QueuedPrompt extends ComposerReferences {
  clientMessageId: string;
  id: string;
  text: string;
  files: AttachedFile[];
  docContext: DocContextFile | null;
  quotedSelections: QuotedSelection[];
  skills: string[];
  workspaceTool: WorkspaceToolSelection | null;
  status: 'pending' | 'running' | 'failed' | 'cancelled';
  error?: string | null;
  cancelReason?: string | null;
  attempts: number;
  createdAt: number;
}

type PromptDraft = Omit<QueuedPrompt, 'id' | 'createdAt' | 'status' | 'error' | 'attempts'>;

interface FileMentionRange {
  from: number;
  to: number;
  query: string;
}

interface InputKeyEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  preventDefault: () => void;
}

function createQueuedPromptId() {
  return `prompt-queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneQueuedFiles(files: readonly AttachedFile[]): AttachedFile[] {
  return files.map(file => ({ ...file }));
}

function cloneQueuedQuotes(quotes: readonly QuotedSelection[] | null | undefined): QuotedSelection[] {
  return Array.isArray(quotes)
    ? quotes.map(quote => ({ ...quote, anchorRect: quote.anchorRect ? { ...quote.anchorRect } : undefined }))
    : [];
}

function queuedPromptLabel(item: QueuedPrompt): string {
  const parts = [item.text.trim() || '空白消息'];
  if (item.workspaceTool?.title) parts.push(`工具 ${item.workspaceTool.title}`);
  if (item.files.length > 0) parts.push(`附件 ${item.files.length}`);
  if (item.docContext) parts.push('文档');
  if (item.quotedSelections.length > 0) parts.push(`引用 ${item.quotedSelections.length}`);
  if (item.skills.length > 0) parts.push(`技能 ${item.skills.length}`);
  return parts.join(' · ');
}

function queueStatusLabel(item: QueuedPrompt): string {
  if (item.status === 'running') return '执行中';
  if (item.status === 'failed') return '失败重试';
  if (item.status === 'cancelled') return '已取消';
  return '待执行';
}

async function buildPromptWsMessage({
  draft,
  currentModelInfo,
  supportsVision,
  loadVisionAuxiliaryConfig,
  t,
}: {
  draft: PromptDraft;
  currentModelInfo: ChatImageModel | null | undefined;
  supportsVision: boolean;
  loadVisionAuxiliaryConfig: () => Promise<{ enabled: boolean; model: unknown }>;
  t: (key: string) => string;
}): Promise<Record<string, unknown> | null> {
  const inputFiles = cloneQueuedFiles(draft.files);
  const sessionPathForSend = useStore.getState().currentSessionPath;
  const sessionFileRefs = inputFiles
    .filter(f => f.fileId)
    .map(f => ({
      fileId: f.fileId,
      sessionPath: sessionPathForSend || undefined,
      label: f.name || f.path,
      kind: f.isDirectory ? 'directory' : 'attachment',
    }));
  const imageFiles = inputFiles.filter(f => !f.isDirectory && isImageFile(f.name));
  const videoFiles = inputFiles.filter(f => !f.isDirectory && isVideoFile(f.name));
  const imagePreflight = await evaluateChatImageSendPreflight({
    attachments: inputFiles,
    model: currentModelInfo,
    loadVisionAuxiliaryConfig,
  });
  if (!imagePreflight.ok) {
    notifyTextModelImageBlocked({
      t,
      addToast: useStore.getState().addToast,
      openSettings: () => openProviderModelSettings(currentModelInfo?.provider),
    });
    return null;
  }

  const videoPreflight = await evaluateChatVideoSendPreflight({
    attachments: inputFiles,
    model: currentModelInfo,
  });
  const sendVideosNatively = videoPreflight.ok && videoPreflight.reason === 'native-video';
  const videosAsFileOnly = !sendVideosNatively;
  if (videosAsFileOnly && videoFiles.length > 0) {
    notifyTextModelVideoFileOnly({
      t,
      addToast: useStore.getState().addToast,
    });
  }
  const otherFiles = inputFiles.filter(f => (
    f.isDirectory || (!isImageFile(f.name) && !(sendVideosNatively && isVideoFile(f.name)))
  ));

  let finalText = draft.text;
  if (otherFiles.length > 0) {
    const fileBlock = otherFiles.map(f => {
      const label = f.fileId ? (f.name || f.path) : f.path;
      return f.isDirectory ? `[directory] ${label}` : `[attachment] ${label}`;
    }).join('\n');
    finalText = finalText ? `${finalText}\n\n${fileBlock}` : fileBlock;
  }

  const gsap = getDesktopApi();
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  const videos: Array<{ type: 'video'; data: string; mimeType: string }> = [];
  const imageBase64Map = new Map<string, { base64Data: string; mimeType: string }>();
  const videoBase64Map = new Map<string, { base64Data: string; mimeType: string }>();

  for (const img of imageFiles) {
    try {
      const prepared = await prepareImageAttachmentForVision(
        img,
        gsap?.readFileBase64 ? gsap.readFileBase64.bind(gsap) : undefined,
      );
      if (prepared.base64Data && prepared.mimeType) {
        imageBase64Map.set(prepared.path, { base64Data: prepared.base64Data, mimeType: prepared.mimeType });
        images.push({ type: 'image', data: prepared.base64Data, mimeType: prepared.mimeType });
      }
    } catch {
      finalText = finalText ? `${finalText}\n\n[attachment] ${img.path}` : `[attachment] ${img.path}`;
    }
  }

  for (const video of sendVideosNatively ? videoFiles : []) {
    try {
      if (video.base64Data && video.mimeType) {
        const mimeType = chatVideoMimeTypeForName(video.name, video.mimeType);
        videoBase64Map.set(video.path, { base64Data: video.base64Data, mimeType });
        videos.push({ type: 'video', data: video.base64Data, mimeType });
      } else if (gsap?.readFileBase64) {
        const base64 = await gsap.readFileBase64(video.path);
        if (base64) {
          const mimeType = chatVideoMimeTypeForName(video.name, video.mimeType);
          videoBase64Map.set(video.path, { base64Data: base64, mimeType });
          videos.push({ type: 'video', data: base64, mimeType });
        }
      }
    } catch {
      finalText = finalText ? `${finalText}\n\n[attachment] ${video.path}` : `[attachment] ${video.path}`;
    }
  }

  const allFiles = [...inputFiles];
  if (draft.docContext) {
    finalText = finalText
      ? `${finalText}\n\n[reference document] ${draft.docContext.path}`
      : `[reference document] ${draft.docContext.path}`;
    allFiles.push({ path: draft.docContext.path, name: draft.docContext.name });
  }

  if (draft.quotedSelections.length > 0) {
    const quoteStr = draft.quotedSelections.map(formatQuotedSelectionForPrompt).join('\n\n');
    finalText = finalText ? `${finalText}\n\n${quoteStr}` : quoteStr;
  }

  const wsMsg: Record<string, unknown> = {
    type: 'prompt',
    text: finalText || (draft.quickAction ? QUICK_ACTIONS[draft.quickAction].title : draft.agentMentions.length ? '请审阅当前任务。' : draft.sessionRefs.length ? '请结合引用的对话回答。' : ''),
    sessionPath: sessionPathForSend,
    uiContext: collectUiContext(useStore.getState(), { workspaceTool: draft.workspaceTool }),
    displayMessage: {
      text: draft.text,
      quickAction: draft.quickAction,
      agentMentions: draft.agentMentions,
      sessionRefs: draft.sessionRefs,
      clientMessageId: draft.clientMessageId,
      skills: draft.skills.length > 0 ? [...draft.skills] : undefined,
      workspaceTool: draft.workspaceTool || undefined,
      quotedText: draft.quotedSelections.length > 0 ? draft.quotedSelections.map(q => q.text).join('\n\n') : undefined,
      attachments: allFiles.length > 0 ? allFiles.map(f => {
        const cached = imageBase64Map.get(f.path);
        const cachedVideo = videoBase64Map.get(f.path);
        const imageFile = !f.isDirectory && isImageFile(f.name);
        return {
          fileId: f.fileId,
          path: f.path,
          name: f.name,
          isDir: !!f.isDirectory,
          base64Data: f.base64Data || cached?.base64Data || cachedVideo?.base64Data || undefined,
          mimeType: f.mimeType || cached?.mimeType || cachedVideo?.mimeType || undefined,
          presentation: f.presentation,
          listed: f.listed,
          waveform: f.waveform,
          transcription: f.transcription,
          visionAuxiliary: imageFile && !supportsVision,
        };
      }) : undefined,
    },
  };
  if (sessionFileRefs.length > 0) wsMsg.sessionFileRefs = sessionFileRefs;
  if (images.length > 0) wsMsg.images = images;
  if (videos.length > 0) wsMsg.videos = videos;
  if (draft.skills.length > 0) wsMsg.skills = [...draft.skills];
  return wsMsg;
}

function buildSkillEditorContent(skillName: string, args = '') {
  const content: Array<{ type: string; attrs?: Record<string, string>; text?: string }> = [
    { type: 'skillBadge', attrs: { name: skillName } },
    { type: 'text', text: ' ' },
  ];
  const trimmedArgs = String(args || '').trim();
  if (trimmedArgs) {
    content.push({ type: 'text', text: trimmedArgs });
  }
  return {
    type: 'doc' as const,
    content: [{
      type: 'paragraph' as const,
      content,
    }],
  };
}

function buildPlainTextEditorDoc(text: string) {
  return {
    type: 'doc' as const,
    content: text.split('\n').map(line => ({
      type: 'paragraph' as const,
      content: line ? [{ type: 'text' as const, text: line }] : [],
    })),
  };
}

function findFileMentionRange(editor: Editor | null): FileMentionRange | null {
  if (!editor?.state?.selection) return null;
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const before = selection.$from.parent.textBetween(0, selection.$from.parentOffset, '\n', '\n');
  const trigger = findFileMentionTrigger(before);
  if (!trigger) return null;
  return {
    from: selection.from - trigger.query.length - 1,
    to: selection.from,
    query: trigger.query,
  };
}

function editorHasInlineNode(editor: Editor | null, nodeType: string): boolean {
  if (!editor?.state?.doc) return false;
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === nodeType) {
      found = true;
      return false;
    }
    return !found;
  });
  return found;
}

interface InputAreaProps {
  cardRef?: Ref<HTMLDivElement>;
  surface?: 'desktop' | 'mobile';
  visible?: boolean;
}

//

export function InputArea({ cardRef, surface = 'desktop', visible = true }: InputAreaProps = {}) {
  return <InputAreaInner cardRef={cardRef} surface={surface} visible={visible} />;
}

interface InputAreaInnerProps {
  cardRef?: Ref<HTMLDivElement>;
  surface: 'desktop' | 'mobile';
  visible: boolean;
}

function InputAreaInner({ cardRef, surface, visible }: InputAreaInnerProps) {
  const { t, locale } = useI18n();
  const setVoiceRecording = useStore(s => s.setVoiceRecording);

  // Zustand state
  const isStreaming = useStore(s => selectIsStreamingSession(s, s.currentSessionPath));
  const connected = useStore(s => s.connected);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const currentSessionProjection = useStore(s => s.currentSessionPath
    ? s.sessions.find(session => session.path === s.currentSessionPath) || null
    : null);
  const deletedAgentReadOnly = currentSessionProjection?.agentDeleted === true;
  const capabilityDrift = useStore(s => s.currentSessionPath ? sessionScopedValue(s, s.capabilityDriftBySession, s.currentSessionPath) ?? null : null);
  const capabilityRefreshing = useStore(s => s.currentSessionPath ? sessionScopedListIncludes(s, toStringArray(s.capabilityRefreshingSessions), s.currentSessionPath) : false);
  const currentAgentId = useStore(s => s.currentAgentId);
  const selectedAgentId = useStore(s => s.selectedAgentId);
  const agents = useStore(s => s.agents);
  const sessions = useStore(s => s.sessions);
  const compacting = useStore(s => currentSessionPath ? sessionScopedListIncludes(s, toStringArray(s.compactingSessions), currentSessionPath) : false);
  const screenshotBusy = useStore(s => s.screenshotTaskCount > 0);
  const screenshotProgress = useStore(s => s.screenshotProgress);
  const inlineError = useStore(s => s.inlineErrors[s.currentSessionPath || ''] ?? null);
  const attachedFiles = useStore(s => toArray<typeof s.attachedFiles[number]>(s.attachedFiles));
  const docContextAttached = useStore(s => s.docContextAttached);
  const quotedSelections = useStore(s => s.quotedSelections);
  const deskFiles = useStore(s => s.deskFiles);
  const deskBasePath = useStore(s => s.deskBasePath);
  const deskCurrentPath = useStore(s => s.deskCurrentPath);
  const sessionFiles = useStore(s => s.currentSessionPath ? selectSessionFiles(s, s.currentSessionPath) : EMPTY_ARRAY);
  const artifacts = useStore(selectArtifacts);
  const activeTabId = useStore(selectActiveTabId);
  const previewOpen = useStore(s => s.previewOpen);
  const models = useStore(s => toArray<typeof s.models[number]>(s.models));
  const agentYuan = useStore(s => s.agentYuan);
  const thinkingLevel = useStore(s => s.thinkingLevel);
  const setThinkingLevel = useStore(s => s.setThinkingLevel);

  const globalModelInfo = useMemo(() => models.find(m => m.isCurrent), [models]);
  const sessionModel = useStore(s => s.currentSessionPath ? sessionScopedValue(s, s.sessionModelsByPath, s.currentSessionPath) : undefined);
  const currentModelInfo = sessionModel || globalModelInfo;
  const availableThinkingLevels = useMemo(
    () => getModelThinkingLevels(currentModelInfo),
    [currentModelInfo],
  );
  const supportsVision = modelSupportsImageInput(currentModelInfo);
  const showThinkingControl = shouldShowThinkingControl(currentModelInfo, models);
  const modelSwitching = useStore(s => s.modelSwitching);
  const currentSessionItems = useStore(s => s.currentSessionPath ? sessionScopedValue(s, s.chatSessions, s.currentSessionPath)?.items : undefined);
  const storedSessionConfirmation = useStore(s => s.currentSessionPath
    ? sessionScopedValue(s, s.pendingSessionConfirmationsByPath, s.currentSessionPath) || null
    : null);
  const pendingSessionConfirmation = useMemo(() => {
    return findLatestInputSessionConfirmation(currentSessionItems, undefined, true)
      || storedSessionConfirmation;
  }, [currentSessionItems, storedSessionConfirmation]);

  // Local state
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
  const [sending, setSending] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelected, setSlashSelected] = useState(0);
  const [slashBusy, setSlashBusy] = useState<string | null>(null);
  const [slashResult, setSlashResult] = useState<{ text: string; type: 'success' | 'error'; deskDir?: string; filePath?: string } | null>(null);
  const voiceRecording = useStore(s => s.voiceRecording);
  const [queuedMessages, setQueuedMessages] = useState<QueuedPrompt[]>([]);
  const [queueRunning, setQueueRunning] = useState(false);
  const [queueWaitingForResponse, setQueueWaitingForResponse] = useState(false);
  const [activeChatVideoMode, setActiveChatVideoMode] = useState<ChatVideoMode | null>(null);
  const [visibleSessionConfirmation, setVisibleSessionConfirmation] = useState<SessionConfirmationBlock | null>(null);
  const [sessionConfirmationExiting, setSessionConfirmationExiting] = useState(false);
  const [continuingDeletedAgent, setContinuingDeletedAgent] = useState(false);
  const [promptOptimizing, setPromptOptimizing] = useState(false);
  const [researching, setResearching] = useState(false);
  const workspaceTool = useStore(s => s.workspaceTool);
  const setWorkspaceTool = useStore(s => s.setWorkspaceTool);
  const [workspaceToolMenuOpen, setWorkspaceToolMenuOpen] = useState(false);
  const slashBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!visible) setWorkspaceToolMenuOpen(false);
  }, [visible]);

  const isComposing = useRef(false);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const keyDownHandlerRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const beforeInputHandlerRef = useRef<(event: InputEvent) => boolean>(() => false);
  const browserFileInputRef = useRef<HTMLInputElement>(null);
  const slashDismissedTextRef = useRef<string | null>(null);
  const fileMentionSearchSeqRef = useRef(0);
  const slashAutoInsertTextRef = useRef<string | null>(null);
  const inputWrapperRef = useRef<HTMLDivElement | null>(null);
  const workspaceToolMenuRef = useRef<HTMLDivElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const [inputText, setInputText] = useState('');
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [mentionTab, setMentionTab] = useState<MentionTab>('files');
  const [fileSelected, setFileSelected] = useState(0);
  const [fileMentionRange, setFileMentionRange] = useState<FileMentionRange | null>(null);
  const [fileMentionQuery, setFileMentionQuery] = useState('');
  const [fileMentionSearchResults, setFileMentionSearchResults] = useState<DeskSearchResult[]>([]);
  const [fileMentionBusy, setFileMentionBusy] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const voiceRecordingModeRef = useRef<'speech' | 'device' | null>(null);
  const queueDragIdRef = useRef<string | null>(null);
  const prevStreamingRef = useRef(isStreaming);
  const speechSupported = supportsVoiceRecognition();
  const selectedVoiceInputSupported = supportsAudioInputDevices();
  const voiceInputSupported = speechSupported || selectedVoiceInputSupported;
  useEffect(() => {
    if (pendingSessionConfirmation) {
      setVisibleSessionConfirmation(pendingSessionConfirmation);
      setSessionConfirmationExiting(false);
      return;
    }
    if (!visibleSessionConfirmation || sessionConfirmationExiting) return;

    const resolved = findLatestInputSessionConfirmation(currentSessionItems, visibleSessionConfirmation.confirmId);
    setVisibleSessionConfirmation(resolved || visibleSessionConfirmation);
    setSessionConfirmationExiting(true);
  }, [currentSessionItems, pendingSessionConfirmation, sessionConfirmationExiting, visibleSessionConfirmation]);

  useEffect(() => {
    if (!sessionConfirmationExiting) return;
    const timer = window.setTimeout(() => {
      setVisibleSessionConfirmation(null);
      setSessionConfirmationExiting(false);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [sessionConfirmationExiting]);

 //
  useEffect(() => {
    const handler = (e: Event) => {
      const { text, type, deskDir, filePath } = (e as CustomEvent).detail;
      setSlashResult({ text, type, deskDir, filePath });
      setTimeout(() => setSlashResult(null), 3000);
    };
    window.addEventListener('gsap-inline-notice', handler);
    return () => window.removeEventListener('gsap-inline-notice', handler);
  }, []);

  // ── Placeholder ──
  const placeholder = useMemo(
    () => resolveInputPlaceholder({ agentYuan, locale, t }),
    [agentYuan, locale, t],
  );
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;

  // ── TipTap editor ──
  const editor = useEditor({
    immediatelyRender: surface !== 'mobile',
    extensions: createInputEditorExtensions(() => placeholderRef.current),
    editorProps: {
      attributes: {
        class: styles['input-box'],
        id: 'inputBox',
        spellcheck: 'false',
      },
      handleKeyDown: (_view, event) => keyDownHandlerRef.current(event),
      handleDOMEvents: {
        beforeinput: (_view, event) => beforeInputHandlerRef.current(event as InputEvent),
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    placeholderRef.current = placeholder;
    editor.view.dispatch(editor.state.tr.setMeta('input-placeholder', placeholder));
  }, [editor, placeholder]);

  const setInputWrapperRef = useCallback((node: HTMLDivElement | null) => {
    inputWrapperRef.current = node;
    if (typeof cardRef === 'function') {
      cardRef(node);
    } else if (cardRef && typeof cardRef === 'object') {
      (cardRef as { current: HTMLDivElement | null }).current = node;
    }
  }, [cardRef]);

  const restoreEditorFocus = useCallback(() => {
    if (!editor || editor.isDestroyed) return;
    if (!shouldAllowInputFocus({ inputRoot: inputWrapperRef.current })) return;

    const run = () => {
      focusFrameRef.current = null;
      if (!editor || editor.isDestroyed) return;
      if (!shouldAllowInputFocus({ inputRoot: inputWrapperRef.current })) return;
      editor.commands.focus();
    };

    if (typeof window.requestAnimationFrame === 'function') {
      if (focusFrameRef.current !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
      focusFrameRef.current = window.requestAnimationFrame(run);
      return;
    }

    window.setTimeout(run, 0);
  }, [editor]);

  useEffect(() => {
    return () => {
      if (focusFrameRef.current !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
      focusFrameRef.current = null;
    };
  }, []);

  // Focus trigger from store
  const inputFocusTrigger = useStore(s => s.inputFocusTrigger);
  useEffect(() => {
    if (inputFocusTrigger > 0) restoreEditorFocus();
  }, [inputFocusTrigger, restoreEditorFocus]);

  useEffect(() => {
    if (surface !== 'desktop') return;
    const handleWindowFocus = () => restoreEditorFocus();
    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, [restoreEditorFocus, surface]);

  useEffect(() => {
    if (!editor) return;
    if (deletedAgentReadOnly) {
      if (editor.isEditable) editor.setEditable(false);
      return;
    }
    if (!editor.isEditable) editor.setEditable(true);
  }, [deletedAgentReadOnly, editor, currentSessionPath, pendingNewSession]);

  // Zustand actions
  const addAttachedFile = useStore(s => s.addAttachedFile);
  const removeAttachedFile = useStore(s => s.removeAttachedFile);
  const clearAttachedFiles = useStore(s => s.clearAttachedFiles);
  const toggleDocContext = useStore(s => s.toggleDocContext);
  const setDocContextAttached = useStore(s => s.setDocContextAttached);
  const setDraft = useStore(s => s.setDraft);
  const clearDraft = useStore(s => s.clearDraft);

  const loadVisionAuxiliaryConfig = useCallback(async () => {
    const res = await gsapFetch('/api/models/auxiliary-vision');
    const data = await res.json();
    const status = data?.auxiliaryVision;
    return {
      enabled: status?.available === true,
      model: status?.model || null,
    };
  }, []);

  // Doc context
  const currentDoc = useMemo(() => {
    if (!previewOpen || !activeTabId) return null;
    const art = artifacts.find(a => a.id === activeTabId);
    if (!art?.filePath) return null;
    return { path: art.filePath, name: art.title || art.filePath.split('/').pop() || '' };
  }, [previewOpen, activeTabId, artifacts]);
  const hasDoc = !!currentDoc;

  const focusEditorFromInputShell = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!editor) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button,a,input,textarea,select,[role="button"],[data-no-input-focus]')) return;
    editor.commands.focus();
  }, [editor]);

  // Clear attached document context when the document disappears.
  useEffect(() => {
    if (!hasDoc && docContextAttached) setDocContextAttached(false);
  }, [hasDoc, docContextAttached, setDocContextAttached]);

 //

  const sendAsUser = useCallback(async (text: string, displayText?: string): Promise<boolean> => {
    if (deletedAgentReadOnly) return false;
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const _s = useStore.getState();
    if (selectIsStreamingSession(_s, _s.currentSessionPath)) return false;

    const sessionState = useStore.getState();
    if (!sessionState.currentSessionPath || sessionState.pendingNewSession) {
      const ok = await ensureSession();
      if (!ok) return false;
      if (!useStore.getState().currentSessionPath) return false;
      loadSessions();
    }

    const targetSessionPath = useStore.getState().currentSessionPath;
    if (targetSessionPath) streamBufferManager.beginUserTurn(targetSessionPath);

    const activeWorkspaceTool = workspaceTool ? { ...workspaceTool } : null;

    ws.send(JSON.stringify({
      type: 'prompt',
      text,
      sessionPath: targetSessionPath,
      uiContext: collectUiContext(useStore.getState(), { workspaceTool: activeWorkspaceTool }),
      displayMessage: {
        text: displayText ?? text,
        workspaceTool: activeWorkspaceTool || undefined,
      },
    }));
    return true;
  }, [deletedAgentReadOnly, workspaceTool]);

  // ── 斜杠命令 ──

  const showSlashResult = useCallback((text: string, type: 'success' | 'error') => {
    setSlashBusy(null);
    setSlashResult({ text, type });
    setTimeout(() => setSlashResult(null), 3000);
  }, []);

  const clearEditor = useCallback(() => {
    editor?.commands.clearContent();
    setInputText('');
  }, [editor]);

  const setEditorPlainText = useCallback((text: string) => {
    if (!editor) return;
    const nextText = String(text || '');
    if (!nextText) editor.commands.clearContent();
    else editor.commands.setContent(buildPlainTextEditorDoc(nextText), { emitUpdate: false });
    setInputText(nextText);
    setDraft(currentSessionPath || '__new', nextText);
    editor.commands.focus('end');
  }, [currentSessionPath, editor, setDraft]);

  useEffect(() => {
    if (!editor) return;

    const handleInputDraftRequest = (event: Event) => {
      const detail = readInputDraftRequestDetail(event);
      if (!detail) return;

      if (detail.quickAction) {
        // Replace only the previous task tag; keep user prose, references and attachments.
        const ranges: { from: number; to: number }[] = [];
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === 'quickActionBadge') ranges.push({ from: pos, to: pos + node.nodeSize });
        });
        const chain = editor.chain();
        for (const range of ranges.reverse()) chain.deleteRange(range);
        chain.insertContentAt(1, [{ type: 'quickActionBadge', attrs: { actionId: detail.quickAction } }, { type: 'text', text: ' ' }]).focus('end').run();
        if (detail.quickAction === 'agents') { setMentionTab('agents'); editor.chain().insertContent('@').run(); }
        return;
      }
      const currentText = editor.getText().trim();
      const nextText = detail.mode === 'append' && currentText
        ? `${currentText}\n\n${detail.text}`
        : detail.text;
      setEditorPlainText(nextText);
    };

    window.addEventListener(INPUT_DRAFT_REQUEST_EVENT, handleInputDraftRequest);
    return () => window.removeEventListener(INPUT_DRAFT_REQUEST_EVENT, handleInputDraftRequest);
  }, [editor, setEditorPlainText]);

  useEffect(() => {
    const handleWorkspaceToolSelect = (event: Event) => {
      const detail = readWorkspaceToolSelectionDetail((event as CustomEvent).detail);
      if (detail) {
        setWorkspaceTool(detail);
        setWorkspaceToolMenuOpen(false);
      }
    };
    window.addEventListener(WORKSPACE_TOOL_SELECT_EVENT, handleWorkspaceToolSelect);
    return () => window.removeEventListener(WORKSPACE_TOOL_SELECT_EVENT, handleWorkspaceToolSelect);
  }, []);

  const handleWorkspaceToolPick = useCallback((tool: WorkspaceToolSelection | null) => {
    setWorkspaceTool(tool ? { ...tool } : null);
    setWorkspaceToolMenuOpen(false);
  }, []);

  const handleOptimizePrompt = useCallback(async () => {
    if (!editor || promptOptimizing || deletedAgentReadOnly) return;
    const prompt = editor.getText().trim();
    if (!prompt) {
      useStore.getState().addToast?.(t('input.promptOptimizeEmpty'), 'info', 2200);
      return;
    }
    setPromptOptimizing(true);
    try {
      const optimized = await requestPromptOptimization({
        prompt,
        sessionPath: currentSessionPath,
        agentId: pendingNewSession ? (selectedAgentId || currentAgentId) : currentAgentId,
        locale,
      });
      setEditorPlainText(optimized);
      useStore.getState().addToast?.(t('input.promptOptimizeDone'), 'success', 1800);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      useStore.getState().addToast?.(`${t('input.promptOptimizeFailed')}: ${detail}`, 'error', 5000);
    } finally {
      setPromptOptimizing(false);
    }
  }, [
    currentAgentId,
    currentSessionPath,
    deletedAgentReadOnly,
    editor,
    locale,
    pendingNewSession,
    promptOptimizing,
    selectedAgentId,
    setEditorPlainText,
    t,
  ]);

  const handleResearchPrompt = useCallback(async () => {
    if (!editor || researching || promptOptimizing || deletedAgentReadOnly) return;
    const topic = editor.getText().trim();
    if (!topic) {
      useStore.getState().addToast?.(t('input.researchEmpty'), 'info', 2200);
      return;
    }
    setResearching(true);
    try {
      const result = await requestResearchReport({
        topic,
        mode: 'deep',
        sessionPath: currentSessionPath,
        agentId: pendingNewSession ? (selectedAgentId || currentAgentId) : currentAgentId,
        locale,
        exportFormats: ['word', 'pdf'],
      });
      setEditorPlainText(result.report);
      useStore.getState().addToast?.(t('input.researchDone'), 'success', 1800);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      useStore.getState().addToast?.(`${t('input.researchFailed')}: ${detail}`, 'error', 5000);
    } finally {
      setResearching(false);
    }
  }, [
    currentAgentId,
    currentSessionPath,
    deletedAgentReadOnly,
    editor,
    locale,
    pendingNewSession,
    promptOptimizing,
    researching,
    selectedAgentId,
    setEditorPlainText,
    t,
  ]);

  const createPromptDraft = useCallback((text: string, skills: readonly string[], files: readonly AttachedFile[], references: ComposerReferences): PromptDraft => ({
    ...references,
    clientMessageId: crypto.randomUUID(),
    text,
    files: cloneQueuedFiles(files),
    docContext: docContextAttached && currentDoc ? { ...currentDoc } : null,
    quotedSelections: cloneQueuedQuotes(useStore.getState().quotedSelections),
    skills: [...skills],
    workspaceTool: workspaceTool ? { ...workspaceTool } : null,
  }), [currentDoc, docContextAttached, workspaceTool]);

  const enqueuePromptDraft = useCallback((draft: PromptDraft) => {
    setQueuedMessages(prev => [...prev, {
      id: createQueuedPromptId(),
      createdAt: Date.now(),
      status: 'pending',
      error: null,
      cancelReason: null,
      attempts: 0,
      ...draft,
    }]);
    clearEditor();
    clearAttachedFiles();
    if (docContextAttached) setDocContextAttached(false);
    if (useStore.getState().quotedSelections.length > 0) useStore.getState().clearQuotedSelections();
    clearDraft(currentSessionPath || '__new');
    slashDismissedTextRef.current = null;
    setSlashMenuOpen(false);
    if (isStreaming) setQueueRunning(true);
    showSlashResult(t('input.queueAdded'), 'success');
  }, [clearAttachedFiles, clearDraft, clearEditor, currentSessionPath, docContextAttached, isStreaming, setDocContextAttached, showSlashResult, t]);

  const sendPromptDraft = useCallback(async (draft: PromptDraft): Promise<boolean> => {
    if (deletedAgentReadOnly) return false;
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    if (draft.quickAction === 'agents' && draft.agentMentions.length !== 1) {
      showSlashResult('请通过 @ 选择一位辅助助手。', 'error');
      return false;
    }
    if (draft.quickAction === 'workflow') {
      if (!draft.text.trim()) { showSlashResult('请描述希望创建的工作流。', 'error'); return false; }
      if (draft.files.length || draft.sessionRefs.length || draft.agentMentions.length || draft.skills.length) {
        showSlashResult('工作流模板入口使用文字描述，请先移除引用、附件或技能。', 'error'); return false;
      }
      requestWorkflowTemplate(draft.text);
      switchTab('workflow');
      return true;
    }
    const sessionState = useStore.getState();
    if (!sessionState.currentSessionPath || sessionState.pendingNewSession) {
      const ok = await ensureSession();
      if (!ok) return false;
      if (!useStore.getState().currentSessionPath) return false;
      loadSessions();
    }

    const wsMsg = await buildPromptWsMessage({
      draft,
      currentModelInfo,
      supportsVision,
      loadVisionAuxiliaryConfig,
      t,
    });
    if (!wsMsg) return false;

    const targetSessionPath = typeof wsMsg.sessionPath === 'string'
      ? wsMsg.sessionPath
      : useStore.getState().currentSessionPath;
    if (targetSessionPath) streamBufferManager.beginUserTurn(targetSessionPath);

    ws.send(JSON.stringify(wsMsg));
    return true;
  }, [currentModelInfo, deletedAgentReadOnly, loadVisionAuxiliaryConfig, supportsVision, showSlashResult, t]);

  const handleQueueAdd = useCallback(() => {
    if (deletedAgentReadOnly) return;
    if (!editor) return;
    const editorJson = editor.getJSON();
    const { text: rawText, skills, fileRefs, ...references } = serializeEditor(editorJson);
    const text = rawText.trim();
    const inputFiles = mergeEditorFileRefs(attachedFiles, fileRefs);
    const draft = createPromptDraft(text, skills, inputFiles, references);

    if (!draft.text && draft.files.length === 0 && !draft.docContext && draft.quotedSelections.length === 0 && draft.skills.length === 0 && !draft.workspaceTool && !draft.quickAction && !draft.agentMentions.length && !draft.sessionRefs.length) {
      showSlashResult(t('input.queueEmpty'), 'error');
      return;
    }

    enqueuePromptDraft(draft);
  }, [attachedFiles, createPromptDraft, deletedAgentReadOnly, editor, enqueuePromptDraft, showSlashResult, t]);

  const removeQueuedMessage = useCallback((id: string) => {
    setQueuedMessages(prev => prev.filter(item => item.id !== id));
  }, []);

  const clearQueuedMessages = useCallback(() => {
    setQueuedMessages([]);
    setQueueRunning(false);
    setQueueWaitingForResponse(false);
  }, []);

  const sendNextQueuedMessage = useCallback(async () => {
    if (isStreaming || sending || queueWaitingForResponse || modelSwitching || !connected) return;
    const next = queuedMessages.find(item => item.status === 'pending');
    if (!next) {
      setQueueRunning(false);
      return;
    }

    setQueueWaitingForResponse(true);
    setQueuedMessages(prev => prev.map(item => (
      item.id === next.id ? { ...item, status: 'running', error: null, cancelReason: null, attempts: item.attempts + 1 } : item
    )));
    const ok = await sendPromptDraft(next);
    if (ok) {
      setQueuedMessages(prev => prev.filter(item => item.id !== next.id));
      return;
    }

    setQueueWaitingForResponse(false);
    setQueueRunning(false);
    setQueuedMessages(prev => prev.map(item => (
      item.id === next.id ? { ...item, status: 'failed', error: t('input.queueBlocked'), cancelReason: null } : item
    )));
    showSlashResult(t('input.queueBlocked'), 'error');
  }, [connected, isStreaming, modelSwitching, queueWaitingForResponse, queuedMessages, sendPromptDraft, sending, showSlashResult, t]);

  const handleQueueRun = useCallback(() => {
    if (!queuedMessages.some(item => item.status === 'pending')) return;
    if (isStreaming || queueWaitingForResponse || modelSwitching || !connected) {
      showSlashResult(t('input.queueBlocked'), 'error');
      return;
    }
    setQueueRunning(true);
    void sendNextQueuedMessage();
  }, [connected, isStreaming, modelSwitching, queueWaitingForResponse, queuedMessages, sendNextQueuedMessage, showSlashResult, t]);

  const retryQueuedMessage = useCallback((id: string) => {
    setQueuedMessages(prev => prev.map(item => (
      item.id === id ? { ...item, status: 'pending', error: null, cancelReason: null } : item
    )));
  }, []);

  const cancelQueueRun = useCallback(() => {
    setQueueRunning(false);
    setQueueWaitingForResponse(false);
    setQueuedMessages(prev => prev.map(item => (
      item.status === 'pending' || item.status === 'running'
        ? { ...item, status: 'cancelled', error: null, cancelReason: '用户取消队列执行' }
        : item
    )));
  }, []);

  const handleQueueDragStart = useCallback((id: string) => {
    queueDragIdRef.current = id;
  }, []);

  const handleQueueDrop = useCallback((targetId: string) => {
    const sourceId = queueDragIdRef.current;
    queueDragIdRef.current = null;
    if (!sourceId || sourceId === targetId) return;

    setQueuedMessages(prev => {
      const sourceIndex = prev.findIndex(item => item.id === sourceId);
      const targetIndex = prev.findIndex(item => item.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  useEffect(() => {
    if (isStreaming) {
      setQueueWaitingForResponse(false);
    }

    const justStopped = prevStreamingRef.current && !isStreaming;
    prevStreamingRef.current = isStreaming;
    if (!queueRunning) return;

    if (justStopped && queuedMessages.length > 0) {
      const timer = window.setTimeout(() => {
        void sendNextQueuedMessage();
      }, 180);
      return () => window.clearTimeout(timer);
    }

    if (!isStreaming && !queueWaitingForResponse && queuedMessages.length === 0) {
      setQueueRunning(false);
    }
  }, [isStreaming, queueRunning, queueWaitingForResponse, queuedMessages.length, sendNextQueuedMessage]);

  const diaryFn = useMemo(
    () => executeDiary(t, showSlashResult, setSlashBusy, clearEditor, setSlashMenuOpen),
    [t, showSlashResult, clearEditor],
  );
  const xingFn = useCallback(async () => {
    clearEditor();
    setSlashMenuOpen(false);
    await sendAsUser(XING_PROMPT);
  }, [sendAsUser, clearEditor]);
  const compactFn = useMemo(
    () => executeCompact(setSlashBusy, clearEditor, setSlashMenuOpen),
    [clearEditor],
  );
  const videoFn = useMemo(
    () => executeVideo(t, showSlashResult, setSlashBusy, clearEditor, setSlashMenuOpen, sendAsUser),
    [t, showSlashResult, clearEditor, sendAsUser],
  );
  const slashViaWsFactory = useCallback(
    (cmd: string) => executeSlashViaWs(cmd, setSlashBusy, clearEditor, setSlashMenuOpen),
    [clearEditor],
  );

  const slashAgentId = pendingNewSession ? (selectedAgentId || currentAgentId) : currentAgentId;
  const skillItems = useSkillSlashItems({ enabled: surface !== 'mobile', agentId: slashAgentId });

  const slashCommands = useMemo(
    () => [...buildSlashCommands(t, diaryFn, xingFn, compactFn, videoFn, slashViaWsFactory), ...skillItems],
    [diaryFn, xingFn, compactFn, videoFn, slashViaWsFactory, t, skillItems],
  );

  const filteredCommands = useMemo(() => {
    if (!inputText.startsWith('/')) return slashCommands;
    return getSlashMatches(inputText, slashCommands);
  }, [inputText, slashCommands]);

  const fileMentionItems = useMemo(() => buildFileMentionItems({
    query: fileMentionQuery,
    attachedFiles,
    sessionFiles,
    deskFiles,
    deskBasePath,
    deskCurrentPath,
    searchResults: fileMentionSearchResults,
  }), [
    attachedFiles,
    deskBasePath,
    deskCurrentPath,
    deskFiles,
    fileMentionQuery,
    fileMentionSearchResults,
    sessionFiles,
  ]);

  const sessionMentionItems = useMemo(() => buildSessionMentionItems({
    sessions, query: fileMentionQuery,
  }), [sessions, fileMentionQuery]);
  const agentMentionItems = useMemo(() => buildAgentMentionItems({
    agents, query: fileMentionQuery, currentAgentId: slashAgentId,
  }), [agents, fileMentionQuery, slashAgentId]);
  const mentionItems = useMemo<MentionMenuItem[]>(() => {
    if (mentionTab === 'sessions') return sessionMentionItems;
    if (mentionTab === 'agents') return agentMentionItems;
    return fileMentionItems;
  }, [mentionTab, sessionMentionItems, agentMentionItems, fileMentionItems]);
  const handleMentionTabChange = useCallback((tab: MentionTab) => {
    setMentionTab(tab);
    setFileSelected(0);
  }, []);

  const dismissSlashMenu = useCallback(() => {
    const text = editor?.getText().trim() ?? inputText.trim();
    slashDismissedTextRef.current = text.startsWith('/') ? text : null;
    setSlashMenuOpen(false);
  }, [editor, inputText]);

  const insertExactSkillSlash = useCallback((text: string, trailingArgs = '') => {
    if (!editor || editorHasInlineNode(editor, 'skillBadge')) return false;
    const parsed = parseSlashInput(text);
    if (!parsed.name) return false;
    const exactSkill = slashCommands.find(cmd => cmd.type === 'skill' && cmd.name === parsed.name);
    if (!exactSkill) return false;
    slashAutoInsertTextRef.current = text;
    slashDismissedTextRef.current = null;
    editor.commands.setContent(buildSkillEditorContent(exactSkill.name, trailingArgs || parsed.args));
    editor.commands.focus('end');
    setInputText(editor.getText());
    setSlashMenuOpen(false);
    setSlashSelected(0);
    return true;
  }, [editor, slashCommands]);

  useEffect(() => {
    const seq = ++fileMentionSearchSeqRef.current;
    if (!fileMenuOpen || mentionTab !== 'files') {
      setFileMentionSearchResults([]);
      setFileMentionBusy(false);
      return;
    }

    const query = fileMentionQuery.trim();
    if (!query) {
      setFileMentionSearchResults([]);
      setFileMentionBusy(false);
      return;
    }

    setFileMentionBusy(true);
    const timer = window.setTimeout(() => {
      searchDeskFiles(query)
        .then((results) => {
          if (fileMentionSearchSeqRef.current === seq) setFileMentionSearchResults(results);
        })
        .catch((err: unknown) => {
          if (fileMentionSearchSeqRef.current === seq) setFileMentionSearchResults([]);
          console.warn('[file-mention] search failed', err);
        })
        .finally(() => {
          if (fileMentionSearchSeqRef.current === seq) setFileMentionBusy(false);
        });
    }, 120);

    return () => {
      window.clearTimeout(timer);
      if (fileMentionSearchSeqRef.current === seq) fileMentionSearchSeqRef.current++;
    };
  }, [deskBasePath, fileMentionQuery, fileMenuOpen, mentionTab]);

  useEffect(() => {
    if (fileSelected < mentionItems.length) return;
    setFileSelected(Math.max(0, mentionItems.length - 1));
  }, [mentionItems.length, fileSelected]);

  // Sync editor text to React state (drives hasInput / canSend) + slash menu detection + draft save
  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      const text = editor.getText();
      const parsed = parseSlashInput(text);
      if (
        parsed.name &&
        /\s$/.test(text) &&
        slashAutoInsertTextRef.current !== text
      ) {
        if (insertExactSkillSlash(editor.getText())) return;
      }
      setInputText(text);
      if (slashDismissedTextRef.current && slashDismissedTextRef.current !== text.trim()) {
        slashDismissedTextRef.current = null;
      }
      const slashMatches = getSlashMatches(text, slashCommands);
      const fileMention = findFileMentionRange(editor);
      if (fileMention) {
        setFileMentionRange(fileMention);
        setFileMentionQuery(fileMention.query);
        setFileMenuOpen(true);
        setFileSelected(0);
        setSlashMenuOpen(false);
      } else {
        setFileMenuOpen(false);
        setFileMentionRange(null);
        setFileMentionQuery('');
      }
      if (!fileMention && slashMatches.length > 0 && slashDismissedTextRef.current !== text.trim()) {
        setSlashMenuOpen(true);
        setSlashSelected(0);
      } else {
        setSlashMenuOpen(false);
      }
      //
      setDraft(currentSessionPath || '__new', text, editor.getJSON());
 // 内容超出可见区域时，自动滚动到光标位- requestAnimationFrame(() => editor.commands.scrollIntoView());
    };
    editor.on('update', handler);
    editor.on('selectionUpdate', handler);
    return () => {
      editor.off('update', handler);
      editor.off('selectionUpdate', handler);
    };
  }, [editor, currentSessionPath, setDraft, slashCommands, insertExactSkillSlash]);

  // Restore draft when switching sessions.
  useEffect(() => {
    if (!editor) return;
    const state = useStore.getState();
    const draftKey = currentSessionPath || '__new';
    const draft = sessionScopedValue(state, state.drafts, draftKey) || '';
    const document = sessionScopedValue(state, state.editorDrafts, draftKey);
    const current = editor.getText();
    if (document) {
      if (JSON.stringify(document) !== JSON.stringify(editor.getJSON())) {
        editor.commands.setContent(document, { emitUpdate: false });
      }
    } else if (draft !== current || ['fileBadge', 'skillBadge', 'sessionBadge', 'agentBadge', 'quickActionBadge'].some(name => editorHasInlineNode(editor, name))) {
      if (!draft) {
        editor.commands.setContent('', { emitUpdate: false });
      } else {
        editor.commands.setContent(buildPlainTextEditorDoc(draft), { emitUpdate: false });
      }
    }
    setInputText(draft);
    setFileMenuOpen(false);
    setFileMentionRange(null);
    setFileMentionQuery('');
  }, [editor, currentSessionPath]);

  useEffect(() => {
    const e2e = window.__GSAP_E2E__;
    if (!editor || !e2e) return;

    e2e.setInputText = (text: string) => {
      editor.commands.clearContent();
      if (text) editor.commands.insertContent(text);
      setInputText(text);
      return editor.getText();
    };
    e2e.getInputText = () => editor.getText();

    return () => {
      if (e2e.setInputText) delete e2e.setInputText;
      if (e2e.getInputText) delete e2e.getInputText;
    };
  }, [editor]);

 // 点击外部关闭斜杠菜单
  useEffect(() => {
    if (!slashMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (slashMenuRef.current?.contains(e.target as Node)) return;
      if (slashBtnRef.current?.contains(e.target as Node)) return;
      dismissSlashMenu();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dismissSlashMenu, slashMenuOpen]);

  //
  const hasContent = inputText.trim().length > 0 || attachedFiles.length > 0 || docContextAttached || quotedSelections.length > 0
    || editorHasInlineNode(editor, 'skillBadge')
    || editorHasInlineNode(editor, 'fileBadge')
    || editorHasInlineNode(editor, 'sessionBadge')
    || editorHasInlineNode(editor, 'agentBadge')
    || editorHasInlineNode(editor, 'quickActionBadge');
  const canSend = hasContent && (connected || !!activeChatVideoMode) && !isStreaming && !modelSwitching && !deletedAgentReadOnly;
  const queueBusy = isStreaming || queueWaitingForResponse;
  const queueStats = useMemo(() => ({
    pending: queuedMessages.filter(item => item.status === 'pending').length,
    running: queuedMessages.filter(item => item.status === 'running').length || (queueRunning && queueBusy ? 1 : 0),
    failed: queuedMessages.filter(item => item.status === 'failed').length,
    cancelled: queuedMessages.filter(item => item.status === 'cancelled').length,
  }), [queueBusy, queueRunning, queuedMessages]);
  const visibleQueuedMessages = useMemo(() => queuedMessages.slice(0, 4), [queuedMessages]);
  const hiddenQueuedMessageCount = Math.max(0, queuedMessages.length - visibleQueuedMessages.length);
  const canRunQueue = queuedMessages.some(item => item.status === 'pending') && connected && !queueBusy && !modelSwitching;

  // Paste attachments
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (deletedAgentReadOnly) {
      e.preventDefault();
      return;
    }
    const items = e.clipboardData?.items;
    if (!items) return;
    const pathItems: string[] = [];
    const nameMap: Record<string, string> = {};
    for (const item of Array.from(items)) {
      if (item.kind && item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      const filePath = window.platform?.getFilePath?.(file);
      if (!filePath) continue;
      pathItems.push(filePath);
      nameMap[filePath] = file.name;
    }
    if (pathItems.length > 0) {
      e.preventDefault();
      void Promise.resolve(attachFilesFromPaths(pathItems, nameMap)).catch((err) => {
        console.warn('[paste] attach clipboard file paths failed', err);
      });
      return;
    }

    for (const item of Array.from(items)) {
      if (!item.type.startsWith('image/')) continue;
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      void (async () => {
        try {
          const mimeType = file.type || item.type || 'image/png';
          const base64Data = await fileToBase64(file);
          const ext = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : (mimeType.split('/')[1] || 'png');
          const name = `${t('input.pastedImage')}.${ext}`;
          const uploadPayload = await prepareChatImageUpload({
            file,
            name,
            base64Data,
            mimeType,
          });
          const res = await gsapFetch('/api/upload-blob', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: uploadPayload.name,
              base64Data: uploadPayload.base64Data,
              mimeType: uploadPayload.mimeType,
              sessionPath: useStore.getState().currentSessionPath || undefined,
            }),
          });
          const data = await res.json();
          const upload = data?.uploads?.[0];
          if (upload?.dest) {
            addAttachedFile({ fileId: upload.fileId, path: upload.dest, name: upload.name || uploadPayload.name, isDirectory: false });
          } else {
            notifyPasteUploadFailure(t, upload?.error);
            console.warn('[paste] upload-blob failed', upload?.error || data);
          }
        } catch (err) {
          notifyPasteUploadFailure(t, err);
          console.warn('[paste] upload-blob error', err);
        }
      })();
      return;
    }

    const plainUrlPaste = extractPlainUrlPaste(e.clipboardData);
    if (plainUrlPaste && editor) {
      e.preventDefault();
      editor.commands.insertContent(plainUrlPaste);
    }
  }, [addAttachedFile, deletedAgentReadOnly, editor, t]);

  const handleBrowserFileInputChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    try {
      if (files.length === 0) return;
      const { paths, nameMap } = await resolveBrowserFilePaths(files);
      if (paths.length > 0) await attachFilesFromPaths(paths, nameMap);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useStore.getState().addToast?.(message, 'error', 6000);
    } finally {
      restoreEditorFocus();
    }
  }, [restoreEditorFocus]);

  const handleAttach = useCallback(async () => {
    if (deletedAgentReadOnly) return;
    if (surface === 'mobile') {
      browserFileInputRef.current?.click();
      return;
    }

    try {
      const paths = await window.platform?.selectFiles?.();
      if (paths && paths.length > 0) {
        await attachFilesFromPaths(paths);
        return;
      }

      if (!window.platform?.selectFiles) {
        browserFileInputRef.current?.click();
      }
    } finally {
      restoreEditorFocus();
    }
  }, [deletedAgentReadOnly, restoreEditorFocus, surface]);

  const showVoiceNotice = useCallback((text: string, type: 'success' | 'error' = 'error') => {
    window.dispatchEvent(new CustomEvent('gsap-inline-notice', {
      detail: { text, type },
    }));
  }, []);

  const stopMediaStream = useCallback(() => {
    for (const track of mediaStreamRef.current?.getTracks?.() || []) {
      track.stop();
    }
    mediaStreamRef.current = null;
  }, []);

  const insertTranscribedText = useCallback((text: string) => {
    const normalized = text.trim();
    if (!normalized || !editor) return false;
    const current = editor.getText().trim();
    editor.commands.insertContent(current ? ` ${normalized}` : normalized);
    editor.commands.focus();
    return true;
  }, [editor]);

  const startSelectedDeviceVoiceInput = useCallback(async (settings: ReturnType<typeof getVoiceSettings>) => {
    const recognitionInputDeviceId = settings.recognitionInputDeviceId.trim();
    if (!recognitionInputDeviceId) return false;
    if (!selectedVoiceInputSupported || typeof MediaRecorder === 'undefined') {
      showVoiceNotice(t('settings.media.voiceRecorderUnsupported'));
      return true;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: recognitionInputDeviceId } },
      });
      mediaStreamRef.current = stream;
      mediaChunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported?.('audio/webm') ? 'audio/webm' : '';
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      voiceRecordingModeRef.current = 'device';
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data?.size) mediaChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setVoiceRecording(false);
        voiceRecordingModeRef.current = null;
        mediaRecorderRef.current = null;
        stopMediaStream();
        showVoiceNotice(t('settings.media.voiceRecognitionFailed'));
      };
      recorder.onstop = async () => {
        const chunks = mediaChunksRef.current;
        mediaChunksRef.current = [];
        setVoiceRecording(false);
        voiceRecordingModeRef.current = null;
        mediaRecorderRef.current = null;
        stopMediaStream();
        const blob = new Blob(chunks, { type: mimeType || chunks[0]?.type || 'audio/webm' });
        if (!blob.size) {
          showVoiceNotice(t('settings.media.voiceNoSpeech'));
          return;
        }

        const formData = new FormData();
        formData.append('audio', blob, 'voice.webm');
        formData.append('lang', settings.recognitionLang || window.i18n?.locale || 'zh-CN');
        if (currentAgentId) formData.append('agentId', currentAgentId);
        if (currentSessionPath) formData.append('sessionPath', currentSessionPath);

        try {
          const res = await gsapFetch('/api/voice/transcribe', {
            method: 'POST',
            body: formData,
            timeout: 120000,
          });
          const data = await res.json();
          const text = String(data?.text || '').trim();
          if (!insertTranscribedText(text)) {
            showVoiceNotice(t('settings.media.voiceNoSpeech'));
          }
        } catch (err) {
          showVoiceNotice((err as Error)?.message || t('settings.media.voiceTranscriptionFailed'));
        }
      };
      recorder.start();
      setVoiceRecording(true);
    } catch (err) {
      setVoiceRecording(false);
      voiceRecordingModeRef.current = null;
      mediaRecorderRef.current = null;
      stopMediaStream();
      const name = (err as DOMException)?.name || '';
      showVoiceNotice(name === 'NotAllowedError'
        ? t('settings.media.voicePermissionDenied')
        : ((err as Error)?.message || t('settings.media.voiceRecognitionFailed')));
    }
    return true;
  }, [currentAgentId, currentSessionPath, insertTranscribedText, selectedVoiceInputSupported, setVoiceRecording, showVoiceNotice, stopMediaStream, t]);

  const handleVoiceInput = useCallback(() => {
    if (voiceRecording) {
      if (voiceRecordingModeRef.current === 'device' && mediaRecorderRef.current) {
        mediaRecorderRef.current.stop();
        return;
      }
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        return;
      }
    }

    const settings = getVoiceSettings();
    if (settings.recognitionInputDeviceId) {
      void startSelectedDeviceVoiceInput(settings);
      return;
    }

    const SpeechRecognitionCtor = getVoiceRecognitionCtor();
    if (!SpeechRecognitionCtor) {
      showVoiceNotice(t('settings.media.voiceNotSupported'));
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognitionRef.current = recognition;
    voiceRecordingModeRef.current = 'speech';
    recognition.lang = settings.recognitionLang || window.i18n?.locale || 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = false;

    const existingText = editor?.getText().trim() || '';
    let finalText = '';
    recognition.onstart = () => setVoiceRecording(true);
    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i]?.[0]?.transcript || '';
        if (event.results[i]?.isFinal) finalText += transcript;
        else interim += transcript;
      }
      const combined = `${finalText}${interim}`.trim();
      if (!combined || !editor) return;
      const merged = existingText ? `${existingText} ${combined}` : combined;
      editor.commands.setContent('');
      editor.commands.insertContent(merged);
      editor.commands.focus();
    };
    recognition.onerror = () => {
      setVoiceRecording(false);
      recognitionRef.current = null;
      voiceRecordingModeRef.current = null;
      showVoiceNotice(t('settings.media.voiceRecognitionFailed'));
    };
    recognition.onend = () => {
      setVoiceRecording(false);
      recognitionRef.current = null;
      voiceRecordingModeRef.current = null;
    };
    recognition.start();
  }, [editor, setVoiceRecording, showVoiceNotice, startSelectedDeviceVoiceInput, t, voiceRecording]);

  useEffect(() => () => {
    try { recognitionRef.current?.stop?.(); } catch {
      // Ignore cleanup failures from browsers that already ended recognition.
    }
    try { mediaRecorderRef.current?.stop?.(); } catch {
      // Ignore cleanup failures from already stopped recorders.
    }
    stopMediaStream();
    setVoiceRecording(false);
  }, [setVoiceRecording, stopMediaStream]);

  // ── Load thinking level once server port is ready + listen for plan mode sync ──
  const serverPort = useStore(s => s.serverPort);
  useEffect(() => {
    if (serverPort) {
      fetchConfig()
        .then(d => { if (d.thinking_level) setThinkingLevel(d.thinking_level as ThinkingLevel); })
        .catch((err: unknown) => console.warn('[InputArea] load config failed', err));
    }

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail.mode === 'auto' || detail.mode === 'operate' || detail.mode === 'ask' || detail.mode === 'read_only') {
        setPermissionMode(detail.mode);
      } else {
        setPermissionMode(detail.enabled ? 'read_only' : 'operate');
      }
    };
    window.addEventListener('gsap-plan-mode', handler);
    return () => window.removeEventListener('gsap-plan-mode', handler);
  }, [serverPort, setThinkingLevel]);

  // ── Handle slash selection (builtin vs skill) ──
  const handleSlashSelect = useCallback((item: SlashItem, args = '') => {
    slashDismissedTextRef.current = null;
    if (item.type === 'builtin') {
      item.execute(args);
      return;
    }
    if (!editor) return;
    editor.chain()
      .clearContent()
      .insertContent(buildSkillEditorContent(item.name, args))
      .focus()
      .run();
    setInputText(args.trim());
    setSlashMenuOpen(false);
  }, [editor]);

  const handleSlashMenuPick = useCallback((item: SlashItem) => {
    if (!editor) return;
    if (item.type === 'skill') {
      handleSlashSelect(item, parseSlashInput(editor.getText()).args);
      return;
    }

    const draft = buildSlashDraftText(item.name, editor.getText());
    editor.chain().clearContent().insertContent(draft).focus().run();
    setInputText(draft);
    slashDismissedTextRef.current = null;
    setSlashMenuOpen(false);
  }, [editor, handleSlashSelect]);

  // ── Send message ──
  const handleFileMentionSelect = useCallback((item: MentionMenuItem) => {
    if (!editor || !fileMentionRange) return;
    if (item.kind === 'agent' && serializeEditor(editor.getJSON()).agentMentions.length) {
      showSlashResult('每轮请选择一位辅助助手。', 'error'); return;
    }
    if (item.kind === 'agent' || item.kind === 'session') {
      editor.chain()
        .focus()
        .deleteRange({ from: fileMentionRange.from, to: fileMentionRange.to })
        .insertContent(item.kind === 'agent'
          ? { type: 'agentBadge', attrs: { agentId: item.agentId, label: item.name } }
          : { type: 'sessionBadge', attrs: { sessionId: item.sessionId, path: item.path, label: item.name } })
        .insertContent(' ')
        .run();
      setFileMenuOpen(false);
      setFileMentionRange(null);
      setFileMentionQuery('');
      return;
    }
    editor.chain()
      .focus()
      .deleteRange({ from: fileMentionRange.from, to: fileMentionRange.to })
      .insertContent({
        type: 'fileBadge',
        attrs: {
          fileId: item.fileId || null,
          path: item.path,
          name: item.name,
          isDirectory: !!item.isDirectory,
          mimeType: item.mimeType || null,
        },
      })
      .insertContent(' ')
      .run();
    setFileMenuOpen(false);
    setFileMentionRange(null);
    setFileMentionQuery('');
  }, [editor, fileMentionRange, showSlashResult]);

  const handleSend = useCallback(async () => {
    if (deletedAgentReadOnly) return;
    if (!editor) return;
    const editorJson = editor.getJSON();
    const { text: rawText, skills, fileRefs, ...references } = serializeEditor(editorJson);
    let text = rawText.trim();
    let selectedSkills = skills;

    const slashSelection = resolveSlashSubmitSelection({
      text,
      skills: selectedSkills,
      commands: slashCommands,
      selectedIndex: slashSelected,
      dismissedText: slashDismissedTextRef.current,
    });
    if (slashSelection) {
      const parsedSlash = parseSlashInput(text);
      const slashArgs = parsedSlash.args;
      if (slashSelection.type === 'skill' && parsedSlash.name === slashSelection.name && slashArgs.trim()) {
        selectedSkills = [slashSelection.name];
        text = slashArgs.trim();
      } else {
        handleSlashSelect(slashSelection, slashArgs);
        return;
      }
    }

    const inputFiles = mergeEditorFileRefs(attachedFiles, fileRefs);
    const draft = createPromptDraft(text, selectedSkills, inputFiles, references);
    if (!draft.text && draft.files.length === 0 && !draft.docContext && draft.quotedSelections.length === 0 && draft.skills.length === 0 && !draft.workspaceTool && !draft.quickAction && !draft.agentMentions.length && !draft.sessionRefs.length) return;

    if (activeChatVideoMode) {
      if (sending) return;
      if (modelSwitching) return;
      setSending(true);
      try {
        const ok = await submitChatVideoGeneration({ draft, mode: activeChatVideoMode });
        if (!ok) return;
        clearEditor();
        clearDraft(currentSessionPath || '__new');
        clearAttachedFiles();
        if (docContextAttached) setDocContextAttached(false);
        if (useStore.getState().quotedSelections.length > 0) useStore.getState().clearQuotedSelections();
      } finally {
        setSending(false);
      }
      return;
    }

    if (!connected) return;

    // Queue sends while the current turn is still being accepted or streamed.
    if (isStreaming || sending || queueWaitingForResponse) {
      enqueuePromptDraft(draft);
      setQueueRunning(true);
      return;
    }

    if (modelSwitching) return;
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setSending(true);

    try {
      const ok = await sendPromptDraft(draft);
      if (!ok) return;
      clearEditor();
      clearDraft(currentSessionPath || '__new');
      clearAttachedFiles();
      if (docContextAttached) setDocContextAttached(false);
      if (useStore.getState().quotedSelections.length > 0) useStore.getState().clearQuotedSelections();
    } finally {
      setSending(false);
    }
  }, [deletedAgentReadOnly, editor, attachedFiles, createPromptDraft, connected, isStreaming, sending, queueWaitingForResponse, docContextAttached, clearAttachedFiles, clearDraft, currentSessionPath, setDocContextAttached, slashCommands, slashSelected, handleSlashSelect, modelSwitching, clearEditor, enqueuePromptDraft, sendPromptDraft, activeChatVideoMode]);

  // ── Stop ──
  const handleStop = useCallback(() => {
    const ws = getWebSocket();
    if (!isStreaming || !ws) return;
    ws.send(JSON.stringify({ type: 'abort', sessionPath: useStore.getState().currentSessionPath }));
  }, [isStreaming]);

  const handleContinueDeletedAgent = useCallback(async () => {
    if (!currentSessionPath || continuingDeletedAgent) return;
    setContinuingDeletedAgent(true);
    try {
      await continueDeletedAgentSession(currentSessionPath);
    } finally {
      setContinuingDeletedAgent(false);
    }
  }, [continuingDeletedAgent, currentSessionPath]);

  // ── Key handler ──
  const handleEditorKeyDown = useCallback((e: InputKeyEvent): boolean => {
    if (e.defaultPrevented) return false;
    if (isComposing.current || e.isComposing || ('keyCode' in e && e.keyCode === 229)) return false;
    if (fileMenuOpen) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const tabs: MentionTab[] = ['files', 'sessions', 'agents'];
        const direction = e.key === 'ArrowRight' ? 1 : -1;
        handleMentionTabChange(tabs[(tabs.indexOf(mentionTab) + direction + tabs.length) % tabs.length]);
        return true;
      }
      if (e.key === 'ArrowDown' && mentionItems.length > 0) {
        e.preventDefault();
        setFileSelected(i => (i + 1) % mentionItems.length);
        return true;
      }
      if (e.key === 'ArrowUp' && mentionItems.length > 0) {
        e.preventDefault();
        setFileSelected(i => (i - 1 + mentionItems.length) % mentionItems.length);
        return true;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const item = mentionItems[fileSelected];
        if (item) handleFileMentionSelect(item);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setFileMenuOpen(false);
        return true;
      }
    }
    if (e.key === ' ' && !isComposing.current && editor && insertExactSkillSlash(editor.getText())) {
      e.preventDefault();
      return true;
    }
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSelected(i => (i + 1) % filteredCommands.length); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSelected(i => (i - 1 + filteredCommands.length) % filteredCommands.length); return true; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const cmd = filteredCommands[slashSelected];
        if (cmd) handleSlashSelect(cmd);
        return true;
      }
      if (e.key === 'Escape') { e.preventDefault(); dismissSlashMenu(); return true; }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !isComposing.current) {
      e.preventDefault();
      handleQueueAdd();
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey && !isComposing.current && !e.isComposing) {
      e.preventDefault();
      handleSend();
      return true;
    }
    return false;
  }, [
    dismissSlashMenu,
    fileMentionBusy,
    mentionItems,
    mentionTab,
    handleMentionTabChange,
    fileMenuOpen,
    fileSelected,
    filteredCommands,
    handleFileMentionSelect,
    handleQueueAdd,
    handleSend,
    handleSlashSelect,
    insertExactSkillSlash,
    editor,
    slashMenuOpen,
    slashSelected,
  ]);

  keyDownHandlerRef.current = handleEditorKeyDown as (event: KeyboardEvent) => boolean;
  beforeInputHandlerRef.current = (event: InputEvent): boolean => {
    if (surface !== 'mobile') return false;
    if (event.defaultPrevented) return false;
    if (event.inputType !== 'insertParagraph') return false;
    return handleEditorKeyDown({
      key: 'Enter',
      shiftKey: false,
      defaultPrevented: event.defaultPrevented,
      isComposing: event.isComposing,
      preventDefault: () => event.preventDefault(),
    });
  };

  const handleSlashResultClick = useCallback(() => {
    if (slashResult?.filePath) {
      window.platform?.openFile?.(slashResult.filePath);
      return;
    }
    if (slashResult?.deskDir) {
      toggleJianSidebar(true);
      loadDeskFiles('', slashResult.deskDir);
    }
  }, [slashResult?.deskDir, slashResult?.filePath]);

  return (
    <div
      className={`${styles['input-surface']}${surface === 'mobile' ? ` ${styles['input-surface-mobile']}` : ''}`}
    >
      <InputStatusBars
        slashBusy={slashBusy}
        slashBusyLabel={slashCommands.find(c => c.name === slashBusy)?.busyLabel || t('common.executing')}
        compacting={compacting}
        compactingLabel={t('chat.compacting')}
        screenshotBusy={screenshotBusy}
        screenshotLabel={t('common.screenshotInProgress')}
        screenshotPageLabel={screenshotProgress && screenshotProgress.totalPages > 0
          ? t('common.screenshotProgressPage', {
            current: screenshotProgress.currentPage,
            total: screenshotProgress.totalPages,
          })
          : null}
        screenshotProgress={screenshotProgress}
        inlineError={inlineError}
        slashResult={slashResult}
        onResultClick={slashResult?.deskDir || slashResult?.filePath ? handleSlashResultClick : undefined}
      />
      {(attachedFiles.length > 0 || quotedSelections.length > 0) && (
        <div className={styles['input-context-row']}>
          <div className={styles['input-context-left']}>
            {attachedFiles.length > 0 && <AttachedFilesBar files={attachedFiles} onRemove={removeAttachedFile} />}
            <QuotedSelectionCard />
          </div>
        </div>
      )}
      {queuedMessages.length > 0 && (
        <div className={styles['prompt-queue-panel']} data-prompt-queue-panel="">
          <div className={styles['prompt-queue-header']}>
            <div className={styles['prompt-queue-title']}>
              <span className={styles['prompt-queue-dot']} />
              <span>队列</span>
              <span className={styles['prompt-queue-count']}>{queuedMessages.length}</span>
              <span className={styles['prompt-queue-summary']}>
                {queueStats.running > 0 ? `执行中 ${queueStats.running}` : `待执行 ${queueStats.pending}`}
                {queueStats.failed > 0 ? ` · 失败 ${queueStats.failed}` : ''}
                {queueStats.cancelled > 0 ? ` · 已取消 ${queueStats.cancelled}` : ''}
              </span>
            </div>
            <div className={styles['prompt-queue-list']}>
              {visibleQueuedMessages.map((item, index) => (
                <div
                  key={item.id}
                  className={styles['prompt-queue-item']}
                  data-status={item.status}
                  draggable
                  onDragStart={() => handleQueueDragStart(item.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleQueueDrop(item.id)}
                >
                  <span className={styles['prompt-queue-index']}>{index + 1}</span>
                  <span className={styles['prompt-queue-text']} title={queuedPromptLabel(item)}>{queuedPromptLabel(item)}</span>
                  <span className={styles['prompt-queue-state']}>{queueStatusLabel(item)}</span>
                  {(item.status === 'failed' || item.status === 'cancelled') && (
                    <button
                      type="button"
                      className={styles['prompt-queue-icon-btn']}
                      onClick={() => retryQueuedMessage(item.id)}
                      title={item.status === 'cancelled' ? '恢复' : '重试'}
                    >
                      ↻
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${styles['prompt-queue-icon-btn']} ${styles['prompt-queue-delete']}`}
                    onClick={() => removeQueuedMessage(item.id)}
                    title="移除"
                  >
                    ×
                  </button>
                  {(item.error || item.cancelReason) && (
                    <span className={styles['prompt-queue-error']} title={item.error || item.cancelReason || ''}>!</span>
                  )}
                </div>
              ))}
              {hiddenQueuedMessageCount > 0 && (
                <div className={`${styles['prompt-queue-item']} ${styles['prompt-queue-overflow']}`}>
                  +{hiddenQueuedMessageCount}
                </div>
              )}
            </div>
            <div className={styles['prompt-queue-toolbar']}>
              {queueRunning && (
                <button
                  type="button"
                  className={styles['prompt-queue-clear']}
                  onClick={cancelQueueRun}
                  title="取消队列执行"
                >
                  取消
                </button>
              )}
              <button
                type="button"
                className={styles['prompt-queue-run']}
                disabled={!canRunQueue}
                onClick={handleQueueRun}
                title={queueRunning ? '队列执行中' : '执行队列'}
              >
                {queueRunning ? '执行中' : '执行'}
              </button>
              <button
                type="button"
                className={styles['prompt-queue-clear']}
                onClick={clearQueuedMessages}
                title="清空队列"
              >
                清空
              </button>
            </div>
          </div>
        </div>
      )}
      <div className={styles['slash-menu-anchor']} ref={slashMenuRef}>
        {slashMenuOpen && filteredCommands.length > 0 && (
          <SlashCommandMenu commands={filteredCommands} selected={slashSelected} busy={slashBusy}
            onSelect={handleSlashMenuPick} onHover={(i) => setSlashSelected(i)} />
        )}
      </div>
      <AnchoredPortal
        open={fileMenuOpen && visible}
        anchorRef={inputWrapperRef}
        align="start"
        offset={8}
        onClose={() => setFileMenuOpen(false)}
      >
          <MentionMenu
            tab={mentionTab}
            agents={agents}
            onTabChange={handleMentionTabChange}
            items={mentionItems}
            selected={fileSelected}
            busy={mentionTab === 'files' && fileMentionBusy}
            onSelect={handleFileMentionSelect}
            onHover={(i) => setFileSelected(i)}
          />
      </AnchoredPortal>
      <div className={styles['input-stack']}>
        {capabilityDrift && !capabilityRefreshing && !visibleSessionConfirmation && currentSessionPath && (
          <CapabilityDriftNotice
            sessionPath={currentSessionPath}
            drift={capabilityDrift}
          />
        )}
        {visibleSessionConfirmation && (
          <SessionConfirmationPrompt
            block={visibleSessionConfirmation}
            exiting={sessionConfirmationExiting}
          />
        )}
        <div className={`${styles['input-wrapper']} input-wrapper`} ref={setInputWrapperRef} onMouseDown={focusEditorFromInputShell}>
          <input
            ref={browserFileInputRef}
            className={styles['browser-file-input']}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/gif,image/webp"
            disabled={deletedAgentReadOnly}
            onChange={handleBrowserFileInputChange}
          />
        {deletedAgentReadOnly && (
          <div className={styles['deleted-agent-readonly']} data-no-input-focus>
            <div className={styles['deleted-agent-copy']}>
              <strong>{t('session.deletedAgent.title')}</strong>
              <span>{t('session.deletedAgent.description')}</span>
              {currentSessionProjection?.agentName && (
                <small>{t('session.deletedAgent.meta', { name: currentSessionProjection.agentName })}</small>
              )}
            </div>
            <button
              type="button"
              className={styles['deleted-agent-continue']}
              onClick={handleContinueDeletedAgent}
              disabled={continuingDeletedAgent}
            >
              {continuingDeletedAgent ? t('session.deletedAgent.continuing') : t('session.deletedAgent.continueButton')}
            </button>
          </div>
        )}
        {workspaceTool && (
          <div className={styles['workspace-tool-chip']} data-workspace-tool-chip data-no-input-focus>
            <span className={styles['workspace-tool-chip-kicker']}>工具</span>
            <span className={styles['workspace-tool-chip-title']}>{workspaceTool?.title}</span>
            <button
              type="button"
              className={styles['workspace-tool-chip-close']}
              onClick={() => setWorkspaceTool(null)}
              aria-label="关闭当前工作区工具"
              title="关闭当前工作区工具"
            >
              ×
            </button>
          </div>
        )}
        <div
          id="inputBox"
          className={styles['input-box']}
          onKeyDown={(event) => {
            if (!event.defaultPrevented) handleEditorKeyDown(event);
          }}
          onPaste={handlePaste}
          onCompositionStart={() => { isComposing.current = true; }}
          onCompositionEnd={() => { isComposing.current = false; }}
        >
          <EditorContent editor={editor} />
        </div>
        <div className={styles['input-bottom-bar']}>
          <div className={styles['input-actions']}>
            <InputUtilityButtons
              t={t}
              onAttach={handleAttach}
              attachDisabled={deletedAgentReadOnly}
              mobileCommands={surface === 'mobile' ? {
                open: slashMenuOpen,
                buttonRef: slashBtnRef,
                onToggle: () => {
                  if (slashMenuOpen) dismissSlashMenu();
                  else {
                    slashDismissedTextRef.current = null;
                    setSlashMenuOpen(true);
                  }
                },
              } : undefined}
              onBeforeOpenSkills={() => {
                dismissSlashMenu();
                setWorkspaceToolMenuOpen(false);
              }}
            />
            <div ref={workspaceToolMenuRef} className={styles['workspace-tool-menu-wrap']} data-no-input-focus>
              <button
                type="button"
                className={`${styles['workspace-tool-menu-button']}${workspaceTool ? ` ${styles['workspace-tool-menu-button-active']}` : ''}`}
                title={workspaceTool ? `当前工具：${workspaceTool.title}` : '选择工具'}
                aria-label={workspaceTool ? `当前工具：${workspaceTool.title}` : '选择工具'}
                aria-haspopup="menu"
                aria-expanded={workspaceToolMenuOpen}
                data-testid="workspace-tool-menu-button"
                onClick={() => setWorkspaceToolMenuOpen(open => !open)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 7h16" />
                  <path d="M4 12h10" />
                  <path d="M4 17h7" />
                  <path d="m16 16 2 2 3-4" />
                </svg>
                <span>{workspaceTool?.title || '工具'}</span>
              </button>
              <AnchoredPortal
                open={visible && workspaceToolMenuOpen}
                anchorRef={workspaceToolMenuRef}
                align="start"
                offset={8}
                viewportPadding={8}
                onClose={() => setWorkspaceToolMenuOpen(false)}
                className={styles['workspace-tool-menu']}
                role="menu"
              >
                  <button
                    type="button"
                    className={`${styles['workspace-tool-menu-item']}${!workspaceTool ? ` ${styles['workspace-tool-menu-item-active']}` : ''}`}
                    role="menuitemradio"
                    aria-checked={!workspaceTool}
                    onClick={() => handleWorkspaceToolPick(null)}
                  >
                    <span>不使用工具</span>
                    <small>普通聊天</small>
                  </button>
                  {WORKSPACE_TOOL_OPTIONS.map(tool => {
                    const active = workspaceTool?.id === tool.id;
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        className={`${styles['workspace-tool-menu-item']}${active ? ` ${styles['workspace-tool-menu-item-active']}` : ''}`}
                        role="menuitemradio"
                        aria-checked={active}
                        onClick={() => handleWorkspaceToolPick(tool)}
                      >
                        <span>{tool.title}</span>
                        <small>{tool.description}</small>
                      </button>
                    );
                  })}
              </AnchoredPortal>
            </div>
            {voiceInputSupported && (
              <button type="button"
                className={`${styles['attach-btn']} ${styles['voice-btn']}${voiceRecording ? ` ${styles['voice-btn-active']}` : ''}`}
                title={t(voiceRecording ? 'settings.media.stopRecording' : 'settings.media.startRecording')}
                onClick={handleVoiceInput}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="2" width="6" height="12" rx="3" />
                  <path d="M5 10a7 7 0 0 0 14 0" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                  <line x1="8" y1="22" x2="16" y2="22" />
                </svg>
              </button>
            )}
            <PlanModeButton mode={permissionMode} onChange={setPermissionMode} locked={deletedAgentReadOnly} />
            {hasDoc && <DocContextButton active={docContextAttached} disabled={deletedAgentReadOnly} onToggle={toggleDocContext} />}
            <ContextRing />
          </div>
          <div className={styles['input-controls']}>
            <button
              type="button"
              className={`${styles['attach-btn']} ${styles['prompt-optimize-btn']}`}
              title={t('input.researchMode')}
              aria-label={t('input.researchMode')}
              aria-busy={researching}
              data-testid="research-mode-button"
              disabled={deletedAgentReadOnly || researching || promptOptimizing || !inputText.trim()}
              onClick={handleResearchPrompt}
            >
              {researching ? (
                <span className={styles['prompt-optimize-spinner']} />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.5-3.5" />
                  <path d="M8.5 11h5" />
                  <path d="M11 8.5v5" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className={`${styles['attach-btn']} ${styles['prompt-optimize-btn']}`}
              title={t('input.promptOptimize')}
              aria-label={t('input.promptOptimize')}
              aria-busy={promptOptimizing}
              data-testid="prompt-optimize-button"
              disabled={deletedAgentReadOnly || promptOptimizing || researching || !inputText.trim()}
              onClick={handleOptimizePrompt}
            >
              {promptOptimizing ? (
                <span className={styles['prompt-optimize-spinner']} />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 4l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z" />
                  <path d="M8 12l.7 2.1L11 15l-2.3.9L8 18l-.7-2.1L5 15l2.3-.9L8 12Z" />
                  <path d="M18 15l.5 1.5L20 17l-1.5.5L18 19l-.5-1.5L16 17l1.5-.5L18 15Z" />
                </svg>
              )}
            </button>
            {!activeChatVideoMode && showThinkingControl && (
              <ThinkingLevelButton level={thinkingLevel} onChange={setThinkingLevel} availableLevels={availableThinkingLevels} />
            )}
            <ModelSelector
              models={models}
              sessionModel={sessionModel}
              isStreaming={isStreaming}
              activeChatVideoMode={activeChatVideoMode}
              onChatVideoModeChange={setActiveChatVideoMode}
            />
            <SendButton isStreaming={isStreaming} hasInput={hasContent}
              disabled={deletedAgentReadOnly || (isStreaming ? false : !canSend)} onSend={handleSend} onStop={handleStop} />
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
