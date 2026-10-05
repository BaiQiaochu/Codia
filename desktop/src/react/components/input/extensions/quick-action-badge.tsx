import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { Sparkle, X } from '@phosphor-icons/react';
import { isQuickActionId, QUICK_ACTIONS } from '../../../../../../shared/quick-actions';
import styles from '../SkillBadgeView.module.css';

function QuickActionBadgeView({ node, deleteNode }: NodeViewProps) {
  const id = node.attrs.actionId;
  const title = isQuickActionId(id) ? QUICK_ACTIONS[id].title : '快捷任务';
  return <NodeViewWrapper as="span" className={styles.badge} contentEditable={false} data-quick-action={id}>
    <Sparkle size={13} aria-hidden="true" /><span>{title}</span>
    <button type="button" className={styles.remove} aria-label={`移除${title}`} onClick={deleteNode}><X size={11} /></button>
  </NodeViewWrapper>;
}
export const QuickActionBadge = Node.create({
  name: 'quickActionBadge', group: 'inline', inline: true, atom: true,
  addAttributes: () => ({ actionId: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-quick-action]', getAttrs: element => ({ actionId: element.getAttribute('data-quick-action') }) }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes, { 'data-quick-action': HTMLAttributes.actionId }),
    isQuickActionId(HTMLAttributes.actionId) ? QUICK_ACTIONS[HTMLAttributes.actionId].title : '快捷任务'],
  addNodeView: () => ReactNodeViewRenderer(QuickActionBadgeView),
});
