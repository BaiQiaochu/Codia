import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { PluginBadgeView } from '../PluginBadgeView';

export const PluginBadge = Node.create({
  name: 'pluginBadge',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      id: { default: null },
      name: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-plugin-mention]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      class: 'plugin-badge',
      'data-plugin-mention': HTMLAttributes.id || '',
    })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(PluginBadgeView);
  },
});
