import React from 'react';
import styles from '../Settings.module.css';

type SettingsButtonVariant = 'primary' | 'secondary';

type SettingsButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: SettingsButtonVariant;
};

export function SettingsButton({
  className,
  type = 'button',
  variant = 'secondary',
  ...props
}: SettingsButtonProps) {
  const variantClass = variant === 'primary'
    ? styles['settings-btn-primary']
    : styles['settings-btn-secondary'];
  const buttonClassName = [variantClass, className].filter(Boolean).join(' ');

  return <button type={type} className={buttonClassName} {...props} />;
}
