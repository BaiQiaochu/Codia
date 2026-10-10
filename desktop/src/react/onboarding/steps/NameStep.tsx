import { useState, useCallback } from 'react';
import { Toggle } from '../../settings/widgets/Toggle';
import { saveOnboardingIdentity } from '../onboarding-actions';
import type { codiaFetch } from '../onboarding-actions';
import { StepContainer } from '../onboarding-ui';

interface NameStepProps {
  preview: boolean;
  codiaFetch: codiaFetch;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
}

export function NameStep({ preview, codiaFetch, goToStep, showError }: NameStepProps) {
  const [userName, setUserName] = useState('');
  const [agentName, setAgentName] = useState('');
  const [memoryEnabled, setMemoryEnabled] = useState(true);

  const onNext = useCallback(async () => {
    if (preview) { goToStep(2); return; }
    const trimmed = userName.trim();
    if (!trimmed) return;
    try {
      await saveOnboardingIdentity({
        codiaFetch,
        userName: trimmed,
        agentName,
        memoryEnabled,
      });
      goToStep(2);
    } catch (err) {
      console.error('[onboarding] save identity failed:', err);
      showError(t('onboarding.error'));
    }
  }, [preview, codiaFetch, userName, agentName, memoryEnabled, goToStep, showError]);

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.name.title')}</h1>
      <p className="onboarding-subtitle">{t('onboarding.name.subtitle')}</p>
      <div className="ob-name-form">
        <label className="ob-name-field">
          <span className="ob-field-label">{t('onboarding.name.userLabel')}</span>
          <input
            className="ob-input"
            type="text"
            placeholder={t('onboarding.name.placeholder')}
            value={userName}
            onChange={e => setUserName(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="ob-name-field">
          <span className="ob-field-label">{t('onboarding.name.agentLabel')}</span>
          <input
            className="ob-input"
            type="text"
            placeholder={t('onboarding.name.agentPlaceholder')}
            value={agentName}
            onChange={e => setAgentName(e.target.value)}
            autoComplete="off"
          />
        </label>
        <div className="ob-memory-row">
          <div className="ob-memory-copy">
            <span className="ob-memory-title">{t('onboarding.name.memoryTitle')}</span>
            <span className="ob-memory-hint">{t('onboarding.name.memoryHint')}</span>
          </div>
          <div className="ob-memory-toggle">
            <Toggle on={memoryEnabled} onChange={setMemoryEnabled} label={t('onboarding.name.memoryTitle')} />
          </div>
        </div>
      </div>
      <div className="onboarding-actions">
        <button type="button" className="ob-btn ob-btn-secondary" onClick={() => goToStep(0)}>
          {t('onboarding.name.back')}
        </button>
        <button
          type="button"
          className="ob-btn ob-btn-primary"
          disabled={!preview && !userName.trim()}
          onClick={onNext}
        >
          {t('onboarding.name.next')}
        </button>
      </div>
    </StepContainer>
  );
}
