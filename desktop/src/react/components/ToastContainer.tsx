import { useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';
import type { Toast } from '../stores/toast-slice';
import type { RuntimeDiagnostic } from '../stores/runtime-timeline-slice';

export function ToastContainer() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const diagnostic = useStore((s) => toast.diagnosticId ? s.runtimeDiagnosticsById[toast.diagnosticId] : undefined);
  const buildExport = useStore((s) => s.buildRuntimeDiagnosticExport);

  useEffect(() => {
    requestAnimationFrame(() => ref.current?.classList.add('show'));
  }, []);

  function dismiss() {
    const el = ref.current;
    if (!el) return;
    el.classList.remove('show');
    setTimeout(() => useStore.getState().removeToast(toast.id), 300);
  }

  async function copyDiagnosticPackage() {
    if (!toast.diagnosticId) return;
    const payload = buildExport(toast.diagnosticId, {
      surface: 'desktop',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    });
    if (!payload) return;
    await navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
  }

  return (
    <div ref={ref} className={`codia-toast ${toast.type}`}>
      <div className="codia-toast-body">
        <span>{toast.text}</span>
        {expanded && diagnostic && (
          <RuntimeDiagnosticDetails diagnostic={diagnostic} onCopy={copyDiagnosticPackage} />
        )}
      </div>
      <div className="codia-toast-actions">
        {diagnostic && (
          <button type="button" className="codia-toast-action" onClick={() => setExpanded((value) => !value)}>
            {expanded ? tr('diagnostics.runtime.toast.hideDetails', 'Hide details') : tr('diagnostics.runtime.toast.details', 'Details')}
          </button>
        )}
        {toast.action && (
          <button type="button" className="codia-toast-action" onClick={() => { toast.action!.onClick(); dismiss(); }}>
            {toast.action.label}
          </button>
        )}
        <button type="button" className="codia-toast-close" onClick={dismiss}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function tr(key: string, fallback: string): string {
  const translator = (window as typeof window & { t?: (key: string) => string }).t;
  const value = translator?.(key);
  return value && value !== key ? value : fallback;
}

function formatModel(model?: RuntimeDiagnostic['model']): string {
  if (!model) return '';
  return [model.provider, model.id || model.name].filter(Boolean).join('/');
}

function RuntimeDiagnosticDetails({
  diagnostic,
  onCopy,
}: {
  diagnostic: RuntimeDiagnostic;
  onCopy: () => Promise<void>;
}) {
  const rows = [
    [tr('diagnostics.runtime.traceId', 'Trace'), diagnostic.traceId],
    [tr('diagnostics.runtime.session', 'Session'), diagnostic.sessionPath],
    [tr('diagnostics.runtime.model', 'Model'), formatModel(diagnostic.model)],
    [tr('diagnostics.runtime.tool', 'Tool'), diagnostic.tool?.name],
    [tr('diagnostics.runtime.category', 'Category'), diagnostic.category],
    [tr('diagnostics.runtime.duration', 'Duration'), typeof diagnostic.durationMs === 'number' ? `${diagnostic.durationMs}ms` : ''],
    [tr('diagnostics.runtime.suggestion', 'Suggestion'), diagnostic.suggestion],
    [tr('diagnostics.runtime.technical', 'Technical'), diagnostic.technicalMessage],
  ].filter(([, value]) => value);

  return (
    <div className="codia-toast-diagnostic">
      {rows.map(([label, value]) => (
        <div className="codia-toast-diagnostic-row" key={String(label)}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
      <button type="button" className="codia-toast-action" onClick={() => { void onCopy(); }}>
        {tr('diagnostics.runtime.copyPackage', 'Copy diagnostics')}
      </button>
    </div>
  );
}
