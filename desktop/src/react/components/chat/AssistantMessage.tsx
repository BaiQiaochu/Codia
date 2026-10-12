import { Component, memo, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { ImageSquare, Sparkle, VideoCamera } from '@phosphor-icons/react';
import { StreamingMarkdownContent } from './StreamingMarkdownContent';
import { MoodBlock } from './MoodBlock';
import { InvokeBlock } from './InvokeBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolGroupBlock } from './ToolGroupBlock';
import { PluginCardBlock } from './PluginCardBlock';
import { SubagentCard } from './SubagentCard';
import { SettingsConfirmCard } from './SettingsConfirmCard';
import { SettingsUpdateCard } from './SettingsUpdateCard';
import { WorkflowInlineCard } from './WorkflowInlineCard';
import { InterludeBlock } from './InterludeBlock';
import { InteractiveCard } from './InteractiveCard';
import { useMessageFooterActions } from './MessageActions';
import { MessageFooterActions, formatMessageTime, type MessageFooterAction } from './MessageFooterActions';
import { ChatResourceCard } from './ChatResourceCard';
import { SkillResourceIcon } from './ChatResourceIcons';
import { BLOCK_RENDERERS } from './block-renderers';
import { FileOutputActions } from './FileOutputActions';
import type { ChatMessage, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { sessionScopedValue } from '../../stores/session-slice';
import { selectSessionFiles } from '../../stores/selectors/file-refs';
import { codiaFetch, codiaUrl } from '../../hooks/use-codia-fetch';
import { openFilePreview, openSkillPreview } from '../../utils/file-preview';
import { writeAppFileDragPayload, clearAppFileDragPayload } from '../../utils/app-file-drag';
import { openMediaViewerForRef } from '../../utils/open-media-viewer';
import { buildFileRefId, inferKindByExt, isImageOrSvgExt } from '../../utils/file-kind';
import { resolveServerConnection } from '../../services/server-connection';
import { resolveFileRefNativePath, resolveFileRefUrl, resolveFileRefUrls } from '../../services/resource-url';
import type { FileRef } from '../../types/file-ref';
import { openPreview } from '../../stores/preview-actions';
import { selectIsStreamingSession, selectSelectedIdsBySession } from '../../stores/session-selectors';
import { serializeChatMessageForCopy } from '../../utils/chat-copy';
import { extractTextBlockPlainText } from '../../utils/message-text';
import { writeClipboardText } from '../../utils/clipboard';
import { getVoiceSettings } from '../../utils/voice';
import { yuanFallbackAvatar } from '../../utils/agent-helpers';
import { replayLatestUserMessage } from '../../stores/message-turn-actions';
import styles from './Chat.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

const lazyScreenshot = () => import('../../utils/screenshot').then(m => m.takeScreenshot);
const WIDE_PLUGIN_CARD_IDS = new Set(['knowledge-graph', 'mind-map']);

function textWithFallback(key: string, fallback: string): string {
  const value = window.t?.(key);
  return value && value !== key ? value : fallback;
}

interface BlockRenderBoundaryProps {
  messageId: string;
  blockIdx: number;
  blockType: string;
  children: ReactNode;
}

interface BlockRenderBoundaryState {
  error: Error | null;
  renderKey: string;
}

class BlockRenderBoundary extends Component<BlockRenderBoundaryProps, BlockRenderBoundaryState> {
  state: BlockRenderBoundaryState = {
    error: null,
    renderKey: this.keyFromProps(this.props),
  };

  static getDerivedStateFromError(error: Error): Partial<BlockRenderBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: BlockRenderBoundaryProps, state: BlockRenderBoundaryState): Partial<BlockRenderBoundaryState> | null {
    const renderKey = `${props.messageId}:${props.blockIdx}:${props.blockType}`;
    if (renderKey !== state.renderKey) {
      return { error: null, renderKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[AssistantMessage:block]', {
      messageId: this.props.messageId,
      blockIdx: this.props.blockIdx,
      blockType: this.props.blockType,
      error,
      componentStack: info.componentStack,
    });
  }

  private keyFromProps(props: BlockRenderBoundaryProps): string {
    return `${props.messageId}:${props.blockIdx}:${props.blockType}`;
  }

  render() {
    if (this.state.error) {
      return (
        <div className={styles.blockRenderFallback} role="status">
          {textWithFallback('chat.blockUnavailable', '内容块暂时不可用')}
        </div>
      );
    }
    return this.props.children;
  }
}

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
  sessionPath: string;
  agentId?: string | null;
  readOnly?: boolean;
  isLatestAssistantMessage?: boolean;
  showTurnCompletionTime?: boolean;
  assistantTurnSelectionIds?: readonly string[];
  retrySourceMessage?: ChatMessage | null;
  messageRef?: (element: HTMLDivElement | null) => void;
}

