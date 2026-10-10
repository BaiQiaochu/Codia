import { CHAT_MIN_WIDTH } from '../layout-constants';
import { useStore } from '../stores';

function cssPixelValue(name: string, fallback: number): number {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10) || fallback;
}

const getSidebarWidth = () => cssPixelValue('--sidebar-width', 240);
const getWorkspaceWidth = () => cssPixelValue('--jian-sidebar-width', 260);
const getPreviewWidth = () => cssPixelValue('--preview-panel-width', 580);

export function updateLayout(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const state = useStore.getState();
  const currentTab = state.currentTab;
  if (typeof currentTab === 'string' && currentTab.startsWith('plugin:')) return;

  const windowWidth = window.innerWidth;
  const leftWidth = state.sidebarOpen ? getSidebarWidth() : 0;
  const rightWidth = state.jianOpen ? getWorkspaceWidth() : 0;
  const previewWidth = state.previewOpen ? getPreviewWidth() : 0;

  if (windowWidth - leftWidth - rightWidth - previewWidth < CHAT_MIN_WIDTH) {
    if (state.jianOpen) {
      useStore.setState({ jianOpen: false, jianAutoCollapsed: true });
      if (windowWidth - (state.sidebarOpen ? getSidebarWidth() : 0) - previewWidth < CHAT_MIN_WIDTH && state.sidebarOpen) {
        useStore.setState({ sidebarOpen: false, sidebarAutoCollapsed: true });
      }
    } else if (state.sidebarOpen) {
      useStore.setState({ sidebarOpen: false, sidebarAutoCollapsed: true });
    }
    return;
  }

  if (state.sidebarAutoCollapsed) {
    if (windowWidth - rightWidth - previewWidth - getSidebarWidth() >= CHAT_MIN_WIDTH) {
      const savedLeft = localStorage.getItem(`codia-sidebar-${state.currentTab || 'chat'}`);
      if (savedLeft !== 'closed') useStore.setState({ sidebarOpen: true, sidebarAutoCollapsed: false });
    }
  }

  const latest = useStore.getState();
  if (latest.jianAutoCollapsed) {
    const currentLeftWidth = latest.sidebarOpen ? getSidebarWidth() : 0;
    if (windowWidth - currentLeftWidth - previewWidth - getWorkspaceWidth() >= CHAT_MIN_WIDTH) {
      const savedRight = localStorage.getItem(`codia-jian-${latest.currentTab || 'chat'}`);
      if (savedRight !== 'closed') useStore.setState({ jianOpen: true, jianAutoCollapsed: false });
    }
  }
}
