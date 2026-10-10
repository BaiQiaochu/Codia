import type { RefObject } from 'react';
import { StarFour } from '@phosphor-icons/react';
import styles from './InputArea.module.css';

interface InputUtilityButtonsProps {
  t: (key: string) => string;
  addMenu: {
    open: boolean;
    buttonRef: RefObject<HTMLButtonElement | null>;
    onToggle: () => void;
  };
}

export function InputUtilityButtons({ t, addMenu }: InputUtilityButtonsProps) {
  return (
    <button
      type="button"
      ref={addMenu.buttonRef}
      className={`${styles['attach-btn']} ${styles['composer-add-trigger']}${addMenu.open ? ` ${styles.active}` : ''}`}
      title={t('input.addMenu')}
      aria-label={t('input.addMenu')}
      aria-haspopup="menu"
      aria-expanded={addMenu.open}
      onClick={addMenu.onToggle}
    >
      <StarFour size={17} weight="regular" aria-hidden="true" />
    </button>
  );
}