function isContentBlockCandidate(block: unknown): block is ContentBlock {
  return !!block && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string';
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  showAvatar,
  sessionPath,
  agentId,
  readOnly = false,
  isLatestAssistantMessage = false,
  showTurnCompletionTime,
  assistantTurnSelectionIds,
  retrySourceMessage = null,
  messageRef,
}: Props) {
  const agents = useStore(s => s.agents);
  const globalAgentName = useStore(s => s.agentName) || '助手';
  const globalYuan = useStore(s => s.agentYuan) || 'codia';
  const isStreaming = useStore(s => selectIsStreamingSession(s, sessionPath));
  const selectedIds = useStore(s => selectSelectedIdsBySession(s, sessionPath));
  const isSelected = selectedIds.includes(message.id);
  const t = useCallback((p: string) => (window.t ?? ((value: string) => value))(p), []);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const agent = agentId ? agents.find(a => a.id === agentId) : null;
  const displayName = agent?.name || globalAgentName;
  const displayYuan = agent?.yuan || globalYuan;
  const fallbackAvatar = useMemo(() => yuanFallbackAvatar(displayYuan), [displayYuan]);
  const avatarSrc = (agent?.hasAvatar && agentId)
    ? codiaUrl(`/api/agents/${agentId}/avatar?t=${agentId}`, { includeTokenQuery: true })
    : fallbackAvatar;

  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarSrc, fallbackAvatar]);

  const blocks = useMemo(
    () => (Array.isArray(message.blocks) ? message.blocks : [])
      .filter(isContentBlockCandidate)
      .filter(block => block.type !== 'session_confirmation' || block.surface !== 'input'),
    [message.blocks],
  );
  const isInterludeOnly = blocks.length > 0 && blocks.every(block => block.type === 'interlude');
  const hasWidePluginCard = useMemo(
    () => blocks.some(block => block.type === 'plugin_card' && WIDE_PLUGIN_CARD_IDS.has(block.card?.pluginId || '')),
    [blocks],
  );
  const hasWideBlock = hasWidePluginCard || blocks.some(block => block.type === 'interactive_card');
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const setVoiceSpeakingMessageId = useStore(s => s.setVoiceSpeakingMessageId);

  const handleCopy = useCallback(() => {
    const state = useStore.getState();
    const ids = selectSelectedIdsBySession(state, sessionPath);

    if (ids.length > 0) {
      const session = sessionScopedValue(state, state.chatSessions, sessionPath);
      if (!session) return;
      const texts: string[] = [];
      for (const item of session.items) {
        if (item.type !== 'message') continue;
        if (!ids.includes(item.data.id)) continue;
        const text = serializeChatMessageForCopy(item.data);
        if (text) texts.push(text);
      }
      writeClipboardText(texts.join('\n\n')).then((ok) => {
        if (!ok) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
      return;
    }

    const text = serializeChatMessageForCopy(message);
    if (!text) return;
    writeClipboardText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [message, sessionPath]);

  const handleScreenshot = useCallback(async () => {
    const fn = await lazyScreenshot();
    fn(message.id, sessionPath);
  }, [message.id, sessionPath]);

  const handleRegenerate = useCallback(async () => {
    if (!retrySourceMessage || retrying || isStreaming) return;
    setRetrying(true);
    try {
      await replayLatestUserMessage(sessionPath, retrySourceMessage);
    } finally {
      setRetrying(false);
    }
  }, [isStreaming, retrying, retrySourceMessage, sessionPath]);

  const handleSpeak = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const textBlocks = blocks.filter(
      (block): block is ContentBlock & { type: 'text' } => block.type === 'text',
    );
    if (textBlocks.length === 0) return;

    const text = extractTextBlockPlainText(textBlocks);
    if (!text) return;

    const currentId = useStore.getState().voiceSpeakingMessageId;
    if (currentId === message.id) {
      window.speechSynthesis.cancel();
      setVoiceSpeakingMessageId(null);
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voiceSettings = getVoiceSettings();
    utterance.lang = voiceSettings.recognitionLang || (window.i18n?.locale || 'zh-CN');
    utterance.rate = voiceSettings.synthesisRate || 1;
    utterance.pitch = voiceSettings.synthesisPitch || 1;
    utterance.volume = voiceSettings.synthesisVolume || 1;
    if (voiceSettings.synthesisVoiceUri) {
      const voice = window.speechSynthesis.getVoices().find(v => v.voiceURI === voiceSettings.synthesisVoiceUri);
      if (voice) utterance.voice = voice;
    }
    utterance.onend = () => {
      if (useStore.getState().voiceSpeakingMessageId === message.id) {
        setVoiceSpeakingMessageId(null);
      }
    };
    utterance.onerror = () => {
      if (useStore.getState().voiceSpeakingMessageId === message.id) {
        setVoiceSpeakingMessageId(null);
      }
    };
    setVoiceSpeakingMessageId(message.id);
    window.speechSynthesis.speak(utterance);
  }, [blocks, message.id, setVoiceSpeakingMessageId]);

  useEffect(() => () => {
    if (useStore.getState().voiceSpeakingMessageId === message.id) {
      window.speechSynthesis?.cancel?.();
      setVoiceSpeakingMessageId(null);
    }
  }, [message.id, setVoiceSpeakingMessageId]);

  const canShowRegenerateAction = !readOnly && isLatestAssistantMessage && !!retrySourceMessage && !isStreaming;
  const shouldShowCompletionTime = showTurnCompletionTime ?? isLatestAssistantMessage;
  const shouldPersistCompletionTime = shouldShowCompletionTime && isLatestAssistantMessage && !isStreaming;
  const timeText = shouldShowCompletionTime ? formatMessageTime(message.timestamp) : null;
  const standardMessageActions = useMessageFooterActions({
    messageId: message.id,
    selectionIds: assistantTurnSelectionIds,
    sessionPath,
    onCopy: handleCopy,
    onScreenshot: () => { void handleScreenshot(); },
    onSpeak: (typeof window !== 'undefined' && 'speechSynthesis' in window) ? handleSpeak : undefined,
    copied,
    isStreaming,
  });
  const messageActions = readOnly ? [] : standardMessageActions;
  const regenerateActions: MessageFooterAction[] = useMemo(() => [
    {
      id: 'regenerate',
      title: t('common.regenerate'),
      icon: <RegenerateIcon />,
      onClick: () => { void handleRegenerate(); },
      disabled: retrying || isStreaming,
    },
  ], [handleRegenerate, isStreaming, retrying, t]);
  const footerActions = canShowRegenerateAction ? regenerateActions : [];

  return (
    <div
      className={`${styles.messageGroup} ${styles.messageGroupAssistant}${hasWideBlock ? ` ${styles.messageGroupWide}` : ''}${isInterludeOnly ? ` ${styles.messageGroupInterludeOnly}` : ''}${isSelected ? ` ${styles.messageGroupSelected}` : ''}`}
      ref={messageRef}
      data-message-id={message.id}
    >
      {showAvatar && !isInterludeOnly && (
        <div className={styles.avatarRow}>
          {!avatarFailed ? (
            <img
              className={`${styles.avatar} ${styles.codiaAvatar}`}
              src={avatarSrc}
              alt={displayName}
              draggable={false}
              onError={(event) => {
                const img = event.target as HTMLImageElement;
                if (img.src.endsWith(fallbackAvatar)) {
                  img.onerror = null;
                  setAvatarFailed(true);
                  return;
                }
                img.onerror = null;
                img.src = fallbackAvatar;
              }}
            />
          ) : (
            <span className={`${styles.avatar} ${styles.userAvatar}`}>&#9881;</span>
          )}
          <span className={styles.avatarName}>{displayName}</span>
        </div>
      )}
      <div className={`${styles.message} ${styles.messageAssistant}${hasWideBlock ? ` ${styles.messageWide}` : ''}${isInterludeOnly ? ` ${styles.messageAssistantInterludeOnly}` : ''}`}>
        {blocks.map((block, index) => (
          <BlockRenderBoundary
            key={`block-${index}`}
            messageId={message.id}
            blockIdx={index}
            blockType={block.type}
          >
            <ContentBlockView
              block={block}
              agentName={displayName}
              agentId={agentId}
              yuan={displayYuan}
              sessionPath={sessionPath}
              messageId={message.id}
              blockIdx={index}
              isStreaming={isStreaming}
            />
          </BlockRenderBoundary>
        ))}
      </div>
      {!isInterludeOnly && (timeText || footerActions.length > 0 || messageActions.length > 0) && (
        <MessageFooterActions
          align="left"
          timeText={timeText}
          timePersistent={shouldPersistCompletionTime}
          leadingActions={footerActions}
          actions={messageActions}
          testId="assistant-completion-actions"
        />
      )}
    </div>
  );
});

function RegenerateIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 3v5m0 0h-5m5 0-3-2.708A9 9 0 1 0 20.777 14" />
    </svg>
  );
}

export const ContentBlockView = memo(function ContentBlockView({ block, agentName, agentId, yuan: _yuan, sessionPath, messageId, blockIdx, isStreaming }: {
  block: ContentBlock;
  agentName: string;
  agentId?: string | null;
  yuan: string;
  sessionPath: string;
  messageId: string;
  blockIdx: number;
  isStreaming: boolean;
}) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock content={block.content} sealed={block.sealed} />;
    case 'mood':
      return <MoodBlock yuan={block.yuan} text={block.text} />;
    case 'invoke':
      return <InvokeBlock name={block.name} content={block.content} />;
    case 'tool_group':
      return <ToolGroupBlock tools={block.tools} collapsed={block.collapsed} agentName={agentName} />;
    case 'text':
      return <StreamingMarkdownContent html={block.html} source={block.source} active={isStreaming} />;
    case 'file':
      return (
        <FileBlock
          block={block}
          sessionPath={sessionPath}
          messageId={messageId}
          blockIdx={blockIdx}
        />
      );
    case 'screenshot':
      return (
        <ScreenshotBlock
          block={block}
          sessionPath={sessionPath}
          messageId={messageId}
          blockIdx={blockIdx}
        />
      );
    case 'media_generation':
      return <MediaGenerationBlock block={block} />;
    case 'workflow':
      return <WorkflowInlineCard block={block} />;
    case 'interlude':
      return <InterludeBlock block={block} />;
    default: {
      const Renderer = BLOCK_RENDERERS[block.type];
      return Renderer ? <Renderer block={block} agentId={agentId} /> : null;
    }
  }
});

const EXT_LABELS: Record<string, string> = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel',
  ppt: 'Presentation', pptx: 'Presentation', md: 'Markdown', txt: 'Text',
  html: 'HTML', htm: 'HTML', css: 'Stylesheet', json: 'JSON', yaml: 'YAML', yml: 'YAML',
  js: 'JavaScript', ts: 'TypeScript', jsx: 'React', tsx: 'React',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', rb: 'Ruby', php: 'PHP',
  c: 'C', cpp: 'C++', h: 'Header', sh: 'Shell', sql: 'SQL', xml: 'XML',
  csv: 'CSV', svg: 'SVG', skill: 'Skill',
  png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', webp: 'Image',
  mp4: 'Video', webm: 'Video', mov: 'Video', m4v: 'Video', mkv: 'Video',
  mp3: 'Audio', wav: 'Audio', ogg: 'Audio', flac: 'Audio', m4a: 'Audio', aac: 'Audio',
};

