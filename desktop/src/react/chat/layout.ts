import {
  DEFAULT_CHAT_LAYOUT,
  mergeChatLayout,
  normalizeChatLayout,
  type ChatBodyFontSizeOffset,
  type ChatLayoutContentWidth,
  type ChatLayoutPreferences,
} from '../../../../shared/chat-layout.ts';

const BODY_FONT_SIZE_BASE = 15;

export {
  DEFAULT_CHAT_LAYOUT,
  mergeChatLayout,
  normalizeChatLayout,
  type ChatBodyFontSizeOffset,
  type ChatLayoutContentWidth,
  type ChatLayoutPreferences,
};

export function applyChatLayout(
  value: unknown,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): ChatLayoutPreferences {
  const layout = normalizeChatLayout(value);
  if (!root?.style) return layout;

  if (layout.contentWidth === 'unlimited') {
    root.style.setProperty('--chat-column-width', 'none');
    root.style.setProperty('--chat-input-column-width', 'none');
  } else {
    root.style.setProperty('--chat-column-width', `${layout.contentWidth}px`);
    root.style.setProperty('--chat-input-column-width', 'calc(var(--chat-column-width) + var(--chat-input-column-extra))');
  }
  root.style.setProperty('--chat-message-font-size', `${BODY_FONT_SIZE_BASE + layout.bodyFontSizeOffset}px`);

  return layout;
}
