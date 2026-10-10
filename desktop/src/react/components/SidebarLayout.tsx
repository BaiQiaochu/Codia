import { useEffect, useRef } from 'react';
import { useStore } from '../stores';
import { createNewSession } from '../stores/session-actions';
import { closePreview } from '../stores/preview-actions';
import { updateLayout } from '../services/layout-state';

export { updateLayout } from '../services/layout-state';

export function toggleSidebar(forceOpen?: boolean): void {
  const s = useStore.getState();
  const open = forceOpen !== undefined ? forceOpen : !s.sidebarOpen;
  useStore.setState({ sidebarOpen: open });

  const tab = s.currentTab || 'chat';
  localStorage.setItem(`codia-sidebar-${tab}`, open ? 'open' : 'closed');

  if (forceOpen === undefined) {
    useStore.setState({ sidebarAutoCollapsed: false });
  }
}

// React 缁勪欢

export function SidebarLayout() {
  const initDone = useRef(false);

  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;

    // 迁移 localStorage
    const legacy = localStorage.getItem('codia-sidebar');
    if (legacy && !localStorage.getItem('codia-sidebar-chat')) {
      localStorage.setItem('codia-sidebar-chat', legacy);
    }
    const savedOpen = localStorage.getItem('codia-sidebar-chat');
    const sidebarOpen = savedOpen !== 'closed';

    useStore.setState({
      sidebarOpen,
      sidebarAutoCollapsed: false,
      jianAutoCollapsed: false,
    });

    // Resize
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        updateLayout();
        resizeTimer = null;
      }, 50);
    };
    window.addEventListener('resize', onResize);

    // Keyboard shortcuts.
    const onKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        toggleSidebar();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        createNewSession();
      }
      if (e.key === 'Escape' && useStore.getState().previewOpen) {
        closePreview();
      }
    };
    document.addEventListener('keydown', onKeydown);

    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKeydown);
    };
  }, []);

 //
  return null;
}
