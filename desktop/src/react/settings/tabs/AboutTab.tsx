import { useEffect, useState } from 'react';
import { t } from '../helpers';
import { getDesktopApi } from '../../utils/desktop-api';
import { SettingsSection } from '../components/SettingsSection';
import iconUrl from '../../../assets/codia/codia-flower.png';
import styles from '../Settings.module.css';
import { GeneralSettingsSections } from './GeneralTab';
import { InterfaceSettingsSections } from './InterfaceTab';

declare const __BYOUNG_APP_VERSION__: string | undefined;

const BUILD_VERSION = typeof __BYOUNG_APP_VERSION__ === 'string'
  ? __BYOUNG_APP_VERSION__.trim()
  : '';

export function AboutTab() {
  const desktopApi = getDesktopApi();
  const [version, setVersion] = useState(BUILD_VERSION);

  useEffect(() => {
    desktopApi?.getAppVersion?.()
      .then((v: string) => setVersion(v || BUILD_VERSION))
      .catch(() => setVersion(BUILD_VERSION));
  }, [desktopApi]);

  return (
    <div className={`${styles['settings-tab-content']} ${styles.active}`} data-tab="about">
      <GeneralSettingsSections />
      <InterfaceSettingsSections />
      <SettingsSection title={t('settings.about.title')}>
        <div className={styles['product-info-card']}>
          <img className={styles['product-info-icon']} src={iconUrl} alt="Codia 小豆蔻" />
          <div className={styles['product-info-copy']}>
            <strong className={styles['product-info-name']}>Codia · 小豆蔻</strong>
            <span className={styles['product-info-tagline']}>{t('settings.about.tagline')}</span>
            {version ? <span className={styles['product-info-version']}>v{version}</span> : null}
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
