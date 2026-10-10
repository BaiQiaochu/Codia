import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Plug } from '@phosphor-icons/react';
import styles from './SkillBadgeView.module.css';

export function PluginBadgeView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" className={styles.badge} data-mention-kind="plugin">
      <Plug className={styles.icon} size={13} weight="bold" aria-hidden="true" />
      <span className={styles.name}>{String(node.attrs.name || node.attrs.id || '')}</span>
    </NodeViewWrapper>
  );
}
