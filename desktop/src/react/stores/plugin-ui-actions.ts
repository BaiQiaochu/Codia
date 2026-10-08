import { useStore } from './index';
import { gsapFetch } from '../hooks/use-gsap-fetch';
import type { PluginPageInfo, PluginUiHostCapabilityGrant, PluginWidgetInfo, VsCodeFileIconThemeInfo } from '../types';
import { schedulePersistCurrentWorkspaceUiState } from './workspace-ui-state-actions';

function collectPluginUiHostCapabilities(
  pages: PluginPageInfo[],
  widgets: PluginWidgetInfo[],
  grants: PluginUiHostCapabilityGrant[],
): Record<string, string[]> {
  const byPlugin: Record<string, string[]> = {};
  const add = (pluginId: string, hostCapabilities: string[] | undefined) => {
    if (!pluginId || !Array.isArray(hostCapabilities)) return;
    const set = new Set(byPlugin[pluginId] || []);
    for (const capability of hostCapabilities) {
      if (typeof capability === 'string' && capability.trim()) set.add(capability);
    }
    byPlugin[pluginId] = [...set];
  };
  for (const page of pages) add(page.pluginId, page.hostCapabilities);
  for (const widget of widgets) add(widget.pluginId, widget.hostCapabilities);
  for (const grant of grants) add(grant.pluginId, grant.hostCapabilities);
  return byPlugin;
}

/** Fetch plugin pages and widgets from backend, update store. */
export async function refreshPluginUI(): Promise<void> {
  try {
    let pages: PluginPageInfo[] = [];
    let widgets: PluginWidgetInfo[] = [];
    let vscodeFileIconThemes: VsCodeFileIconThemeInfo[] = [];
    let hostCapabilityGrants: PluginUiHostCapabilityGrant[] = [];

    // gsapFetch throws on non-2xx, so wrap each call individually
    const [pagesResult, widgetsResult, vscodeIconResult, grantsResult] = await Promise.allSettled([
      gsapFetch('/api/plugins/pages').then(r => r.json()),
      gsapFetch('/api/plugins/widgets').then(r => r.json()),
      gsapFetch('/api/plugins/vscode/file-icon-themes').then(r => r.json()),
      gsapFetch('/api/plugins/ui-host-capabilities').then(r => r.json()),
    ]);
    if (pagesResult.status === 'fulfilled') pages = pagesResult.value;
    if (widgetsResult.status === 'fulfilled') widgets = widgetsResult.value;
    if (vscodeIconResult.status === 'fulfilled' && Array.isArray(vscodeIconResult.value)) {
      vscodeFileIconThemes = vscodeIconResult.value;
    }
    if (grantsResult.status === 'fulfilled' && Array.isArray(grantsResult.value)) {
      hostCapabilityGrants = grantsResult.value;
    }

    const s = useStore.getState();
    s.setPluginPages(pages);
    s.setPluginWidgets(widgets);
    s.setPluginUiHostCapabilities(collectPluginUiHostCapabilities(pages, widgets, hostCapabilityGrants));
    s.setVsCodeFileIconThemes(vscodeFileIconThemes);
    document.documentElement.dataset.pluginUiReady = 'true';
    window.dispatchEvent(new Event('gsap-plugin-ui-ready'));

    // If current tab is a removed plugin tab, switch to chat
    const currentTab = s.currentTab;
    if (typeof currentTab === 'string' && currentTab.startsWith('plugin:')) {
      const pluginId = currentTab.slice(7);
      if (!pages.some(p => p.pluginId === pluginId)) {
        s.setCurrentTab('chat');
      }
    }

    // If jianView references a removed widget, reset to desk
    if (s.jianView.startsWith('widget:')) {
      const widgetId = s.jianView.slice(7);
      if (!widgets.some(w => w.pluginId === widgetId)) {
        s.setJianView('desk');
        schedulePersistCurrentWorkspaceUiState();
      }
    }

    // Clean stale pinned widgets
    const validPinned = s.pinnedWidgets.filter(id => widgets.some(w => w.pluginId === id));
    if (validPinned.length !== s.pinnedWidgets.length) {
      s.setPinnedWidgets(validPinned);
    }
  } catch (err) {
    console.warn('[plugin-ui] Failed to refresh:', err);
  }
}

/** Persist tab order, pinned widgets, and hidden tabs to preferences. */
async function savePluginPrefs(): Promise<void> {
  const s = useStore.getState();
  try {
    await gsapFetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pluginTabOrder: s.tabOrder,
        pluginPinnedWidgets: s.pinnedWidgets,
        pluginHiddenTabs: s.hiddenPluginTabs,
      }),
    });
  } catch (err) {
    console.warn('[plugin-ui] Failed to persist prefs:', err);
  }
}

/** Pin a widget to the titlebar. */
export function pinWidget(pluginId: string): void {
  const s = useStore.getState();
  if (!s.pinnedWidgets.includes(pluginId)) {
    s.setPinnedWidgets([...s.pinnedWidgets, pluginId]);
    savePluginPrefs();
  }
}

/** Unpin a widget from the titlebar. */
export function unpinWidget(pluginId: string): void {
  const s = useStore.getState();
  s.setPinnedWidgets(s.pinnedWidgets.filter(id => id !== pluginId));
  savePluginPrefs();
}

/** Switch jian sidebar to a widget view. */
export function openWidget(pluginId: string): void {
  const s = useStore.getState();
  s.setJianView(`widget:${pluginId}`);
  schedulePersistCurrentWorkspaceUiState();
  if (!s.jianOpen) {
    s.setJianOpen(true);
  }
}

/** Switch jian sidebar back to desk. */
export function openDesk(): void {
  useStore.getState().setJianView('desk');
  schedulePersistCurrentWorkspaceUiState();
}

/** Hide a plugin tab from the tab bar. */
export function hidePluginTab(tabId: string): void {
  const s = useStore.getState();
  const pluginId = tabId.startsWith('plugin:') ? tabId.slice(7) : tabId;
  if (!s.hiddenPluginTabs.includes(pluginId)) {
    s.setHiddenPluginTabs([...s.hiddenPluginTabs, pluginId]);
    // If currently viewing this tab, switch to chat
    if (s.currentTab === `plugin:${pluginId}`) s.setCurrentTab('chat');
    savePluginPrefs();
  }
}

/** Show a previously hidden plugin tab. */
export function showPluginTab(tabId: string): void {
  const s = useStore.getState();
  const pluginId = tabId.startsWith('plugin:') ? tabId.slice(7) : tabId;
  s.setHiddenPluginTabs(s.hiddenPluginTabs.filter(id => id !== pluginId));
  savePluginPrefs();
}

/** Reorder tabs (called after drag-drop). */
export function reorderTabs(newOrder: string[]): void {
  useStore.getState().setTabOrder(newOrder);
  savePluginPrefs();
}
