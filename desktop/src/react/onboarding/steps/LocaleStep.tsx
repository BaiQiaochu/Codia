/**
 * LocaleStep.tsx - language selection.
 */

import { useState, useCallback } from 'react';
import { LOCALES } from '../constants';
import { saveLocale } from '../onboarding-actions';
import type { gsapFetch } from '../onboarding-actions';
import { StepContainer, Multiline } from '../onboarding-ui';

interface LocaleStepProps {
  preview: boolean;
  gsapFetch: gsapFetch;
  avatarSrc: string;
  initialLocale: string;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
  onLocaleChange: (locale: string) => void;
}

export function LocaleStep({
  preview, gsapFetch, avatarSrc, initialLocale,
  goToStep, showError, onLocaleChange,
}: LocaleStepProps) {
  const [locale, setLocale] = useState(initialLocale);

  const changeLocale = useCallback(async (loc: string) => {
    if (locale === loc) return;
    setLocale(loc);
    onLocaleChange(loc);
    await i18n.load(loc);
  }, [locale, onLocaleChange]);

  const onNext = useCallback(async () => {
    if (!preview) {
      try {
        await saveLocale(gsapFetch, locale);
      } catch (err) {
        console.error('[onboarding] save locale failed:', err);
        showError(t('onboarding.error'));
        return;
      }
    }
    goToStep(1);
  }, [preview, gsapFetch, locale, goToStep, showError]);

  return (
    <StepContainer>
      {avatarSrc ? (
        <img className="onboarding-avatar" src={avatarSrc} draggable={false} alt="" />
      ) : (
        <div className="onboarding-avatar onboarding-avatar-placeholder" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
            <path d="M12 12l8-4.5" />
            <path d="M12 12v9" />
            <path d="M12 12L4 7.5" />
          </svg>
        </div>
      )}
      <h1 className="onboarding-title">{t('onboarding.welcome.title')}</h1>
      <Multiline className="onboarding-subtitle" text={t('onboarding.welcome.subtitle')} />
      <div className="ob-locale-picker">
        {LOCALES.map(loc => (
          <button type="button"
            key={loc.value}
            className={`ob-locale-btn${locale === loc.value ? ' active' : ''}`}
            onClick={() => changeLocale(loc.value)}
          >
            <span>{loc.label}</span>
          </button>
        ))}
      </div>
      <div className="onboarding-actions">
        <button type="button" className="ob-btn ob-btn-primary" onClick={onNext}>
          {t('onboarding.welcome.next')}
        </button>
      </div>
    </StepContainer>
  );
}
