import type { PluginPageInfo, TabType } from '../types';

const CHAT_EMBEDDED_PLUGIN_TABS = new Set<TabType>([
  'plugin:knowledge-graph',
  'plugin:mind-map',
]);

export function normalizeSavedTab(value: string | null): TabType {
  if (!value || CHAT_EMBEDDED_PLUGIN_TABS.has(value as TabType)) return 'chat';
  if (value === 'chat' || value === 'channels' || value === 'workflow') return value;
  if (value.startsWith('plugin:') && value.length > 'plugin:'.length) return value as TabType;
  return 'chat';
}

export function canRestorePluginTab(tab: TabType, pages: readonly PluginPageInfo[]): boolean {
  if (!tab.startsWith('plugin:')) return true;
  const pluginId = tab.slice('plugin:'.length);
  return pages.some(page => page.pluginId === pluginId);
}
