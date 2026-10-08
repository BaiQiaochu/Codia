import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_LAYOUT,
  applyChatLayout,
  mergeChatLayout,
  normalizeChatLayout,
} from '../../chat/layout';

describe('chat layout settings', () => {
  it('normalizes chat width independently from editor typography', () => {
    expect(DEFAULT_CHAT_LAYOUT.contentWidth).toBe(720);
    expect(DEFAULT_CHAT_LAYOUT.bodyFontSizeOffset).toBe(0);
    expect(normalizeChatLayout({ contentWidth: 800 }).contentWidth).toBe(800);
    expect(normalizeChatLayout({ contentWidth: 'unlimited' }).contentWidth).toBe('unlimited');
    expect(normalizeChatLayout({ contentWidth: 960 }).contentWidth).toBe(720);
    expect(normalizeChatLayout({ bodyFontSizeOffset: 2 }).bodyFontSizeOffset).toBe(2);
    expect(normalizeChatLayout({ bodyFontSizeOffset: 4 }).bodyFontSizeOffset).toBe(0);
  });

  it('merges partial chat layout patches without dropping existing values', () => {
    const merged = mergeChatLayout(
      { contentWidth: 800, bodyFontSizeOffset: 1 },
      { bodyFontSizeOffset: -1 },
    );

    expect(merged).toEqual({
      contentWidth: 800,
      bodyFontSizeOffset: -1,
    });
  });

  it('applies chat width to the message column and input column only', () => {
    const values = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        getPropertyValue: (name: string) => values.get(name) || '',
      },
    } as unknown as HTMLElement;

    applyChatLayout({ contentWidth: 640, bodyFontSizeOffset: -1 }, root);

    const style = root.style;
    expect(style.getPropertyValue('--chat-column-width')).toBe('640px');
    expect(style.getPropertyValue('--chat-input-column-width')).toBe('calc(var(--chat-column-width) + var(--chat-input-column-extra))');
    expect(style.getPropertyValue('--chat-message-font-size')).toBe('14px');
    expect(style.getPropertyValue('--editor-markdown-content-width')).toBe('');
    expect(style.getPropertyValue('--editor-markdown-font-size')).toBe('');
  });

  it('maps unlimited chat width to unrestricted chat columns', () => {
    const values = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        getPropertyValue: (name: string) => values.get(name) || '',
      },
    } as unknown as HTMLElement;

    applyChatLayout({ contentWidth: 'unlimited' }, root);

    const style = root.style;
    expect(style.getPropertyValue('--chat-column-width')).toBe('none');
    expect(style.getPropertyValue('--chat-input-column-width')).toBe('none');
  });
});
