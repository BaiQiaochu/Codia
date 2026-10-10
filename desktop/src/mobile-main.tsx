import React from 'react';
import { createRoot } from 'react-dom/client';
import { installMobilePlatform } from './react/mobile/mobile-platform';
import './react/mobile/mobile-entry.css';
import './react/mobile/MobileApp.css';

type MobilePwaBridge = {
  serverUrl?: (path: string) => string;
  wsUrl?: (token?: string | null) => string;
  uploadBrowserFiles?: (files: File[]) => Promise<string[]>;
};

function normalizeBackendPath(path: string): string {
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

async function readFileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function installMobilePwaBridge(): void {
  const target = window as Window & { __CODIA_PWA__?: MobilePwaBridge };
  const existing = target.__CODIA_PWA__ || {};
  target.__CODIA_PWA__ = {
    ...existing,
    serverUrl: existing.serverUrl || ((path: string) => normalizeBackendPath(path)),
    wsUrl: existing.wsUrl || ((token?: string | null) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const query = token ? `?token=${encodeURIComponent(token)}` : '';
      return `${protocol}//${window.location.host}/ws${query}`;
    }),
    uploadBrowserFiles: existing.uploadBrowserFiles || (async (files: File[]) => {
      const blobs = await Promise.all((files || []).map(async (file) => ({
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        base64Data: await readFileBase64(file),
      })));
      if (blobs.length === 0) return [];
      const res = await fetch(normalizeBackendPath('/api/upload-blob'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobs }),
      });
      if (!res.ok) throw new Error(`upload failed: ${res.status}`);
      const data = await res.json();
      return Array.isArray(data?.uploads)
        ? data.uploads.map((upload: { dest?: string }) => upload?.dest).filter(Boolean)
        : [];
    }),
  };
}

installMobilePwaBridge();
installMobilePlatform();

const el = document.getElementById('react-root');
if (!el) throw new Error('mobile react root not found');

void import('./react/mobile/MobileApp')
  .then(({ MobileApp }) => {
    createRoot(el).render(
      <React.StrictMode>
        <MobileApp />
      </React.StrictMode>,
    );
  })
  .catch((err) => {
    console.error('[mobile] failed to load shell:', err);
    el.textContent = 'Codia 启动失败';
  });

const MOBILE_UPDATE_AVAILABLE_EVENT = 'codia-mobile-update-available';
const MOBILE_APPLY_UPDATE_EVENT = 'codia-mobile-apply-update';

function registerMobileServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  let hadController = Boolean(navigator.serviceWorker.controller);
  let reloadOnControllerChange = false;
  let reloadStarted = false;
  const notifyUpdateAvailable = () => {
    window.__codiaMobileUpdateAvailable = true;
    window.dispatchEvent(new CustomEvent(MOBILE_UPDATE_AVAILABLE_EVENT));
  };
  const reloadForUpdate = () => {
    if (reloadStarted) return;
    reloadStarted = true;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadOnControllerChange) {
      reloadForUpdate();
      return;
    }
    if (hadController) notifyUpdateAvailable();
    hadController = true;
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((registration) => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        notifyUpdateAvailable();
      }
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            notifyUpdateAvailable();
          }
        });
      });
      const checkForUpdate = () => {
        if (document.visibilityState === 'hidden') return;
        void registration.update().catch((err) => {
          console.warn('[mobile] service worker update check failed:', err);
        });
      };
      const applyUpdate = () => {
        if (registration.waiting) {
          reloadOnControllerChange = true;
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
          return;
        }
        reloadForUpdate();
      };
      window.addEventListener(MOBILE_APPLY_UPDATE_EVENT, applyUpdate);
      window.addEventListener('focus', checkForUpdate);
      document.addEventListener('visibilitychange', checkForUpdate);
    }).catch((err) => {
      console.warn('[mobile] service worker registration failed:', err);
    });
  });
}

registerMobileServiceWorker();

