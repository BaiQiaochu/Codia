import React, { useState } from 'react';
import { t } from '../helpers';
import { useSettingsStore } from '../store';
import { getDesktopApi } from '../../utils/desktop-api';
import { NumberInput } from '../components/NumberInput';
import { SettingsButton } from '../components/SettingsButton';
import {
  SCREENSHOT_SEGMENT_VISIBLE_CHAR_LIMIT,
  SCREENSHOT_SEGMENT_VISIBLE_CHAR_LIMIT_STORAGE_KEY,
  readScreenshotSegmentVisibleCharLimit,
} from '../../utils/screenshot-segments';
import styles from '../Settings.module.css';

import codiaMobile from '../../../assets/screenshot-previews/codia-mobile.png';
import codiaDesktop from '../../../assets/screenshot-previews/codia-desktop.png';

const PREVIEW_IMAGES: Record<string, string> = {
  'codia-mobile': codiaMobile,
  'codia-desktop': codiaDesktop,
};

function readScreenshotColor() {
  const stored = localStorage.getItem('codia-screenshot-color');
  return stored === 'codia' ? stored : 'codia';
}

export function SharingTab() {
  const { showToast } = useSettingsStore();
  const [screenshotColor, setScreenshotColor] = useState(
    () => readScreenshotColor()
  );
  const [screenshotWidth, setScreenshotWidth] = useState(
    () => localStorage.getItem('codia-screenshot-width') || 'mobile'
  );
  const [segmentLimit, setSegmentLimit] = useState(() => readScreenshotSegmentVisibleCharLimit());

  const savePreviewButtonClass = `${styles['sharing-action-btn']} ${styles['ss-save-btn']}`;

  const handleSegmentLimitChange = (value: number) => {
    const next = Math.max(1_000, Math.min(100_000, Math.round(value)));
    setSegmentLimit(next);
    if (next === SCREENSHOT_SEGMENT_VISIBLE_CHAR_LIMIT) {
      localStorage.removeItem(SCREENSHOT_SEGMENT_VISIBLE_CHAR_LIMIT_STORAGE_KEY);
    } else {
      localStorage.setItem(SCREENSHOT_SEGMENT_VISIBLE_CHAR_LIMIT_STORAGE_KEY, String(next));
    }
  };

  const savePreview = async () => {
    const theme = `${screenshotColor}-${screenshotWidth}`;
    try {
      const result = await getDesktopApi()?.saveScreenshotPreview?.({ theme });
      if (result?.success) {
        showToast(t('common.screenshotSaved'), 'success');
      } else if (!result?.canceled) {
        showToast(`${t('common.screenshotFailed')}: ${result?.error || 'unknown'}`, 'error');
      }
    } catch (err) {
      showToast(`${t('common.screenshotFailed')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="sharing">
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.screenshot.title')}</h2>
        <p className={styles['settings-section-desc']}>{t('settings.screenshot.desc')}</p>

        <div className={styles['theme-options']}>
          {([
            { key: 'codia' as const, labelKey: 'settings.screenshot.codia' },
          ]).map(({ key, labelKey }) => (
            <button type="button"
              key={key}
              className={`${styles['theme-card']}${screenshotColor === key ? ' ' + styles['active'] : ''}`}
              data-theme={`screenshot-${key}`}
              onClick={() => { setScreenshotColor(key); localStorage.setItem('codia-screenshot-color', key); }}
            >
              <div className={styles['theme-card-name']}>{t(labelKey)}</div>
              <div className={styles['theme-card-mode']}>{t('settings.screenshot.title')}</div>
            </button>
          ))}
        </div>

        <div className={styles['ss-layout-group']}>
          {([
            { width: 'mobile' as const, title: t('settings.screenshot.mobileTitle'), desc: t('settings.screenshot.mobileDesc') },
            { width: 'desktop' as const, title: t('settings.screenshot.desktopTitle'), desc: t('settings.screenshot.desktopDesc') },
          ]).map(({ width, title, desc }) => {
            const key = `${screenshotColor}-${width}`;
            const src = PREVIEW_IMAGES[key];
            return (
              <button type="button"
                key={width}
                className={`${styles['ss-layout-card']}${screenshotWidth === width ? ' ' + styles['active'] : ''}`}
                onClick={() => { setScreenshotWidth(width); localStorage.setItem('codia-screenshot-width', width); }}
              >
                <div className={styles['ss-layout-preview']}>
                  {src ? (
                    <img src={src} alt={title} draggable={false} />
                  ) : null}
                </div>
                <div className={styles['ss-layout-info']}>
                  <div className={styles['ss-layout-title']}>{title}</div>
                  <div className={styles['ss-layout-desc']}>{desc}</div>
                </div>
              </button>
            );
          })}
        </div>
        <div className={styles['ss-save-row']}>
          <SettingsButton variant="primary" className={savePreviewButtonClass} onClick={savePreview}>
            {t('settings.screenshot.saveCurrentPreview')}
          </SettingsButton>
        </div>

        <div className={styles['tool-caps-group']} style={{ marginTop: 12 }}>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.screenshot.segmentTitle')}</span>
              <span className={styles['tool-caps-desc']}>
                {t('settings.screenshot.segmentLimitHint')}
              </span>
            </div>
            <NumberInput
              value={segmentLimit}
              onChange={handleSegmentLimitChange}
              min={1000}
              max={100000}
              step={1000}
              unit={t('settings.screenshot.segmentLimitUnit')}
            />
          </div>
        </div>
      </section>

    </div>
  );
}