const MediaGenerationBlock = memo(function MediaGenerationBlock({ block }: { block: Extract<ContentBlock, { type: 'media_generation' }> }) {
  const failed = block.status === 'failed' || block.status === 'aborted';
  const isVideo = block.kind === 'video';
  const kindLabel = isVideo ? 'Video' : 'Image';
  const titleText = failed
    ? textWithFallback(
      isVideo ? 'chat.mediaGenerationStatus.videoFailed' : 'chat.mediaGenerationStatus.imageFailed',
      `${kindLabel} generation failed`,
    )
    : textWithFallback(
      isVideo ? 'chat.mediaGenerationStatus.creatingVideo' : 'chat.mediaGenerationStatus.creatingImage',
      `Creating ${kindLabel.toLowerCase()}`,
    );
  const detail = failed
    ? (typeof block.reason === 'string' ? block.reason : '')
    : (typeof block.prompt === 'string' ? block.prompt : '');
  const GenerationIcon = isVideo ? VideoCamera : ImageSquare;

  return (
    <div
      className={`${styles.mediaGenerationCard}${failed ? ` ${styles.mediaGenerationCardFailed}` : ''}`}
      aria-busy={!failed}
    >
      <div className={styles.mediaGenerationSurface}>
        {!failed && <div className={styles.mediaGenerationFlow} aria-hidden="true" />}
        <div className={styles.mediaGenerationVisual} aria-hidden="true">
          <div className={styles.mediaGenerationHalo} />
          <div className={styles.mediaGenerationIconShell}>
            <GenerationIcon size={26} weight="duotone" />
          </div>
          {!failed && (
            <>
              <Sparkle className={`${styles.mediaGenerationSparkle} ${styles.mediaGenerationSparklePrimary}`} size={15} weight="fill" />
              <Sparkle className={`${styles.mediaGenerationSparkle} ${styles.mediaGenerationSparkleSecondary}`} size={9} weight="fill" />
            </>
          )}
        </div>
        <div className={styles.mediaGenerationText}>
          <div
            className={styles.mediaGenerationTitle}
            role="status"
            aria-live="polite"
            aria-label={failed ? titleText : `${kindLabel} generation...`}
          >
            <span>{titleText}</span>
          </div>
          {detail && (
            <div className={styles.mediaGenerationPrompt} title={detail}>{detail}</div>
          )}
          {!failed && (
            <div className={styles.mediaGenerationProgress} aria-hidden="true">
              <span />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

interface FileBlockCtx {
  sessionPath: string;
  messageId: string;
  blockIdx: number;
}

function fileDisplayName(filePath: string, label?: string): string {
  return label || filePath.split(/[\\/]/).pop() || filePath;
}

function tWithFallback(key: string, fallback: string): string {
  const value = window.t?.(key);
  return value && value !== key ? value : fallback;
}

function findSessionFileRef(files: readonly FileRef[], fileId: string | undefined, filePath: string): FileRef | undefined {
  return files.find(file => (fileId && file.fileId === fileId) || file.path === filePath);
}

function buildFallbackSessionFileRef({
  fileId,
  filePath,
  label,
  ext,
  kind,
  ctx,
}: {
  fileId?: string;
  filePath: string;
  label: string;
  ext: string;
  kind: FileRef['kind'];
  ctx: FileBlockCtx;
}): FileRef {
  return {
    id: buildFileRefId({
      source: 'session-block-file',
      sessionPath: ctx.sessionPath,
      messageId: ctx.messageId,
      blockIdx: ctx.blockIdx,
      path: filePath,
    }),
    fileId,
    kind,
    source: 'session-block-file',
    name: label,
    path: filePath,
    ext,
    sessionMessageId: ctx.messageId,
    sessionBlockIdx: ctx.blockIdx,
  };
}

function useResolvedSessionFileUrl({
  fileId,
  filePath,
  label,
  ext,
  kind,
  ctx,
  preferLocalFile = true,
}: {
  fileId?: string;
  filePath: string;
  label: string;
  ext: string;
  kind: FileRef['kind'];
  ctx: FileBlockCtx;
  preferLocalFile?: boolean;
}): string {
  return useStore(useCallback((state) => {
    const files = selectSessionFiles(state, ctx.sessionPath);
    const ref = findSessionFileRef(files, fileId, filePath)
      ?? buildFallbackSessionFileRef({ fileId, filePath, label, ext, kind, ctx });
    try {
      return resolveFileRefUrl(ref, {
        connection: resolveServerConnection(state),
        platform: typeof window !== 'undefined' ? window.platform : null,
        preferLocalFile,
        resourceContentUrl: codiaUrl,
      }).url;
    } catch {
      return '';
    }
  }, [ctx, ext, fileId, filePath, kind, label, preferLocalFile]));
}

const FILE_URL_LIST_SEPARATOR = '\u0000';

function useResolvedSessionFileUrls({
  fileId,
  filePath,
  label,
  ext,
  kind,
  ctx,
}: {
  fileId?: string;
  filePath: string;
  label: string;
  ext: string;
  kind: FileRef['kind'];
  ctx: FileBlockCtx;
}): string[] {
  const serialized = useStore(useCallback((state) => {
    const files = selectSessionFiles(state, ctx.sessionPath);
    const ref = findSessionFileRef(files, fileId, filePath)
      ?? buildFallbackSessionFileRef({ fileId, filePath, label, ext, kind, ctx });
    try {
      return resolveFileRefUrls(ref, {
        connection: resolveServerConnection(state),
        platform: typeof window !== 'undefined' ? window.platform : null,
        preferLocalFile: false,
        resourceContentUrl: codiaUrl,
      }).map(result => result.url).join(FILE_URL_LIST_SEPARATOR);
    } catch {
      return '';
    }
  }, [ctx, ext, fileId, filePath, kind, label]));
  return useMemo(
    () => serialized ? serialized.split(FILE_URL_LIST_SEPARATOR).filter(Boolean) : [],
    [serialized],
  );
}

function useSessionFileNativePath({
  fileId,
  filePath,
  label,
  ext,
  kind,
  ctx,
}: {
  fileId?: string;
  filePath: string;
  label: string;
  ext: string;
  kind: FileRef['kind'];
  ctx: FileBlockCtx;
}): string | null {
  return useStore(useCallback((state) => {
    const files = selectSessionFiles(state, ctx.sessionPath);
    const ref = findSessionFileRef(files, fileId, filePath)
      ?? buildFallbackSessionFileRef({ fileId, filePath, label, ext, kind, ctx });
    return resolveFileRefNativePath(ref, resolveServerConnection(state));
  }, [ctx, ext, fileId, filePath, kind, label]));
}

function useSessionFileDownloadUrl({
  fileId,
  filePath,
  label,
  ext,
  kind,
  ctx,
}: {
  fileId?: string;
  filePath: string;
  label: string;
  ext: string;
  kind: FileRef['kind'];
  ctx: FileBlockCtx;
}): string | null {
  return useStore(useCallback((state) => {
    const files = selectSessionFiles(state, ctx.sessionPath);
    const ref = findSessionFileRef(files, fileId, filePath)
      ?? buildFallbackSessionFileRef({ fileId, filePath, label, ext, kind, ctx });
    if (ref.status === 'expired') return null;
    try {
      const resolved = resolveFileRefUrl(ref, {
        connection: resolveServerConnection(state),
        platform: typeof window !== 'undefined' ? window.platform : null,
        preferLocalFile: false,
        resourceContentUrl: codiaUrl,
      });
      if (resolved.mode === 'local-file') return null;
      return resolved.url;
    } catch {
      return null;
    }
  }, [ctx, ext, fileId, filePath, kind, label]));
}

function DownloadGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

const IMAGE_OUTPUT_ZOOM_MIN = 0.5;
const IMAGE_OUTPUT_ZOOM_MAX = 4;
const IMAGE_OUTPUT_ZOOM_STEP = 1.2;

function clampImageOutputScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(IMAGE_OUTPUT_ZOOM_MAX, Math.max(IMAGE_OUTPUT_ZOOM_MIN, value));
}

const ImageOutputCard = memo(function ImageOutputCard({ fileId, filePath, label, ext, status, ctx }: {
  fileId?: string;
  filePath: string;
  label: string;
  ext: string;
  status?: string;
  ctx: FileBlockCtx;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sourceIndex, setSourceIndex] = useState(0);
  const displayName = fileDisplayName(filePath, label);
  const kind = ext.toLowerCase() === 'svg' ? 'svg' : 'image';
  const imageUrls = useResolvedSessionFileUrls({ fileId, filePath, label: displayName, ext, kind, ctx });
  const imageUrlsKey = imageUrls.join(FILE_URL_LIST_SEPARATOR);
  const imageUrl = imageUrls[sourceIndex] || '';
  const downloadUrl = useSessionFileDownloadUrl({ fileId, filePath, label: displayName, ext, kind, ctx });
  const previewContext = {
    origin: 'session' as const,
    sessionPath: ctx.sessionPath,
    messageId: ctx.messageId,
    fileId,
    blockIdx: ctx.blockIdx,
  };
  const [scale, setScale] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const dragRef = useRef<null | {
    pointerId: number;
    clientX: number;
    clientY: number;
    scrollLeft: number;
    scrollTop: number;
  }>(null);

  useEffect(() => {
    setSourceIndex(0);
    setFailed(false);
    setLoaded(false);
  }, [imageUrlsKey]);

  const handlePreview = () => {
    const id = buildFileRefId({
      source: 'session-block-file',
      sessionPath: ctx.sessionPath,
      messageId: ctx.messageId,
      blockIdx: ctx.blockIdx,
      path: filePath,
    });
    openMediaViewerForRef({
      id,
      fileId,
      kind: 'image',
      source: 'session-block-file',
      name: displayName,
      path: filePath,
      ext,
      previewUrl: imageUrl,
      sessionMessageId: ctx.messageId,
      sessionBlockIdx: ctx.blockIdx,
    }, previewContext);
  };

  const handleDragStart = useCallback((event: React.DragEvent) => {
    const payload = writeAppFileDragPayload(event.dataTransfer, {
      source: 'session-file',
      files: [{
        id: fileId || filePath,
        fileId,
        name: displayName,
        path: filePath,
      }],
    });
    event.currentTarget.addEventListener('dragend', () => clearAppFileDragPayload(payload.dragId), { once: true });
    if (filePath) {
      event.preventDefault();
      window.platform?.startDrag?.(filePath);
    }
  }, [displayName, fileId, filePath]);

  if (status === 'expired') return <FileOutputCard fileId={fileId} filePath={filePath} label={label} ext={ext} status={status} ctx={ctx} />;
  if (!imageUrl) return <FileOutputCard fileId={fileId} filePath={filePath} label={label} ext={ext} status={status} ctx={ctx} />;
  if (failed) {
    return (
      <div className={`${styles.fileOutputCard} ${styles.imageOutputFailure}`} role="status">
        <div className={styles.fileOutputInfo}>
          <div className={styles.fileOutputName}>{displayName}</div>
          <div className={styles.fileOutputType}>{tWithFallback('chat.imagePreviewFailed', 'Image preview failed')}</div>
        </div>
        <button
          type="button"
          className={styles.imageOutputRetryButton}
          onClick={() => {
            setSourceIndex(0);
            setFailed(false);
            setLoaded(false);
          }}
        >
          {tWithFallback('common.retry', 'Retry')}
        </button>
      </div>
    );
  }

  const downloadHref = downloadUrl || imageUrl;
  const stopToolbarEvent = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const updateScale = (next: (previous: number) => number) => {
    setScale(previous => clampImageOutputScale(next(previous)));
  };
  const handleWheelZoom = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!expanded && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    updateScale(previous => previous * (event.deltaY < 0 ? IMAGE_OUTPUT_ZOOM_STEP : 1 / IMAGE_OUTPUT_ZOOM_STEP));
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!expanded || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
    };
    event.currentTarget.classList.add(styles.imageOutputPanning);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.scrollLeft = drag.scrollLeft - (event.clientX - drag.clientX);
    event.currentTarget.scrollTop = drag.scrollTop - (event.clientY - drag.clientY);
  };
  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.classList.remove(styles.imageOutputPanning);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const card = (
    <div
      className={`${styles.imageOutputCard} ${expanded ? styles.imageOutputExpanded : ''}`}
      draggable={!expanded}
      onDragStart={expanded ? undefined : handleDragStart}
      onClick={expanded ? undefined : handlePreview}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (!expanded && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          handlePreview();
        }
      }}
    >
      <div
        className={styles.imageOutputToolbar}
        aria-label="图像预览工具"
        onClick={(event) => event.stopPropagation()}
      >
        <a
          className={styles.imageOutputToolButton}
          href={downloadHref}
          download={displayName}
          draggable={false}
          aria-label={`${tWithFallback('chat.fileActions.downloadToDevice', 'Download to device')} ${displayName}`}
          title={tWithFallback('chat.fileActions.downloadToDevice', 'Download to device')}
          onClick={(event) => event.stopPropagation()}
        >
          <DownloadGlyph />
        </a>
        <button
          type="button"
          className={styles.imageOutputToolButton}
          aria-label="缩小"
          title="缩小"
          onClick={(event) => {
            stopToolbarEvent(event);
            updateScale(previous => previous / IMAGE_OUTPUT_ZOOM_STEP);
          }}
        >
          −
        </button>
        <button
          type="button"
          className={styles.imageOutputToolButton}
          aria-label="放大"
          title="放大"
          onClick={(event) => {
            stopToolbarEvent(event);
            updateScale(previous => previous * IMAGE_OUTPUT_ZOOM_STEP);
          }}
        >
          +
        </button>
        <button
          type="button"
          className={styles.imageOutputToolButton}
          aria-label="适配宽度"
          title="适配宽度"
          onClick={(event) => {
            stopToolbarEvent(event);
            setScale(1);
          }}
        >
          ⌖
        </button>
        <button
          type="button"
          className={styles.imageOutputToolButton}
          aria-label={expanded ? '退出展开' : '展开查看'}
          title={expanded ? '退出展开' : '展开查看'}
          aria-pressed={expanded}
          onClick={(event) => {
            stopToolbarEvent(event);
            setExpanded(prev => !prev);
          }}
        >
          ⛶
        </button>
      </div>
      <div
        className={styles.imageOutputPreviewWrap}
        aria-busy={!loaded}
        onClick={expanded ? (event) => event.stopPropagation() : undefined}
        onWheel={handleWheelZoom}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        {!loaded && <div className={styles.imageOutputLoading}>{tWithFallback('common.loading', 'Loading…')}</div>}
        <img
          src={imageUrl}
          alt={displayName}
          className={`${styles.imageOutputPreview}${loaded ? ` ${styles.loaded}` : ''}`}
          style={{ width: `${Math.round(scale * 100)}%` }}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            if (sourceIndex + 1 < imageUrls.length) {
              setSourceIndex(index => index + 1);
            } else {
              setFailed(true);
            }
          }}
          draggable={false}
          loading="lazy"
        />
      </div>
    </div>
  );
  return expanded && typeof document !== 'undefined'
    ? createPortal(card, document.body)
    : card;
});

