/**
 * OnboardingApp.tsx - first-run setup orchestration.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { TOTAL_STEPS } from './constants';
import type { codiaFetch } from './onboarding-actions';
import { LocaleStep } from './steps/LocaleStep';
import { NameStep } from './steps/NameStep';
import { ProviderStep } from './steps/ProviderStep';
import { ModelStep } from './steps/ModelStep';
import { ThemeStep } from './steps/ThemeStep';
import { WorkspaceStep } from './steps/WorkspaceStep';
import { TutorialStep } from './steps/TutorialStep';
import { getDesktopApi } from '../utils/desktop-api';
import codiaBrandEmblem from '../../assets/codia/codia-brand-emblem.png';

interface OnboardingAppProps { preview: boolean; skipToTutorial: boolean }
export function OnboardingApp({ preview, skipToTutorial }: OnboardingAppProps) {
  const [serverPort, setServerPort] = useState<string | null>(null);
  const [serverToken, setServerToken] = useState<string | null>(null);
  const [step, setStep] = useState(skipToTutorial ? 6 : 0);
  const [stepKey, setStepKey] = useState(0);
  const avatarSrc = codiaBrandEmblem;
  const [locale, setLocale] = useState('zh-CN');
  const [i18nReady, setI18nReady] = useState(false);

  // Provider info passed from ProviderStep to ModelStep
  const [providerName, setProviderName] = useState('');
  const [providerUrl, setProviderUrl] = useState('');
  const [providerApi, setProviderApi] = useState('openai-completions');
  const [apiKey, setApiKey] = useState('');

  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const codiaFetch: codiaFetch = useCallback((path, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
    if (serverToken) headers['Authorization'] = `Bearer ${serverToken}`;
    return fetch(`http://127.0.0.1:${serverPort}${path}`, { ...opts, headers });
  }, [serverPort, serverToken]);

  const showError = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 3000);
  }, []);

  const goToStep = useCallback((index: number) => {
    if (index < 0 || index >= TOTAL_STEPS) return;
    setStepKey(k => k + 1);
    setStep(index);
  }, []);

  const onLocaleChange = useCallback((loc: string) => {
    setLocale(loc);
    setI18nReady(false);
    requestAnimationFrame(() => setI18nReady(true));
  }, []);

  const onProviderReady = useCallback((name: string, url: string, api: string, key: string) => {
    setProviderName(name);
    setProviderUrl(url);
    setProviderApi(api);
    setApiKey(key);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const desktopApi = getDesktopApi();
        if (!desktopApi) throw new Error('desktop api unavailable');
        const port = await desktopApi.getServerPort();
        const token = await desktopApi.getServerToken();
        setServerPort(port);
        setServerToken(token);
        const splashInfo = await desktopApi.getSplashInfo?.().catch((err: unknown) => {
          console.warn('[onboarding] splash info unavailable:', err);
          return null;
        });
        const loc = splashInfo?.locale || 'zh-CN';
        const name = splashInfo?.agentName || t('onboarding.defaultAgentName');
        setLocale(loc);
        await i18n.load(loc);
        i18n.defaultName = name;
        setI18nReady(true);
      } catch (err) {
        console.error('[onboarding] init failed:', err);
        try {
          await i18n.load('zh-CN');
        } catch { /* keep fallback text below */ }
        i18n.defaultName = '小豆蔻';
        setLocale('zh-CN');
        setI18nReady(true);
        showError('初始化失败，请重启应用');
      }
    })();
  }, [showError]);

  if (!i18nReady) {
    return (
      <div className="onboarding">
        <div className="onboarding-step active">
          <img className="onboarding-avatar" src={avatarSrc} draggable={false} alt="Codia" />
          <h1 className="onboarding-title">Codia · 小豆蔻</h1>
          <p className="onboarding-subtitle">正在初始化...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding">
      <div className="onboarding-progress">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div key={`dot-${i}`} className={`onboarding-dot${i === step ? ' active' : ''}${i < step ? ' done' : ''}`} />
        ))}
      </div>

      {step === 0 && <LocaleStep key={`step-0-${stepKey}`} preview={preview} codiaFetch={codiaFetch} avatarSrc={avatarSrc} initialLocale={locale} goToStep={goToStep} showError={showError} onLocaleChange={onLocaleChange} />}
      {step === 1 && <NameStep key={`step-1-${stepKey}`} preview={preview} codiaFetch={codiaFetch} goToStep={goToStep} showError={showError} />}
      {step === 2 && <ProviderStep key={`step-2-${stepKey}`} preview={preview} codiaFetch={codiaFetch} goToStep={goToStep} showError={showError} onProviderReady={onProviderReady} />}
      {step === 3 && <ModelStep key={`step-3-${stepKey}`} preview={preview} codiaFetch={codiaFetch} providerName={providerName} providerUrl={providerUrl} providerApi={providerApi} apiKey={apiKey} goToStep={goToStep} showError={showError} />}
      {step === 4 && <ThemeStep key={`step-4-${stepKey}`} goToStep={goToStep} />}
      {step === 5 && <WorkspaceStep key={`step-5-${stepKey}`} preview={preview} codiaFetch={codiaFetch} goToStep={goToStep} showError={showError} />}
      {step === 6 && <TutorialStep key={`step-6-${stepKey}`} preview={preview} showError={showError} />}

      {toastMsg && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: 'var(--coral, #c66)', color: '#fff', padding: '8px 20px', borderRadius: 8, fontSize: '0.82rem', zIndex: 999 }}>
          {toastMsg}
        </div>
      )}
    </div>
  );
}

