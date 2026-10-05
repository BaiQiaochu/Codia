import React, { Suspense, lazy, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { WindowControls } from '../components/WindowControls';
import { useStore } from '../stores';
import { SettingsContent } from './SettingsContent';
import { useSettingsStore } from './store';
import { WhatsappQrcodeOverlay } from './overlays/WhatsappQrcodeOverlay';
import { getDesktopApi } from '../utils/desktop-api';

const titlebarEl = document.querySelector('.titlebar');
const SkillViewerOverlay = lazy(() => import('../components/SkillViewerOverlay').then((m) => ({ default: m.SkillViewerOverlay })));

type SkillViewerPayload = {
  name: string;
  baseDir: string;
  filePath?: string;
  installed?: boolean;
};

function isSkillViewerPayload(data: unknown): data is SkillViewerPayload {
  if (!data || typeof data !== 'object') return false;
  const payload = data as Partial<SkillViewerPayload>;
  return typeof payload.name === 'string'
    && typeof payload.baseDir === 'string'
    && (payload.filePath === undefined || typeof payload.filePath === 'string')
    && (payload.installed === undefined || typeof payload.installed === 'boolean');
}

export function SettingsApp() {
  const currentAgentId = useSettingsStore((s) => s.currentAgentId);

  useEffect(() => {
    useStore.setState({ currentAgentId });
  }, [currentAgentId]);

  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi?.onShowSkillViewer) return;
    const unsubscribe = desktopApi.onShowSkillViewer((data: unknown) => {
      useStore.setState({ skillViewerData: isSkillViewerPayload(data) ? data : null });
    });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, []);

  return (
    <ErrorBoundary region="settings">
      <SettingsContent variant="window" listenToWindowTabSwitch />
      <WhatsappQrcodeOverlay />
      <Suspense fallback={null}>
        <SkillViewerOverlay />
      </Suspense>

      {titlebarEl && createPortal(<WindowControls />, titlebarEl)}
    </ErrorBoundary>
  );
}
