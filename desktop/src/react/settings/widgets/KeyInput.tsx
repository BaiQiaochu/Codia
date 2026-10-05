/**
 * API Key 输入框 — password/text 切换
 */
import React, { useState } from 'react';
import styles from '../Settings.module.css';

interface KeyInputProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  onBlur?: () => void;
  onReveal?: () => Promise<string | null | undefined>;
  onRevealValue?: (val: string) => void;
  onRevealError?: (err: unknown) => void;
}

export function KeyInput({ value, onChange, placeholder, onBlur, onReveal, onRevealValue, onRevealError }: KeyInputProps) {
  const t = window.t || ((k: string) => k);
  const [visible, setVisible] = useState(false);
  const [revealing, setRevealing] = useState(false);

  const toggleVisible = async () => {
    if (visible) {
      setVisible(false);
      return;
    }

    if (!onReveal) {
      setVisible(true);
      return;
    }

    setRevealing(true);
    try {
      const revealed = await onReveal();
      if (typeof revealed === 'string') {
        if (onRevealValue) onRevealValue(revealed);
        else onChange(revealed);
      }
      setVisible(true);
    } catch (err) {
      onRevealError?.(err);
    } finally {
      setRevealing(false);
    }
  };

  return (
    <div className={styles['settings-key-wrapper']}>
      <input
        className={`${styles['settings-input']} ${styles['settings-key-input']}`}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onBlur={onBlur}
      />
      <button
        className={styles['settings-key-toggle']}
        type="button"
        disabled={revealing}
        onClick={() => { void toggleVisible(); }}
      >
        {visible ? t('settings.api.hideKey') : t('settings.api.showKey')}
      </button>
    </div>
  );
}