const VideoOutputCard = memo(function VideoOutputCard({ fileId, filePath, label, ext, status, ctx }: {
  fileId?: string;
  filePath: string;
  label: string;
  ext: string;
  status?: string;
  ctx: FileBlockCtx;
}) {
  const [failed, setFailed] = useState(false);
  const displayName = fileDisplayName(filePath, label);
  const videoUrl = useResolvedSessionFileUrl({ fileId, filePath, label: displayName, ext, kind: 'video', ctx });
  const downloadUrl = useSessionFileDownloadUrl({ fileId, filePath, label: displayName, ext, kind: 'video', ctx });
  const previewContext = {
    origin: 'session' as const,
    sessionPath: ctx.sessionPath,
    messageId: ctx.messageId,
    fileId,
    blockIdx: ctx.blockIdx,
  };

  const handlePreview = () => {
    openFilePreview(filePath, label, ext, previewContext);
  };

  if (status === 'expired' || failed || !videoUrl) return <FileOutputCard fileId={fileId} filePath={filePath} label={label} ext={ext} status={status} ctx={ctx} />;

  return (
    <div
      className={`${styles.imageOutputCard} ${styles.videoOutputCard}`}
      data-testid="video-output-card"
      onClick={handlePreview}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handlePreview();
        }
      }}
      aria-label={displayName}
    >
      {downloadUrl && (
        <a
          className={styles.imageOutputDownloadButton}
          href={downloadUrl}
          download={displayName}
          draggable={false}
          aria-label={`${tWithFallback('chat.fileActions.downloadToDevice', 'Download to device')} ${displayName}`}
          title={tWithFallback('chat.fileActions.downloadToDevice', 'Download to device')}
          onClick={(event) => event.stopPropagation()}
        >
          <DownloadGlyph />
        </a>
      )}
      <div className={styles.imageOutputPreviewWrap}>
        <video
          src={videoUrl}
          className={styles.videoOutputPreview}
          preload="metadata"
          muted
          playsInline
          onError={() => setFailed(true)}
        />
      </div>
      <span className={styles.videoOutputPlayBadge} aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      </span>
    </div>
  );
});

