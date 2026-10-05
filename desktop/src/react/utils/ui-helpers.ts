/**
 * Connection status, error reporting, and model loading helpers.
 */

import { useStore } from '../stores';
import { gsapFetch } from '../hooks/use-gsap-fetch';
import type { Model } from '../types';
import { errorBus } from '../../../../shared/error-bus.ts';
import { AppError } from '../../../../shared/errors.ts';

// Connection status.

export function setStatus(key: string, connected: boolean, vars: Record<string, string | number> = {}): void {
  useStore.setState({ connected, statusKey: key, statusVars: vars });
}

// Error reporting.

export function showError(message: string): void {
  errorBus.report(new AppError('UNKNOWN', { message }));
}

// Model loading.

function healStaleSessionState(): void {
  const { currentSessionPath, pendingNewSession, welcomeVisible } = useStore.getState();
  if (!currentSessionPath || !pendingNewSession) return;

  useStore.setState({
    pendingNewSession: false,
    welcomeVisible: welcomeVisible ? false : welcomeVisible,
  });
}

export async function loadModels(options: { sessionPath?: string | null } = {}): Promise<void> {
  try {
    healStaleSessionState();
    const requestSessionPath = options.sessionPath ?? useStore.getState().currentSessionPath ?? null;
    const res = await gsapFetch('/api/models');
    const data = await res.json() as { activeModel?: Pick<Model, 'id' | 'provider'> | null; models?: Model[] };
    const state = useStore.getState();
    if (requestSessionPath && state.currentSessionPath !== requestSessionPath) return;

    const { pendingNewSession } = state;
    const sessionModel = requestSessionPath ? state.sessionModelsByPath?.[requestSessionPath] : null;
    const activeModel = data.activeModel;
    let models: Model[] = data.models || [];

    // When not pending, prefer the model bound to the active session.
    // While pending, preserve the API current marker from the agent chat model.
    const hasCurrentModel = models.some((m) => m.isCurrent);
    const currentRef = sessionModel?.id && sessionModel?.provider
      ? sessionModel
      : activeModel;
    if (currentRef && (!pendingNewSession || !hasCurrentModel)) {
      models = models.map((m) => ({
        ...m,
        isCurrent: m.id === currentRef.id && m.provider === currentRef.provider,
      }));
    }

    const currentModelObj = models.find((m) => m.isCurrent);
    useStore.setState({
      models,
      currentModel: currentModelObj
        ? { id: currentModelObj.id, provider: currentModelObj.provider }
        : (currentRef ? { id: currentRef.id, provider: currentRef.provider } : null),
    });
  } catch { /* silent */ }
}
