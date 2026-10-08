import { describe, expect, it } from 'vitest';
import { canRestorePluginTab, normalizeSavedTab } from '../../utils/saved-tab';

describe('saved desktop tab restoration', () => {
  it('restores primary pages and normalizes chat-only visual plugins', () => {
    expect(normalizeSavedTab('channels')).toBe('channels');
    expect(normalizeSavedTab('workflow')).toBe('workflow');
    expect(normalizeSavedTab('plugin:knowledge-graph')).toBe('chat');
    expect(normalizeSavedTab('plugin:mind-map')).toBe('chat');
    expect(normalizeSavedTab('broken')).toBe('chat');
  });

  it('restores other plugin pages only after discovery confirms them', () => {
    const pages = [{
      pluginId: 'calendar',
      title: 'Calendar',
      icon: null,
      routeUrl: '/api/plugins/calendar/page',
      hostCapabilities: [],
    }];
    expect(normalizeSavedTab('plugin:calendar')).toBe('plugin:calendar');
    expect(canRestorePluginTab('plugin:calendar', pages)).toBe(true);
    expect(canRestorePluginTab('plugin:missing', pages)).toBe(false);
  });
});
