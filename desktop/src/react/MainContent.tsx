/**
 * Main content drop handling and layout composition.
 */

import { useState, useRef, useCallback } from 'react';
import { useStore } from './stores';
import { toArray } from './stores/session-selectors';
import { sessionScopedValue } from './stores/session-slice';
import { codiaFetch } from './hooks/use-codia-fetch';
import { toSlash, baseName, isImageFile } from './utils/format';
import { isAudioFileName } from './utils/file-kind';
import { prepareImageAttachmentForVision } from './utils/image-attachments';
import { modelSupportsImageInput } from './utils/model-capabilities';
import { resolveBrowserFilePaths } from './utils/browser-file-paths';
import { buildWaveformFromBase64 } from './utils/audio-waveform';
import {
  clearAppFileDragPayload,
  readAppFileDragPayload,
  type AppFileDragPayload,
} from './utils/app-file-drag';
import { BrowserCard } from './components/BrowserCard';
import { ComputerUseOverlay } from './components/ComputerUseOverlay';
import { getDesktopApi } from './utils/desktop-api';
import type { AudioWaveform } from './stores/chat-types';
import type { AttachedFile } from './stores/input-slice';

declare function t(key: string, vars?: Record<string, string | number>): string;

/* eslint-disable @typescript-eslint/no-explicit-any -- deskFiles item typing */

