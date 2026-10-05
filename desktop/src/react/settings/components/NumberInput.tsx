import React from 'react';
import styles from './settings-components.module.css';

interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  precision?: 'int' | 'float';
  disabled?: boolean;
}

export function NumberInput({
  value,
  onChange,
  unit,
  min,
  max,
  step,
  precision = 'int',
  disabled,
}: NumberInputProps) {
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    const next = precision === 'float' ? parseFloat(raw) : parseInt(raw, 10);
    if (!Number.isFinite(next)) return;
    onChange(next);
  };

  return (
    <div className={styles.numberInput}>
      <input
        type="number"
        className={styles.numberInputField}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={handleChange}
      />
      {unit && <span className={styles.numberInputUnit}>{unit}</span>}
    </div>
  );
}
