import React from 'react';

interface ToggleProps {
  on: boolean | undefined;
  onChange: (on: boolean) => void;
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
  title?: string;
}

export function Toggle({ on, onChange, label, ariaLabel, disabled = false, title }: ToggleProps) {
  const loading = on === undefined;
  const visualOn = on === true;
  const effectiveDisabled = disabled || loading;
  const className = [
    'codia-toggle',
    visualOn ? 'on' : '',
    loading ? 'loading' : '',
  ].filter(Boolean).join(' ');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        className={className}
        type="button"
        disabled={effectiveDisabled}
        title={title}
        aria-label={ariaLabel || label}
        aria-busy={loading || undefined}
        role="switch"
        aria-checked={loading ? 'mixed' : visualOn}
        onClick={(e) => {
          e.stopPropagation();
          if (loading) return;
          onChange(!visualOn);
        }}
      />
      {label && <span className="codia-toggle-label">{label}</span>}
    </div>
  );
}
