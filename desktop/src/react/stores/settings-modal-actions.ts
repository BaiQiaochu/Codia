import { useStore } from './index';

const DEFAULT_SETTINGS_TAB = 'agent';

export function normalizeSettingsModalTab(tab?: string): string {
  const nextTab = tab || DEFAULT_SETTINGS_TAB;
  return nextTab === 'computer' ? 'experiments' : nextTab;
}

export function openSettingsModal(tab?: string): void {
  const current = useStore.getState().settingsModal;
  const activeTab = normalizeSettingsModalTab(tab || current?.activeTab);
  useStore.setState({
    settingsModal: {
      open: true,
      activeTab,
    },
  });
}

export function closeSettingsModal(): void {
  const current = useStore.getState().settingsModal;
  useStore.setState({
    settingsModal: {
      open: false,
      activeTab: normalizeSettingsModalTab(current?.activeTab),
    },
  });
}

export function setSettingsModalActiveTab(tab: string): void {
  const current = useStore.getState().settingsModal;
  const activeTab = normalizeSettingsModalTab(tab || current?.activeTab);
  if ((current?.activeTab || DEFAULT_SETTINGS_TAB) === activeTab) {
    return;
  }
  useStore.setState({
    settingsModal: {
      open: current?.open ?? false,
      activeTab,
    },
  });
}