const AudioOutputCard = memo(function AudioOutputCard({ fileId, filePath, label, ext, status, ctx }: {
  fileId?: string;
  filePath: string;
  label: string;
  ext: string;
  status?: string;
  ctx: FileBlockCtx;
}) {
  const [failed, setFailed] = useState(false);
  const displayName = fileDisplayName(filePath, label);
  const audioUrl = useResolvedSessionFileUrl({ fileId, filePath, label: displayName, ext, kind: 'audio', ctx });
  const downloadUrl = useSessionFileDownloadUrl({ fileId, filePath, label: displayName, ext, kind: 'audio', ctx });
  const previewContext = {
    origin: 'session' as const,
    sessionPath: ctx.sessionPath,
    messageId: ctx.messageId,
    fileId,
    blockIdx: ctx.blockIdx,
  };

  const handlePreview = () => {
    const id = buildFileRefId({
      source: 'session-block-file',
      sessionPath: ctx.sessionPath,
      messageId: ctx.messageId,
      blockIdx: ctx.blockIdx,
      path: filePath,
    });
    openMediaViewerForRef({
      id,
      fileId,
      kind: 'audio',
      source: 'session-block-file',
      name: displayName,
      path: filePath,
    }, previewContext);
  };

  if (status === 'expired' || failed || !audioUrl) {
    return <FileOutputCard fileId={fileId} filePath={filePath} label={label} ext={ext} status={status} ctx={ctx} />;
  }

  return (
    <div
      className={`${styles.imageOutputCard} ${styles.audioOutputCard}`}
      onClick={handlePreview}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handlePreview();
        }
      }}
    >
      {downloadUrl && (
        <a
          className={styles.imageOutputDownloadButton}
          href={downloadUrl}
          download={displayName}
          draggable={false}
          aria-label={`${tWithFallback('chat.fileActions.downloadToDevice', 'Download to device')} ${displayName}`}
          title={tWithFallback('chat.fileActions.downloadToDevice', 'Download to device')}
          onClick={(event) => event.stopPropagation()}
        >
          <DownloadGlyph />
        </a>
      )}
      <div className={styles.audioOutputSurface}>
        <audio
          src={audioUrl}
          className={styles.audioOutputElement}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
      <div className={styles.imageOutputName} title={displayName}>{displayName}</div>
    </div>
  );
});