async function installSkillFile(filePath: string, sessionPath?: string | null): Promise<void> {
  try {
    const agentId = useStore.getState().currentAgentId || '';
    if (!agentId) {
      useStore.getState().addToast(
        t('settings.skills.installError') + ': no current agent',
        'error',
      );
      return;
    }
    const res = await codiaFetch(`/api/skills/install?agentId=${encodeURIComponent(agentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, ...(sessionPath ? { sessionPath } : {}) }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    useStore.getState().addToast(
      t('settings.skills.installSuccess', { name: data.skill?.name || '' }),
      'success',
    );
  } catch (err) {
    useStore.getState().addToast(
      t('settings.skills.installError') + ': ' + (err instanceof Error ? err.message : String(err)),
      'error',
    );
  }
}

function chatAudioMimeTypeForName(name: string): string {
  const ext = name.toLowerCase().replace(/^.*\./, '');
  const mimeMap: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    weba: 'audio/webm',
    webm: 'audio/webm',
  };
  return mimeMap[ext] || 'audio/wav';
}

async function computeAudioWaveformsForPaths(
  srcPaths: readonly string[],
  readFileBase64?: (filePath: string) => Promise<string | null | undefined>,
): Promise<Record<string, { waveform: AudioWaveform }>> {
  const out: Record<string, { waveform: AudioWaveform }> = {};
  if (!readFileBase64) return out;
  for (const srcPath of srcPaths) {
    const name = baseName(srcPath);
    if (!isAudioFileName(name)) continue;
    try {
      const mimeType = chatAudioMimeTypeForName(name);
      const base64 = await readFileBase64(srcPath);
      const waveform = base64 ? await buildWaveformFromBase64(base64, mimeType) : undefined;
      if (waveform) out[srcPath] = { waveform };
    } catch (err) {
      console.warn('[upload] failed to compute audio waveform', err);
    }
  }
  return out;
}

/**
 * Attach local file paths to the current chat.
 */
export async function attachFilesFromPaths(
  srcPaths: string[],
  nameMap: Record<string, string> = {},
  options: { channelId?: string | null } = {},
): Promise<void> {
  if (srcPaths.length === 0) return;
  if (toArray(useStore.getState().attachedFiles).length >= 9) return;

  const getSupportsVision = () => {
    const state = useStore.getState();
    const sessionModel = state.currentSessionPath ? sessionScopedValue(state, state.sessionModelsByPath, state.currentSessionPath) : undefined;
    const globalModel = toArray<typeof state.models[number]>(state.models).find((model) => model.isCurrent);
    return modelSupportsImageInput(sessionModel || globalModel);
  };

  const desktopApi = getDesktopApi();
  const readFileBase64 = desktopApi?.readFileBase64?.bind(desktopApi);
  const metadataByPath = await computeAudioWaveformsForPaths(srcPaths, readFileBase64);
  let attachedImageCount = 0;
  const maybeNotifyVisionMismatch = () => {
    if (attachedImageCount > 0 && !getSupportsVision()) {
      useStore.getState().addToast(t('error.modelNoVision'), 'info');
    }
  };

  const addPreparedAttachment = async (file: AttachedFile) => {
    const prepared = isImageFile(file.name)
      ? await prepareImageAttachmentForVision(file, readFileBase64)
      : file;
    if (!prepared.isDirectory && isImageFile(prepared.name)) {
      attachedImageCount += 1;
    }
    useStore.getState().addAttachedFile(prepared);
  };

  // Install .skill files directly instead of attaching them to chat.
  const skillPaths = srcPaths.filter(p => /\.skill$/i.test(p));
  if (skillPaths.length) {
    srcPaths = srcPaths.filter(p => !skillPaths.includes(p));
    const sessionPath = useStore.getState().currentSessionPath || null;
    for (const p of skillPaths) installSkillFile(p, sessionPath);
    if (srcPaths.length === 0) return;
  }

  // Attach Desk files directly without re-uploading them.
  const s = useStore.getState();
  const deskBase = toSlash(s.deskBasePath ?? '').replace(/\/+$/, '');
  if (deskBase) {
    const prefix = deskBase + '/';
    const deskFileMap = new Map(s.deskFiles.map((f: any) => [f.name, f]));
    const isDeskPath = (p: string) => { const s = toSlash(p); return s === deskBase || s.startsWith(prefix); };
    const deskPaths = srcPaths.filter(isDeskPath);
    srcPaths = srcPaths.filter((p) => !isDeskPath(p));
    for (const p of deskPaths) {
      if (toArray(useStore.getState().attachedFiles).length >= 9) break;
      const name = baseName(p);
      const isRoot = toSlash(p) === deskBase;
      const knownFile = deskFileMap.get(name);
      await addPreparedAttachment({
        path: p,
        name,
        isDirectory: isRoot || (knownFile?.isDir ?? false),
        ...(metadataByPath[p]?.waveform ? { waveform: metadataByPath[p].waveform } : {}),
      });
    }
  }
  if (srcPaths.length === 0) {
    maybeNotifyVisionMismatch();
    return;
  }

  try {
    const sessionPath = useStore.getState().currentSessionPath || null;
    const channelId = typeof options.channelId === 'string' && options.channelId ? options.channelId : null;
    const res = await codiaFetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: srcPaths,
        ...(Object.keys(metadataByPath).length ? { metadataByPath } : {}),
        ...(channelId
          ? { resourceScope: 'channel', channelId }
          : sessionPath ? { sessionPath } : {}),
      }),
    });
    const data = await res.json();
    const failed: string[] = [];
    for (const item of data.uploads || []) {
      if (item.dest) {
        await addPreparedAttachment({
          fileId: item.fileId,
          path: item.dest,
          name: item.name,
          isDirectory: item.isDirectory || false,
          ...(item.mime ? { mimeType: item.mime } : {}),
          ...(item.resource ? { resource: item.resource } : {}),
        });
      } else if (item.error) {
        failed.push(nameMap[item.src] || baseName(item.src));
      }
    }
    if (failed.length > 0) {
      useStore.getState().addToast(
        t('error.uploadPartialFail', { files: failed.join(', ') }),
        'error',
      );
    }
    maybeNotifyVisionMismatch();
  } catch (err) {
    console.error('[upload]', err);
    useStore.getState().addToast(
      t('error.uploadFailed'),
      'error',
    );
  }
}

export async function attachAppFileDragPayloadToInput(payload: AppFileDragPayload): Promise<void> {
  if (payload.files.length === 0) return;
  if (toArray(useStore.getState().attachedFiles).length >= 9) return;

  if (payload.source === 'session-file') {
    for (const file of payload.files) {
      if (toArray(useStore.getState().attachedFiles).length >= 9) break;
      useStore.getState().addAttachedFile({
        fileId: file.fileId,
        path: file.path,
        name: file.name,
        isDirectory: file.isDirectory || false,
        ...(file.base64Data ? { base64Data: file.base64Data } : {}),
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      });
    }
    return;
  }

  const paths = payload.files
    .filter(file => file.path)
    .map(file => file.path);
  await attachFilesFromPaths(paths);
}

async function handleDrop(e: React.DragEvent): Promise<void> {
  const appPayload = readAppFileDragPayload(e.dataTransfer);
  if (appPayload) {
    clearAppFileDragPayload(appPayload.dragId);
    await attachAppFileDragPayloadToInput(appPayload);
    return;
  }

  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  const { paths, nameMap } = await resolveBrowserFilePaths(Array.from(files));
  await attachFilesFromPaths(paths, nameMap);
}

// Drop text

function DropText() {
  const agentName = useStore(s => s.agentName);
  return <span className="drop-text">{t('drop.hint', { name: agentName })}</span>;
}

//

export function MainContent({ children }: { children: React.ReactNode }) {
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const currentTab = useStore(s => s.currentTab);
  const welcomeMode = welcomeVisible && currentTab === 'chat';

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) setDragActive(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragActive(false);
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => e.preventDefault(), []);
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragActive(false);
    handleDrop(e);
  }, []);

  return (
    <div
      className={`main-content${welcomeMode ? ' welcome-mode' : ''}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <BrowserCard />
      <ComputerUseOverlay />
      <div className={`drop-overlay${dragActive ? ' visible' : ''}`}>
        <div className="drop-overlay-inner">
          <span className="drop-icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.4 11.6 12 21a6 6 0 0 1-8.5-8.5l9.9-9.9a4 4 0 0 1 5.7 5.7l-9.9 9.9a2 2 0 0 1-2.8-2.8l9.4-9.4" />
            </svg>
          </span>
          <DropText />
        </div>
      </div>
      {children}
    </div>
  );
}
