import type { RefObject } from 'react';
import { Paperclip, Sparkle } from '@phosphor-icons/react';
import { useStore } from '../../stores';
import styles from './InputArea.module.css';

interface InputUtilityButtonsProps {
  t: (key: string) => string;
  onAttach: () => void;
  attachDisabled?: boolean;
  onBeforeOpenSkills?: () => void;
  mobileCommands?: {
    open: boolean;
    buttonRef: RefObject<HTMLButtonElement | null>;
    onToggle: () => void;
  };
}

export function InputUtilityButtons({ t, onAttach, attachDisabled, onBeforeOpenSkills, mobileCommands }: InputUtilityButtonsProps) {
  const skillsOpen = useStore(state => state.activePanel === 'skills');
  const setActivePanel = useStore(state => state.setActivePanel);
  const skillsLabel = t(mobileCommands ? 'input.commandMenu' : 'skills.panel.title');

  return (
    <>
      <button type="button" className={styles['attach-btn']} title={t('input.attachFiles')} aria-label={t('input.attachFiles')} disabled={attachDisabled} onClick={onAttach}>
        <Paperclip size={16} weight="bold" aria-hidden="true" />
      </button>
      <button
        type="button"
        ref={mobileCommands?.buttonRef}
        className={styles['attach-btn']}
        title={skillsLabel}
        aria-label={skillsLabel}
        aria-expanded={mobileCommands?.open ?? skillsOpen}
        onClick={() => {
          if (mobileCommands) {
            mobileCommands.onToggle();
            return;
          }
          onBeforeOpenSkills?.();
          setActivePanel('skills');
        }}
      >
        <Sparkle size={16} weight="regular" aria-hidden="true" />
      </button>
    </>
  );
}