const FileOutputCard = memo(function FileOutputCard({ fileId, filePath, label, ext, status, ctx }: {
  fileId?: string;
  filePath: string;
  label: string;
  ext: string;
  status?: string;
  ctx: FileBlockCtx;
}) {
  const expired = status === 'expired';
  const expiredLabel = tWithFallback('chat.fileExpired', 'Expired');
  const handlePreview = () => {
    if (expired) return;
    openFilePreview(filePath, label, ext, {
      origin: 'session',
      sessionPath: ctx.sessionPath,
      messageId: ctx.messageId,
      fileId,
      blockIdx: ctx.blockIdx,
    });
  };

  const displayName = fileDisplayName(filePath, label);
  const downloadUrl = useSessionFileDownloadUrl({ fileId, filePath, label: displayName, ext, kind: 'other', ctx });
  const localFilePath = useSessionFileNativePath({ fileId, filePath, label: displayName, ext, kind: 'other', ctx });
  const typeLabel = expired ? expiredLabel : (EXT_LABELS[ext] || ext.toUpperCase());

  return (
    <div
      className={`${styles.fileOutputCard}${expired ? ` ${styles.fileOutputExpired}` : ` ${styles.fileOutputPreviewable}`}`}
      onClick={handlePreview}
      style={{ cursor: expired ? 'default' : 'pointer' }}
      aria-disabled={expired}
    >
      <div className={styles.fileOutputIcon}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </div>
      <div className={styles.fileOutputInfo}>
        <div className={styles.fileOutputName}>{displayName}</div>
        <div className={styles.fileOutputType}>{typeLabel}{!expired && ext ? ` \u00b7 ${ext.toUpperCase()}` : ''}</div>
      </div>
      {!expired && (
        <FileOutputActions
          filePath={filePath}
          localFilePath={localFilePath}
          displayName={displayName}
          downloadUrl={downloadUrl}
          downloadName={displayName}
        />
      )}
    </div>
  );
});

const FileBlock = memo(function FileBlock({ block, sessionPath, messageId, blockIdx }: {
  block: any;
  sessionPath: string;
  messageId: string;
  blockIdx: number;
}) {
  const ctx: FileBlockCtx = { sessionPath, messageId, blockIdx };
  const kind = inferKindByExt(block.ext);
  if (kind === 'video') {
    return <VideoOutputCard fileId={block.fileId} filePath={block.filePath} label={block.label} ext={block.ext} status={block.status} ctx={ctx} />;
  }
  if (kind === 'audio') {
    return <AudioOutputCard fileId={block.fileId} filePath={block.filePath} label={block.label} ext={block.ext} status={block.status} ctx={ctx} />;
  }
  return isImageOrSvgExt(block.ext)
    ? <ImageOutputCard fileId={block.fileId} filePath={block.filePath} label={block.label} ext={block.ext} status={block.status} ctx={ctx} />
    : <FileOutputCard fileId={block.fileId} filePath={block.filePath} label={block.label} ext={block.ext} status={block.status} ctx={ctx} />;
});

