/**
  *
 *
 * Call initErrorBusBridge() once during app init to wire up the renderer-side
 * ErrorBus subscriber to the toast slice.
 */

import { errorBus } from '../../../../shared/error-bus.ts';
import { useStore } from '../stores';
import type { ErrorRoute } from './types';

declare function t(key: string, vars?: Record<string, string | number>): string;

export function initErrorBusBridge(): void {
  errorBus.subscribe((entry: { error: { code: string; severity: string; userMessageKey: string; message?: string; traceId?: string }; context?: Record<string, unknown> }, route: string) => {
    const { error } = entry;
    const userMessage = error.message || t(error.userMessageKey) || error.code;

    switch (route as ErrorRoute | 'silent') {
      case 'toast': {
        const shortMessage = error.severity === 'critical'
          ? 'Runtime failure. Diagnostics were saved.'
          : userMessage;
        const diagnosticId = useStore.getState().recordRuntimeDiagnostic({
          traceId: error.traceId,
          severity: error.severity === 'cosmetic' ? 'warn' : 'error',
          category: 'runtime',
          userMessage: shortMessage,
          technicalMessage: userMessage,
          suggestion: 'Open Diagnostics > Runtime Records and copy the diagnostic package if the issue repeats.',
          sanitizedDetails: {
            code: error.code,
            context: entry.context,
          },
        });
        useStore.getState().recordRuntimeRecord({
          severity: error.severity === 'cosmetic' ? 'warn' : 'error',
          category: 'runtime',
          title: shortMessage,
          detail: error.code,
          traceId: error.traceId,
          diagnosticId,
        });
        useStore.getState().addToast(
          shortMessage,
          error.severity === 'cosmetic' ? 'warning' : 'error',
          error.severity === 'critical' ? 0 : 5000,
          {
            errorCode: error.code,
            diagnosticId,
            persistent: error.severity === 'critical',
            dedupeKey: error.code,
          }
        );
        break;
      }
      case 'statusbar':
        // WebSocket manages its own wsState in connection-slice
        break;
      case 'boundary':
        // ErrorBoundary catches render errors directly
        break;
      case 'silent':
        // Log only (already logged by ErrorBus._log)
        break;
    }
  });
}
