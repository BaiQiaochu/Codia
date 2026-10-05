import { useCallback, useEffect, useRef, useState } from 'react';

export type AnimateStage = 'enter' | 'idle' | 'exit';

interface Options {
  duration?: number;
}

const DEFAULT_DURATION = 250;

export function useAnimatePresence(visible: boolean, options?: Options) {
  const duration = options?.duration ?? DEFAULT_DURATION;
  const [mounted, setMounted] = useState(visible);
  const [stage, setStage] = useState<AnimateStage>(visible ? 'idle' : 'exit');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (visible) {
      setMounted(true);
      setStage('enter');
      timerRef.current = setTimeout(() => setStage('idle'), duration);
    } else if (mounted) {
      setStage('exit');
      timerRef.current = setTimeout(() => setMounted(false), duration);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [duration, mounted, visible]);

  const onAnimationEnd = useCallback(() => {
    if (!visible) setMounted(false);
    else setStage('idle');
  }, [visible]);

  return { mounted, stage, onAnimationEnd } as const;
}
