import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { kindOfFileName } from '../../utils/file-kind';
import { useMentionThumbnail } from '../../hooks/use-mention-thumbnail';
import styles from './FileBadgeView.module.css';

export function FileBadgeView({ node }: NodeViewProps) {
  const name = (node.attrs.name || node.attrs.path || '') as string;
  const path = (node.attrs.path || '') as string;
  const mimeType = typeof node.attrs.mimeType === 'string' ? node.attrs.mimeType : undefined;
  const kind = node.attrs.isDirectory === true ? 'directory' : kindOfFileName(name || path, mimeType);
  const thumbnailUrl = useMentionThumbnail(kind === 'image' || kind === 'svg' ? path : null, mimeType);
  const isAudio = kind === 'audio';

  return (
    <NodeViewWrapper as="span" className={styles.badge}>
      <span className={styles.at} aria-hidden="true">@</span>
      {thumbnailUrl && (
        <img className={styles.thumbnail} src={thumbnailUrl} alt="" aria-hidden="true" />
      )}
      {isAudio && (
        <span className={styles.audioIcon} aria-hidden="true" data-testid="file-badge-audio-wave">
          <span />
          <span />
          <span />
          <span />
        </span>
      )}
      <span className={styles.name}>{name}</span>
    </NodeViewWrapper>
  );
}
