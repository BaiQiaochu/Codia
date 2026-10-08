import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import styles from './FloatingActions.module.css';
import { COVER_GALLERY_ITEMS, type CoverGalleryItem } from './cover-gallery-assets';
import {
  applyMarkdownCoverImage,
  applyMarkdownCoverPreset,
  dispatchCoverNotice,
  type MarkdownCoverImageInput,
  type MarkdownCoverTargetInput,
  requestMarkdownCoverGeneration,
  type WorkbenchMarkdownCoverTarget,
} from '../../utils/markdown-cover-generation';
import { gsapFetch } from '../../hooks/use-gsap-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { Tooltip } from '../../ui';
import { extOfName, inferKindByExt } from '../../utils/file-kind';
import { isRemoteWorkbenchContentRef, normalizeWorkbenchContentRef } from '../../utils/remote-file-preview';
import type { RemoteWorkbenchContentRef } from '../../types';

interface Props {
  content: string;
  filePath?: string;
  remoteContentRef?: RemoteWorkbenchContentRef | null;
  contentType?: string;
  language?: string | null;
  editable?: boolean;
  onDetach?: () => void;
  showMarkdownPreviewToggle?: boolean;
  markdownPreviewActive?: boolean;
  onToggleMarkdownPreview?: () => void;
}

type CoverGenerationStatus = {
  enabled?: boolean;
  executorAgentId?: string | null;
  disabledReason?: string | null;
  message?: string | null;
  settingsTarget?: string | null;
};

type CoverStatus = {
  systemCover?: {
    available?: boolean;
  };
  agentGenerate?: CoverGenerationStatus;
  available?: boolean;
  enabled?: boolean;
  agentId?: string | null;
};

function tr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function getAgentGenerateDisabledText(status: CoverGenerationStatus, t: (key: string) => string): string {
  if (status.message) return status.message;
  switch (status.disabledReason) {
    case 'beautify-disabled':
      return tr(t, 'cover.agentGenerate.beautifyDisabled', '文档美化工具已在助理工具设置中关闭。');
    case 'default-image-model-missing':
      return tr(t, 'cover.agentGenerate.defaultModelMissing', '尚未配置默认图片模型。');
    case 'default-image-model-invalid':
      return tr(t, 'cover.agentGenerate.defaultModelInvalid', '默认图片模型不可用。');
    case 'image-gen-unavailable':
      return tr(t, 'cover.agentGenerate.imageGenUnavailable', '图片生成运行时不可用。');
    case 'agent-unavailable':
      return tr(t, 'cover.agentGenerate.agentUnavailable', '当前助理不可用。');
    default:
      return tr(t, 'cover.agentGenerate.disabled', 'AI 生成当前不可用。');
  }
}

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || 'cover.png';
}

function remoteRefToCoverTarget(ref: RemoteWorkbenchContentRef): WorkbenchMarkdownCoverTarget {
  const normalized = normalizeWorkbenchContentRef(ref);
  return {
    kind: 'workbench-file',
    mountId: normalized.mountId || normalized.rootId || 'default',
    subdir: normalized.subdir,
    name: normalized.name,
  };
}

function readBrowserFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('failed to read cover image'));
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',').pop() || '' : result);
    };
    reader.readAsDataURL(file);
  });
}

function CoverPaletteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5a8.5 8.5 0 0 0 0 17h1.4a1.55 1.55 0 0 0 1.1-2.65l-.18-.18a1.18 1.18 0 0 1 .83-2.02H17a4 4 0 0 0 4-4c0-4.5-3.86-8.15-9-8.15z" />
      <circle cx="7.7" cy="10.2" r="1" />
      <circle cx="10.2" cy="7.4" r="1" />
      <circle cx="14" cy="7.6" r="1" />
      <circle cx="16.7" cy="10.3" r="1" />
    </svg>
  );
}

function GenerateCoverIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.2 3.3L16.5 7.5l-3.3 1.2L12 12l-1.2-3.3-3.3-1.2 3.3-1.2L12 3z" />
      <path d="M18 13l.8 2.2L21 16l-2.2.8L18 19l-.8-2.2L15 16l2.2-.8L18 13z" />
      <path d="M6 14l.6 1.6L8.2 16.2l-1.6.6L6 18.4l-.6-1.6-1.6-.6 1.6-.6L6 14z" />
    </svg>
  );
}

function GalleryCoverIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4" width="14" height="12" rx="1.5" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
      <path d="M8 12.8l2.5-2.4 2 1.8 2-2.2L17 12.8" />
    </svg>
  );
}

function UploadCoverIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16" />
    </svg>
  );
}

export function FloatingActions({
  content,
  filePath,
  remoteContentRef,
  contentType,
  language,
  editable = false,
  onDetach,
  showMarkdownPreviewToggle = false,
  markdownPreviewActive = false,
  onToggleMarkdownPreview,
}: Props) {
  const [copyLabel, setCopyLabel] = useState<string | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverMenuOpen, setCoverMenuOpen] = useState(false);
  const [coverGalleryOpen, setCoverGalleryOpen] = useState(false);
  const [coverStatus, setCoverStatus] = useState<CoverStatus | null>(null);
  const [coverStatusRefreshing, setCoverStatusRefreshing] = useState(false);
  const [brokenCoverGalleryIds, setBrokenCoverGalleryIds] = useState<ReadonlySet<string>>(() => new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coverStatusRequestRef = useRef(0);
  const coverMenuRef = useRef<HTMLDivElement | null>(null);
  const floatingActionsRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { t } = useI18n();

  const coverTarget = useMemo<MarkdownCoverTargetInput | null>(() => {
    if (filePath) return { filePath };
    if (isRemoteWorkbenchContentRef(remoteContentRef)) return { target: remoteRefToCoverTarget(remoteContentRef) };
    return null;
  }, [filePath, remoteContentRef]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    if (!coverMenuOpen && !coverGalleryOpen) return undefined;
    const close = (event: PointerEvent) => {
      if (floatingActionsRef.current?.contains(event.target as Node)) return;
      setCoverMenuOpen(false);
      setCoverGalleryOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [coverGalleryOpen, coverMenuOpen]);

  const refreshCoverStatus = useCallback(async (): Promise<CoverStatus | null> => {
    if (contentType !== 'markdown' || !coverTarget) {
      coverStatusRequestRef.current += 1;
      setCoverStatus(null);
      setCoverStatusRefreshing(false);
      return null;
    }

    const requestId = coverStatusRequestRef.current + 1;
    coverStatusRequestRef.current = requestId;
    setCoverStatusRefreshing(true);
    try {
      const res = await gsapFetch('/api/desk/beautify/status');
      const data = await res.json().catch(() => ({}));
      if (requestId === coverStatusRequestRef.current) {
        setCoverStatus(data || null);
        setCoverStatusRefreshing(false);
      }
      return data || null;
    } catch {
      if (requestId === coverStatusRequestRef.current) {
        setCoverStatus(null);
        setCoverStatusRefreshing(false);
      }
      return null;
    }
  }, [contentType, coverTarget]);

  useEffect(() => {
    let cancelled = false;
    void refreshCoverStatus().then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [refreshCoverStatus]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      const tFn = window.t ?? ((p: string) => p);
      setCopyLabel(tFn('attach.copied'));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopyLabel(null), 1500);
    });
  }, [content]);

  const handleScreenshot = useCallback(async () => {
    const { takeArticleScreenshot } = await import('../../utils/screenshot');
    await takeArticleScreenshot(content, {
      filePath,
      articleType: contentType,
      language,
    });
  }, [content, contentType, filePath, language]);

  const handleGenerateCover = useCallback(async () => {
    if (!coverTarget || contentType !== 'markdown') return;
    setCoverMenuOpen(false);
    setCoverBusy(true);
    try {
      const latestStatus = await refreshCoverStatus();
      const effectiveStatus = latestStatus ?? coverStatus;
      const generationStatus = effectiveStatus?.agentGenerate ?? {};
      const generationEnabled = Boolean(generationStatus.enabled ?? effectiveStatus?.enabled);
      if (!generationEnabled) {
        dispatchCoverNotice(`Cover generation failed: ${getAgentGenerateDisabledText(generationStatus, t)}`, 'error');
        return;
      }
      const executorAgentId = generationStatus.executorAgentId || effectiveStatus?.agentId || undefined;
      const result = await requestMarkdownCoverGeneration({ ...coverTarget, executorAgentId });
      if (result.ok === false) {
        dispatchCoverNotice(`Cover 生成失败：${result.error}`, 'error');
      } else {
        dispatchCoverNotice('已创建 cover 后台任务。', 'success');
      }
    } catch (err) {
      dispatchCoverNotice(`Cover 生成失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setCoverBusy(false);
    }
  }, [contentType, coverStatus, coverTarget, refreshCoverStatus, t]);

  const handleToggleCoverMenu = useCallback(() => {
    setCoverMenuOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) void refreshCoverStatus();
      return nextOpen;
    });
  }, [refreshCoverStatus]);

  const applySelectedCoverImage = useCallback(async (image: MarkdownCoverImageInput) => {
    if (!coverTarget) return;
    setCoverBusy(true);
    try {
      const result = await applyMarkdownCoverImage({ ...coverTarget, ...image });
      if (result.ok === false) {
        dispatchCoverNotice(`Cover 应用失败：${result.error}`, 'error');
      } else {
        dispatchCoverNotice('已应用上传图片为 cover。', 'success');
      }
    } catch (err) {
      dispatchCoverNotice(`Cover 应用失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setCoverBusy(false);
    }
  }, [coverTarget]);

  const handleUploadCover = useCallback(async () => {
    if (!coverTarget || contentType !== 'markdown') return;
    setCoverMenuOpen(false);
    if (typeof window.platform?.selectFiles === 'function') {
      const paths = await window.platform.selectFiles();
      const imageFilePath = paths?.[0];
      if (!imageFilePath) return;
      const kind = inferKindByExt(extOfName(imageFilePath));
      if (kind !== 'image' && kind !== 'svg') {
        dispatchCoverNotice('请选择图片文件作为 cover。', 'error');
        return;
      }
      if ('filePath' in coverTarget && coverTarget.filePath) {
        await applySelectedCoverImage({ imageFilePath });
        return;
      }
      const contentBase64 = await window.platform.readFileBase64?.(imageFilePath);
      if (!contentBase64) {
        dispatchCoverNotice('读取图片失败。', 'error');
        return;
      }
      await applySelectedCoverImage({
        image: {
          filename: fileNameFromPath(imageFilePath),
          contentBase64,
        },
      });
      return;
    }
    fileInputRef.current?.click();
  }, [applySelectedCoverImage, contentType, coverTarget]);

  const handleBrowserCoverInputChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    if (!coverTarget) return;
    const file = event.currentTarget.files?.[0] || null;
    event.currentTarget.value = '';
    if (!file) return;
    const kind = inferKindByExt(extOfName(file.name));
    if (kind !== 'image' && kind !== 'svg') {
      dispatchCoverNotice('请选择图片文件作为 cover。', 'error');
      return;
    }
    try {
      const contentBase64 = await readBrowserFileAsBase64(file);
      if (!contentBase64) {
        dispatchCoverNotice('读取图片失败。', 'error');
        return;
      }
      await applySelectedCoverImage({
        image: {
          filename: file.name || 'cover.png',
          contentBase64,
        },
      });
    } catch (err) {
      dispatchCoverNotice(`Cover 应用失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [applySelectedCoverImage, coverTarget]);

  const handlePresetCover = useCallback(() => {
    setCoverMenuOpen(false);
    setCoverGalleryOpen(true);
  }, []);

  const handleApplyPresetCover = useCallback(async (item: CoverGalleryItem) => {
    if (!coverTarget || contentType !== 'markdown') return;
    setCoverBusy(true);
    try {
      const result = await applyMarkdownCoverPreset({ ...coverTarget, presetId: item.id });
      if (result.ok === false) {
        dispatchCoverNotice(`Cover 应用失败：${result.error}`, 'error');
        return;
      }
      dispatchCoverNotice(`已应用「${item.title}」为 cover。`, 'success');
      setCoverGalleryOpen(false);
    } catch (err) {
      dispatchCoverNotice(`Cover 应用失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setCoverBusy(false);
    }
  }, [contentType, coverTarget]);

  const visibleCoverGalleryItems = useMemo(
    () => COVER_GALLERY_ITEMS.filter(item => !brokenCoverGalleryIds.has(item.id)),
    [brokenCoverGalleryIds],
  );

  const handleCoverGalleryImageError = useCallback((itemId: string) => {
    setBrokenCoverGalleryIds((current) => {
      if (current.has(itemId)) return current;
      const next = new Set(current);
      next.add(itemId);
      return next;
    });
  }, []);

  const systemCoverAvailable = contentType === 'markdown'
    && Boolean(coverTarget)
    && Boolean(coverStatus?.systemCover?.available ?? coverStatus?.available ?? true);
  const agentGenerateStatus = coverStatus?.agentGenerate ?? {};
  const agentGenerateEnabled = coverStatusRefreshing
    || Boolean(agentGenerateStatus.enabled ?? coverStatus?.enabled);
  const agentGenerateDisabledText = getAgentGenerateDisabledText(agentGenerateStatus, t);
  const canSelectCoverFile = typeof window.platform?.selectFiles === 'function'
    || typeof window.FileReader === 'function';
  const coverMakeLabel = tr(t, 'cover.make', '制作 cover');
  const galleryLabel = tr(t, 'cover.gallery.title', '封面图库');
  const uploadLabel = tr(t, 'cover.gallery.upload', '自己上传');
  const aiGenerateLabel = tr(t, 'cover.agentGenerate.label', 'AI 生成');
  const openInWindowLabel = tr(t, 'preview.openInNewWindow', '在独立窗口打开');
  const closeGalleryLabel = tr(t, 'cover.gallery.close', `关闭${galleryLabel}`);
  const floatingActionsClassName = [
    styles.floatingActions,
    (coverMenuOpen || coverGalleryOpen || coverBusy || copyLabel) ? styles.floatingActionsPinned : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={floatingActionsClassName} data-react-managed ref={floatingActionsRef}>
      <div className={styles.floatingActionsSurface}>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={handleCopy}
          title={copyLabel ?? t('attach.copy')}
          aria-label={copyLabel ?? t('attach.copy')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          <span>{copyLabel ?? t('attach.copy')}</span>
        </button>
        {contentType === 'markdown' && coverTarget && systemCoverAvailable && (
          <div className={styles.coverActionWrap} ref={coverMenuRef}>
            <Tooltip content={coverMakeLabel} placement="top" align="end">
              {({ ref, ...tooltipProps }) => (
                <button
                  ref={(node) => ref(node)}
                  type="button"
                  className={`${styles.actionBtn}${coverBusy ? ` ${styles.actionBtnBusy}` : ''}${coverMenuOpen ? ` ${styles.actionBtnActive}` : ''}`}
                  onClick={handleToggleCoverMenu}
                  title={coverMakeLabel}
                  aria-label={coverMakeLabel}
                  disabled={coverBusy}
                  {...tooltipProps}
                >
                  <CoverPaletteIcon />
                </button>
              )}
            </Tooltip>
            {coverMenuOpen && (
              <div className={styles.coverMenu}>
                <Tooltip
                  content={agentGenerateDisabledText}
                  disabled={agentGenerateEnabled}
                  placement="left"
                  align="center"
                >
                  {({ ref, ...tooltipProps }) => (
                    <span
                      className={styles.coverMenuTooltipAnchor}
                      ref={(node) => ref(node)}
                      {...tooltipProps}
                    >
                      <button
                        type="button"
                        onClick={handleGenerateCover}
                        disabled={coverBusy || !agentGenerateEnabled}
                        title={agentGenerateEnabled ? aiGenerateLabel : agentGenerateDisabledText}
                      >
                        <span className={styles.coverMenuIcon}><GenerateCoverIcon /></span>
                        <span>{aiGenerateLabel}</span>
                      </button>
                    </span>
                  )}
                </Tooltip>
                <button type="button" onClick={handlePresetCover}>
                  <span className={styles.coverMenuIcon}><GalleryCoverIcon /></span>
                  <span>{galleryLabel}</span>
                </button>
                {canSelectCoverFile && (
                  <button type="button" onClick={handleUploadCover}>
                    <span className={styles.coverMenuIcon}><UploadCoverIcon /></span>
                    <span>{uploadLabel}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {coverGalleryOpen && (
          <div className={styles.coverGalleryCard} role="dialog" aria-label={galleryLabel}>
            <div className={styles.coverGalleryHeader}>
              <div>
                <div className={styles.coverGalleryTitle}>{galleryLabel}</div>
              </div>
              <button
                type="button"
                className={styles.coverGalleryClose}
                onClick={() => setCoverGalleryOpen(false)}
                aria-label={closeGalleryLabel}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 6L6 18" />
                  <path d="M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className={styles.coverGalleryGrid}>
              {visibleCoverGalleryItems.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={styles.coverGalleryItem}
                  onClick={() => handleApplyPresetCover(item)}
                  disabled={coverBusy}
                  aria-label={item.title}
                  title={item.title}
                >
                  <span className={styles.coverGalleryThumb}>
                    <img
                      src={item.src}
                      alt=""
                      draggable={false}
                      loading="lazy"
                      decoding="async"
                      onError={() => handleCoverGalleryImageError(item.id)}
                    />
                  </span>
                  <span className={styles.coverGalleryName}>{item.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {showMarkdownPreviewToggle && (
          <Tooltip content={t(markdownPreviewActive ? 'preview.exitMarkdownPreview' : 'preview.markdownPreview')} placement="top" align="end">
            {({ ref, ...tooltipProps }) => (
              <button
                ref={(node) => ref(node)}
                type="button"
                className={`${styles.actionBtn}${markdownPreviewActive ? ` ${styles.actionBtnActive}` : ''}`}
                onClick={onToggleMarkdownPreview}
                title={t(markdownPreviewActive ? 'preview.exitMarkdownPreview' : 'preview.markdownPreview')}
                aria-label={t('preview.markdownPreview')}
                {...tooltipProps}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            )}
          </Tooltip>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.svg"
          hidden
          onChange={handleBrowserCoverInputChange}
        />
        {editable && onDetach && (
          <Tooltip content={openInWindowLabel} placement="top" align="end">
            {({ ref, ...tooltipProps }) => (
              <button
                ref={(node) => ref(node)}
                type="button"
                className={styles.actionBtn}
                title={openInWindowLabel}
                aria-label={openInWindowLabel}
                onClick={onDetach}
                {...tooltipProps}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="7" width="15" height="15" rx="2" ry="2" />
                  <path d="M7 2h15v15" />
                </svg>
              </button>
            )}
          </Tooltip>
        )}
        <Tooltip content={t('common.screenshot')} placement="top" align="end">
          {({ ref, ...tooltipProps }) => (
            <button
              ref={(node) => ref(node)}
              type="button"
              className={styles.actionBtn}
              onClick={handleScreenshot}
              title={t('common.screenshot')}
              aria-label={t('common.screenshot')}
              {...tooltipProps}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </button>
          )}
        </Tooltip>
      </div>
    </div>
  );
}
