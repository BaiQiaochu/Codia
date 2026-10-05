import { useCallback, useMemo } from 'react';
import { useStore } from '../../stores';
import { selectSessionFiles } from '../../stores/selectors/file-refs';
import { openChannel } from '../../stores/channel-actions';
import type { FileRef } from '../../types/file-ref';
import type { Channel } from '../../types';
import { isMediaKind } from '../../utils/file-kind';
import { openFileRefPreview } from '../../utils/remote-file-preview';
import styles from './RightWorkspacePanel.module.css';

const EMPTY_FILES: readonly FileRef[] = Object.freeze([]);

const ui = {
  image: '\u56fe\u7247',
  video: '\u89c6\u9891',
  audio: '\u97f3\u9891',
  document: '\u6587\u6863',
  code: '\u4ee3\u7801',
  file: '\u6587\u4ef6',
  media: '\u5a92\u4f53',
  resource: '\u8d44\u6e90',
  noChannelForInput: '\u6ca1\u6709\u53ef\u7528\u9891\u9053\uff0c\u65e0\u6cd5\u53d1\u9001\u5230\u9891\u9053',
  noChannelForWorkflow: '\u6ca1\u6709\u53ef\u7528\u9891\u9053\uff0c\u65e0\u6cd5\u52a0\u5165\u5de5\u4f5c\u6d41',
  addedChatInput: '\u5df2\u52a0\u5165\u804a\u5929\u8f93\u5165\uff1a',
  addedChannelInput: '\u5df2\u52a0\u5165\u9891\u9053\u8f93\u5165\uff1a',
  addedWorkflow: '\u5df2\u52a0\u5165\u5de5\u4f5c\u6d41\uff1a',
  cleared: '\u5df2\u6e05\u7a7a\u4f1a\u8bdd\u8d44\u6e90\u5e93',
  libraryLabel: '\u4f1a\u8bdd\u8d44\u6e90\u5e93',
  librarySummary: '\u6309\u4f1a\u8bdd\u805a\u5408\u56fe\u7247\u3001\u6587\u4ef6\u3001\u89c6\u9891\u3001\u97f3\u9891\u548c\u751f\u6210\u7269\uff0c\u53ef\u590d\u7528\u5230\u804a\u5929\u3001\u9891\u9053\u548c\u5de5\u4f5c\u6d41\u3002',
  itemCount: '\u9879',
  clear: '\u6e05\u7a7a',
  empty: '\u5f53\u524d\u4f1a\u8bdd\u8fd8\u6ca1\u6709\u53ef\u590d\u7528\u8d44\u6e90',
  preview: '\u9884\u89c8',
  addToChat: '\u52a0\u5165\u804a\u5929',
  sendToChannel: '\u53d1\u9001\u5230\u9891\u9053',
  addToWorkflow: '\u52a0\u5165\u5de5\u4f5c\u6d41',
};

function resourceKindLabel(kind: string): string {
  if (kind === 'image' || kind === 'svg') return ui.image;
  if (kind === 'video') return ui.video;
  if (kind === 'audio') return ui.audio;
  if (kind === 'pdf' || kind === 'doc' || kind === 'markdown') return ui.document;
  if (kind === 'code') return ui.code;
  return ui.file;
}

function canReuse(file: FileRef): boolean {
  return file.status !== 'expired' && (!!file.path || !!file.inlineData?.base64 || !!file.resource?.links.content);
}

function toAttachedFile(file: FileRef) {
  return {
    fileId: file.fileId,
    path: file.path || file.resource?.links.content || `session-resource:${file.id}`,
    name: file.name,
    isDirectory: false,
    base64Data: file.inlineData?.base64,
    mimeType: file.inlineData?.mimeType || file.mime,
    resource: file.resource
      ? {
          schemaVersion: 1 as const,
          resourceId: file.resource.resourceId,
          name: `studios/${file.resource.studioId}/resources/${file.resource.resourceId}`,
          studioId: file.resource.studioId,
          type: 'file',
          source: 'session_file',
          fileId: file.fileId,
          displayName: file.name,
          filename: file.name,
          ext: file.ext || null,
          mime: file.mime,
          kind: file.kind,
          lifecycle: { status: file.status || 'available', missingAt: null },
          storage: { provider: 'session_file' },
          links: {
            self: file.resource.links.self,
            ...(file.resource.links.content ? { content: file.resource.links.content } : {}),
          },
        }
      : undefined,
  };
}

