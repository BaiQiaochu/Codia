import {
  forwardRef,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from './classnames';

export type CodiaButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type CodiaButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'size'> {
  variant?: CodiaButtonVariant;
  size?: CodiaButtonSize;
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    iconLeft,
    iconRight,
    disabled,
    className,
    children,
    type = 'button',
    ...buttonProps
  },
  ref,
) {
  return (
    <button
      {...buttonProps}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'codia-plugin-button',
        `codia-plugin-button-${variant}`,
        `codia-plugin-button-${size}`,
        loading && 'codia-plugin-button-loading',
        className,
      )}
    >
      {loading ? <span className="codia-plugin-spinner" aria-hidden /> : iconLeft}
      {children && <span className="codia-plugin-button-label">{children}</span>}
      {!loading && iconRight}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
  size?: CodiaButtonSize;
  variant?: Extract<CodiaButtonVariant, 'secondary' | 'ghost' | 'danger'>;
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', variant = 'ghost', className, children, type = 'button', ...buttonProps },
  ref,
) {
  return (
    <button
      {...buttonProps}
      ref={ref}
      type={type}
      aria-label={label}
      title={buttonProps.title || label}
      className={cx(
        'codia-plugin-icon-button',
        `codia-plugin-icon-button-${size}`,
        `codia-plugin-icon-button-${variant}`,
        className,
      )}
    >
      {children}
    </button>
  );
});

interface FieldBaseProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export interface TextInputProps extends FieldBaseProps, InputHTMLAttributes<HTMLInputElement> {
  inputClassName?: string;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { label, hint, error, id, className, inputClassName, ...inputProps },
  ref,
) {
  const generatedId = useId();
  const inputId = id || generatedId;

  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={inputId} className={className}>
      <input
        {...inputProps}
        ref={ref}
        id={inputId}
        aria-invalid={Boolean(error)}
        className={cx('codia-plugin-input', inputClassName)}
      />
    </FieldShell>
  );
});

export interface TextareaProps extends FieldBaseProps, TextareaHTMLAttributes<HTMLTextAreaElement> {
  textareaClassName?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, id, className, textareaClassName, rows = 4, ...textareaProps },
  ref,
) {
  const generatedId = useId();
  const textareaId = id || generatedId;

  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={textareaId} className={className}>
      <textarea
        {...textareaProps}
        ref={ref}
        id={textareaId}
        rows={rows}
        aria-invalid={Boolean(error)}
        className={cx('codia-plugin-textarea', textareaClassName)}
      />
    </FieldShell>
  );
});

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label?: ReactNode;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, label, disabled, className, onClick, type = 'button', ...buttonProps },
  ref,
) {
  const ariaLabel = typeof label === 'string' ? label : buttonProps['aria-label'];

  return (
    <span className={cx('codia-plugin-switch-wrap', className)}>
      <button
        {...buttonProps}
        ref={ref}
        type={type}
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cx('codia-plugin-switch', checked && 'codia-plugin-switch-on')}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented && !disabled) onChange?.(!checked);
        }}
      >
        <span className="codia-plugin-switch-thumb" aria-hidden />
      </button>
      {label && <span className="codia-plugin-switch-label">{label}</span>}
    </span>
  );
});

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends FieldBaseProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  label?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function Select({
  options,
  value,
  onChange,
  label,
  hint,
  error,
  placeholder = 'Select',
  disabled = false,
  className,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.value === value);
  const displayText = current?.label || placeholder;
  const labelText = typeof label === 'string' ? label : undefined;
  const buttonLabel = [labelText, displayText].filter(Boolean).join(' ');

  return (
    <FieldShell label={label} hint={hint} error={error} className={className}>
      <div className="codia-plugin-select">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={buttonLabel || undefined}
          disabled={disabled}
          className={cx('codia-plugin-select-trigger', !current && 'codia-plugin-select-placeholder')}
          onClick={() => setOpen((next) => !next)}
        >
          <span className="codia-plugin-select-value">{displayText}</span>
          <span className="codia-plugin-select-arrow" aria-hidden>▾</span>
        </button>
        {open && (
          <div className="codia-plugin-select-popover" role="listbox" aria-label={labelText}>
            {options.map((option) => (
              <button
                type="button"
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                className={cx(
                  'codia-plugin-select-option',
                  option.value === value && 'codia-plugin-select-option-selected',
                )}
                onClick={() => {
                  if (option.disabled) return;
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </FieldShell>
  );
}

interface FieldShellProps extends FieldBaseProps {
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

function FieldShell({ label, hint, error, htmlFor, className, children }: FieldShellProps) {
  return (
    <div className={cx('codia-plugin-field', className)}>
      {label && (
        <label className="codia-plugin-field-label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {hint && <div className="codia-plugin-field-hint">{hint}</div>}
      {children}
      {error && <div className="codia-plugin-field-error">{error}</div>}
    </div>
  );
}
