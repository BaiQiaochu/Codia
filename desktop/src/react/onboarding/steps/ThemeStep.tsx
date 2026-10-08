/**
 * ThemeStep.tsx — Step 4: Theme selection
 */

import { useState } from 'react';
import settingsStyles from '../../settings/Settings.module.css';
import { OB_THEMES, themeKey } from '../constants';
import { StepContainer } from '../onboarding-ui';
import registry from '../../../shared/theme-registry';

interface ThemeStepProps {
  backStep?: number;
  goToStep: (index: number) => void;
}

export function ThemeStep({ goToStep, backStep = 3 }: ThemeStepProps) {
  const [activeTheme, setActiveTheme] = useState(() =>
    registry.migrateSavedTheme(localStorage.getItem(registry.STORAGE_KEY) || localStorage.getItem(registry.LEGACY_STORAGE_KEY))
  );

  return (
    <StepContainer className="onboarding-theme-step">
      <h1 className="onboarding-title">{t('onboarding.theme.title')}</h1>
      <p className="onboarding-subtitle">{t('onboarding.theme.subtitle')}</p>

      <div className={`${settingsStyles['theme-options']} onboarding-theme-options`}>
        {OB_THEMES.map(theme => {
          const key = themeKey(theme);
          return (
            <button
              key={theme}
              type="button"
              className={`${settingsStyles['theme-card']} onboarding-theme-card${activeTheme === theme ? ' ' + settingsStyles['active'] : ''}`}
              data-theme={theme}
              onClick={() => {
                setActiveTheme(theme);
                setTheme(theme);
              }}
            >
              <div className={settingsStyles['theme-card-name']}>{t(`settings.appearance.${key}`)}</div>
              <div className={settingsStyles['theme-card-mode']}>{t(`settings.appearance.${key}Mode`)}</div>
            </button>
          );
        })}
      </div>

      <div className="onboarding-actions">
        <button type="button" className="ob-btn ob-btn-secondary" onClick={() => goToStep(backStep)}>
          {t('onboarding.theme.back')}
        </button>
        <button type="button" className="ob-btn ob-btn-primary" onClick={() => goToStep(5)}>
          {t('onboarding.theme.next')}
        </button>
      </div>
    </StepContainer>
  );
}
