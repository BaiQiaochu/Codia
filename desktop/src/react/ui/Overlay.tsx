import { useCallback, useEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { useAnimatePresence, type AnimateStage } from '../hooks/use-animate-presence';
import styles from './Overlay.module.css';

type BackdropVariant = 'dim' | 'blur' | 'none';

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  backdrop?: BackdropVariant;
  closeOnEsc?: boolean;
  closeOnBackdrop?: boolean;
  trapFocus?: boolean;
  zIndex?: number;
  className?: string;
  backdropClassName?: string;
  duration?: number;
  disableContainerAnimation?: boolean;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function stageClass(stage: AnimateStage, enter: string, exit: string) {
  if (stage === 'enter') return enter;
  if (stage === 'exit') return exit;
  return '';
}

export function Overlay({
  open,
  onClose,
  children,
  backdrop = 'dim',
  closeOnEsc = true,
  closeOnBackdrop = true,
  trapFocus = true,
  zIndex = 1000,
  className,
  backdropClassName,
  duration = 250,
  disableContainerAnimation = false,
}: OverlayProps) {
  const { mounted, stage } = useAnimatePresence(open, { duration });
  const backdropRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!mounted || !closeOnEsc) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeOnEsc, mounted, onClose]);

  useEffect(() => {
    if (mounted) {
      returnFocusRef.current = document.activeElement;
    } else if (returnFocusRef.current instanceof HTMLElement) {
      returnFocusRef.current.focus();
      returnFocusRef.current = null;
    }
  }, [mounted]);

  useEffect(() => {
    if (stage !== 'idle' || !trapFocus) return;
    const first = backdropRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, [stage, trapFocus]);

  useEffect(() => {
    if (!mounted || !trapFocus) return;
    const el = backdropRef.current;
    if (!el) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const nodes = el.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mounted, trapFocus]);

  const handleBackdropClick = useCallback((event: MouseEvent) => {
    if (closeOnBackdrop && event.target === event.currentTarget) onClose();
  }, [closeOnBackdrop, onClose]);

  if (!mounted) return null;

  const backdropCls = [
    styles.backdrop,
    backdrop === 'dim' && styles['backdrop-dim'],
    backdrop === 'blur' && styles['backdrop-blur'],
    stageClass(stage, styles.enter, styles.exit),
    backdropClassName,
  ].filter(Boolean).join(' ');

  const containerCls = [
    styles.container,
    !disableContainerAnimation && stageClass(stage, styles['container-enter'], styles['container-exit']),
    className || styles.card,
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={backdropRef}
      className={backdropCls}
      style={{ zIndex }}
      onMouseDown={handleBackdropClick}
    >
      <div className={containerCls}>{children}</div>
    </div>
  );
}
