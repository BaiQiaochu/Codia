import { useEffect, useState } from 'react';
import type { AutoUpdateState } from '../types';
import { getDesktopApi } from '../utils/desktop-api';

export function useAutoUpdateState(): AutoUpdateState | null {
  const [state, setState] = useState<AutoUpdateState | null>(null);

  useEffect(() => {
    let alive = true;
    const desktopApi = getDesktopApi();

    desktopApi?.autoUpdateState?.()
      .then((nextState) => {
        if (alive && nextState) {
          setState(nextState);
        }
      })
      .catch(() => {});

    const unsubscribe = desktopApi?.onAutoUpdateState?.((nextState) => {
      setState(nextState);
    });

    return () => {
      alive = false;
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, []);

  return state;
}