const ArtifactBlock = memo(function ArtifactBlock({ block }: { block: any }) {
  const handleClick = () => {
    const artifact = {
      id: block.artifactId,
      type: block.artifactType,
      title: block.title,
      content: block.content,
      language: block.language,
      fileId: block.fileId,
      filePath: block.filePath,
      ext: block.ext,
      mime: block.mime,
      kind: block.kind,
      storageKind: block.storageKind,
      status: block.status,
      missingAt: block.missingAt,
    };
    openPreview(artifact);
  };
  const expired = block.status === 'expired';

  return (
    <div className={styles.artifactCard} onClick={handleClick} style={{ cursor: 'pointer' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
      </svg>
      <span>{block.title || block.artifactType}</span>
      {expired && <span className={styles.artifactExpiredBadge}>{window.t('chat.fileExpired') === 'chat.fileExpired' ? '已过期' : window.t('chat.fileExpired')}</span>}
    </div>
  );
});

const PluginCardWrapper = memo(function PluginCardWrapper({ block, agentId }: { block: any; agentId?: string | null }) {
  return <PluginCardBlock card={block.card} agentId={agentId} />;
});

const ScreenshotBlock = memo(function ScreenshotBlock({ block, sessionPath, messageId, blockIdx }: {
  block: any;
  sessionPath: string;
  messageId: string;
  blockIdx: number;
}) {
  const handleClick = () => {
    const id = buildFileRefId({
      source: 'session-block-screenshot',
      sessionPath,
      messageId,
      blockIdx,
      path: '',
    });
    openMediaViewerForRef({
      id,
      kind: 'image',
      source: 'session-block-screenshot',
      name: `screenshot-${messageId}-${blockIdx}.png`,
      path: '',
      mime: block.mimeType,
      sessionMessageId: messageId,
      inlineData: { base64: block.base64, mimeType: block.mimeType },
    }, { origin: 'session', sessionPath });
  };

  return (
    <div className={styles.browserScreenshot} onClick={handleClick} style={{ cursor: 'pointer' }}>
      <img src={`data:${block.mimeType};base64,${block.base64}`} alt={window.t('chat.browserScreenshot')} />
    </div>
  );
});

const SkillBlock = memo(function SkillBlock({ block }: { block: any }) {
  const skillFilePath = typeof block.installedSkillSource?.filePath === 'string'
    ? block.installedSkillSource.filePath
    : (typeof block.skillFilePath === 'string' ? block.skillFilePath : '');
  return (
    <ChatResourceCard
      icon={<SkillResourceIcon />}
      title={block.skillName}
      subtitle="Skill"
      onClick={() => openSkillPreview(block.skillName, skillFilePath, block.installedSkillSource)}
      ariaLabel={block.skillName}
    />
  );
});

const CronConfirmBlock = memo(function CronConfirmBlock({ block }: { block: any }) {
  const [status, setStatus] = useState(block.status);
  const isSuggestionCard = block.type === 'suggestion_card';
  const jobData = block.jobData || block.detail?.jobData || {};
  const label = (jobData.label as string)
    || (jobData.prompt as string)?.slice(0, 40)
    || (block.title as string)
    || (block.description as string)?.slice(0, 40)
    || '';

  const handleApprove = async () => {
    try {
      if (block.confirmId) {
        await codiaFetch(`/api/confirm/${block.confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isSuggestionCard
            ? { action: 'confirmed', value: { jobData } }
            : { action: 'confirmed' }),
        });
      } else {
        await codiaFetch('/api/desk/cron', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add', ...jobData }),
        });
      }
      setStatus('approved');
    } catch {
      // keep the pending state when the server rejects the action
    }
  };

  const handleReject = async () => {
    if (block.confirmId) {
      try {
        await codiaFetch(`/api/confirm/${block.confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rejected' }),
        });
      } catch {
        // local state still reflects the user's rejection choice
      }
    }
    setStatus('rejected');
  };

  if (status !== 'pending') {
    return (
      <div className={styles.cronConfirmCard}>
        <div className={styles.cronConfirmTitle}>{label}</div>
        <div className={`${styles.cronConfirmStatus} ${status === 'approved' ? styles.cronConfirmStatusApproved : styles.cronConfirmStatusRejected}`}>
          {status === 'approved' ? window.t('common.approved') : window.t('common.rejected')}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.cronConfirmCard}>
      <div className={styles.cronConfirmTitle}>{label}</div>
      <div className={styles.cronConfirmActions}>
        <button type="button" className={`${styles.cronConfirmBtn} ${styles.cronConfirmBtnApprove}`} onClick={handleApprove}>{window.t('common.approve')}</button>
        <button type="button" className={`${styles.cronConfirmBtn} ${styles.cronConfirmBtnReject}`} onClick={handleReject}>{window.t('common.reject')}</button>
      </div>
    </div>
  );
});

const SettingsConfirmBlock = memo(function SettingsConfirmBlock({ block }: { block: any }) {
  return <SettingsConfirmCard {...block} />;
});

const SettingsUpdateBlock = memo(function SettingsUpdateBlock({ block }: { block: any }) {
  return <SettingsUpdateCard update={block.update} />;
});

BLOCK_RENDERERS.subagent = SubagentCard;
BLOCK_RENDERERS.interactive_card = InteractiveCard;
BLOCK_RENDERERS.artifact = ArtifactBlock;
BLOCK_RENDERERS.plugin_card = PluginCardWrapper;
BLOCK_RENDERERS.skill = SkillBlock;
BLOCK_RENDERERS.cron_confirm = CronConfirmBlock;
BLOCK_RENDERERS.suggestion_card = CronConfirmBlock;
BLOCK_RENDERERS.settings_update = SettingsUpdateBlock;
BLOCK_RENDERERS.settings_confirm = SettingsConfirmBlock;
