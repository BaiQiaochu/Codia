import { useStore } from '../../stores';
import type { ActivePanel, TabType } from '../../types';
import { toggleSidebar } from '../SidebarLayout';
import { toggleJianSidebar } from '../../stores/desk-actions';
import { hydrateCurrentChannelIfNeeded } from '../../stores/channel-actions';

export function togglePanel(panel: ActivePanel) {
  const s = useStore.getState();
  s.setActivePanel(s.activePanel === panel ? null : panel);
}

export function switchTab(tab: TabType) {
  const s = useStore.getState();
  // Persist an explicit selection even when the store already points at this tab.
  // This prevents delayed plugin-tab restoration from undoing a user's choice.
  localStorage.setItem('codia-tab', tab);
  if (tab === s.currentTab) {
    if (tab === 'channels') {
      s.setActivePanel(null);
      hydrateCurrentChannelIfNeeded().catch((err: unknown) =>
        console.warn('[channels] hydrate current channel failed', err));
    }
    return;
  }

  if (tab === 'channels') {
    s.setActivePanel(null);
  }

  s.setCurrentTab(tab);
  if (tab === 'channels') {
    hydrateCurrentChannelIfNeeded().catch((err: unknown) =>
      console.warn('[channels] hydrate current channel failed', err));
  }

  // Plugin tabs don't have sidebar persistence
  if (typeof tab === 'string' && tab.startsWith('plugin:')) return;

  const savedLeft = localStorage.getItem(`codia-sidebar-${tab}`);
  const wantLeftOpen = savedLeft !== 'closed';
  if (s.sidebarOpen !== wantLeftOpen) toggleSidebar(wantLeftOpen);

  const savedRight = localStorage.getItem(`codia-jian-${tab}`);
  const wantRightOpen = savedRight !== 'closed';
  if (s.jianOpen !== wantRightOpen) toggleJianSidebar(wantRightOpen);
}