function createPendingActionId(): string {
  return `channel-resource-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function previewResource(file: FileRef, sessionPath: string | null): void {
  if (file.status === 'expired') return;
  void openFileRefPreview(file, {
    origin: 'session',
    sessionPath: sessionPath ?? undefined,
    messageId: file.sessionMessageId,
    blockIdx: file.sessionBlockIdx,
  });
}

function pickChannelTarget(channels: readonly Channel[], currentChannel: string | null): Channel | null {
  const active = channels.find((channel) => channel.id === currentChannel);
  if (active && !active.isDM) return active;
  return channels.find((channel) => !channel.isDM) || null;
}

export function SessionResourceLibraryPanel() {
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const currentChannel = useStore(s => s.currentChannel);
  const channels = useStore(s => Array.isArray(s.channels) ? s.channels : []);
  const setCurrentTab = useStore(s => s.setCurrentTab);
  const addAttachedFile = useStore(s => s.addAttachedFile);
  const setPendingChannelResourceAction = useStore(s => s.setPendingChannelResourceAction);
  const requestInputFocus = useStore(s => s.requestInputFocus);
  const addToast = useStore(s => s.addToast);
  const hideSessionResources = useStore(s => s.hideSessionResources);
  const files = useStore(s => (
    s.currentSessionPath ? selectSessionFiles(s, s.currentSessionPath) : EMPTY_FILES
  ));
  const channelTarget = useMemo(() => pickChannelTarget(channels, currentChannel), [channels, currentChannel]);

  const grouped = useMemo(() => {
    const groups = new Map<string, FileRef[]>();
    for (const file of files) {
      const key = resourceKindLabel(file.kind);
      groups.set(key, [...(groups.get(key) || []), file]);
    }
    return [...groups.entries()].map(([label, items]) => ({ label, items }));
  }, [files]);

  const activateChannel = useCallback(async (channel: Channel) => {
    setCurrentTab('channels');
    await openChannel(channel.id, channel.isDM);
  }, [setCurrentTab]);

  const attachToInput = useCallback((file: FileRef, target: 'chat' | 'channel') => {
    if (!canReuse(file)) return;
    if (target === 'chat') {
      setCurrentTab('chat');
      addAttachedFile(toAttachedFile(file));
      requestInputFocus();
      addToast?.(`${ui.addedChatInput}${file.name}`, 'success', 1800);
      return;
    }
    if (!channelTarget) {
      addToast?.(ui.noChannelForInput, 'error', 2400);
      return;
    }
    setPendingChannelResourceAction({
      id: createPendingActionId(),
      target: 'input',
      channelId: channelTarget.id,
      file: toAttachedFile(file),
    });
    void activateChannel(channelTarget);
    addToast?.(`${ui.addedChannelInput}${channelTarget.name || channelTarget.id} / ${file.name}`, 'success', 1800);
  }, [activateChannel, addAttachedFile, addToast, channelTarget, requestInputFocus, setCurrentTab, setPendingChannelResourceAction]);

  const sendToWorkflow = useCallback((file: FileRef) => {
    if (!canReuse(file)) return;
    if (!channelTarget) {
      addToast?.(ui.noChannelForWorkflow, 'error', 2400);
      return;
    }
    setPendingChannelResourceAction({
      id: createPendingActionId(),
      target: 'workflow',
      channelId: channelTarget.id,
      file: toAttachedFile(file),
    });
    void activateChannel(channelTarget);
    addToast?.(`${ui.addedWorkflow}${file.name}`, 'success', 1800);
  }, [activateChannel, addToast, channelTarget, setPendingChannelResourceAction]);

  const clearLibrary = useCallback(() => {
    if (!currentSessionPath || files.length === 0) return;
    hideSessionResources(currentSessionPath, files.map((file) => file.id));
    addToast?.(ui.cleared, 'success', 1800);
  }, [addToast, currentSessionPath, files, hideSessionResources]);

  return (
    <section className={styles.sessionResourceLibrary} aria-label={ui.libraryLabel}>
      <div className={styles.resourceLibraryHeader}>
        <div>
          <div className={styles.resourceLibraryTitle}>{ui.libraryLabel}</div>
          <div className={styles.resourceLibrarySummary}>{ui.librarySummary}</div>
        </div>
        <div className={styles.resourceLibraryHeaderActions}>
          <span className={styles.resourceLibraryCount}>{files.length} {ui.itemCount}</span>
          <button
            type="button"
            className={styles.resourceLibraryClearButton}
            disabled={files.length === 0}
            onClick={clearLibrary}
          >
            {ui.clear}
          </button>
        </div>
      </div>

      {files.length === 0 ? (
        <div className={styles.emptyState}>{ui.empty}</div>
      ) : (
        <div className={styles.resourceLibraryList}>
          {grouped.map(group => (
            <div key={group.label} className={styles.resourceGroup}>
              <div className={styles.resourceGroupTitle}>{group.label}</div>
              {group.items.map(file => (
                <article key={file.id} className={styles.resourceItem} data-session-resource-kind={file.kind}>
                  <div className={styles.resourceItemMain}>
                    <div className={styles.resourceItemName} title={file.name}>{file.name}</div>
                    <div className={styles.resourceItemMeta}>
                      {[file.source, file.ext?.toUpperCase() || file.kind, isMediaKind(file.kind) ? ui.media : ui.resource].filter(Boolean).join(' / ')}
                    </div>
                  </div>
                  <div className={styles.resourceActions}>
                    <button type="button" onClick={() => previewResource(file, currentSessionPath)} disabled={file.status === 'expired'}>
                      {ui.preview}
                    </button>
                    <button type="button" onClick={() => attachToInput(file, 'chat')} disabled={!canReuse(file)}>
                      {ui.addToChat}
                    </button>
                    <button
                      type="button"
                      onClick={() => attachToInput(file, 'channel')}
                      disabled={!channelTarget || !canReuse(file)}
                      title={!channelTarget ? ui.noChannelForInput : undefined}
                    >
                      {ui.sendToChannel}
                    </button>
                    <button
                      type="button"
                      onClick={() => sendToWorkflow(file)}
                      disabled={!channelTarget || !canReuse(file)}
                      title={!channelTarget ? ui.noChannelForWorkflow : undefined}
                    >
                      {ui.addToWorkflow}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
