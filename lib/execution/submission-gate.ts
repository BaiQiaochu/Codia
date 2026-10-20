const pending = new Map<string, Set<AbortController>>();
export const SUBMISSION_WAIT_MS = 15 * 60_000;
export function cancelSessionSubmissions(sessionPath: string) {
  for (const controller of pending.get(sessionPath) || []) controller.abort(new Error('submission_cancelled'));
}
export function createSubmissionGate(sessionPath: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const deadline = Date.now() + SUBMISSION_WAIT_MS;
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const entries = pending.get(sessionPath) || new Set<AbortController>();
  entries.add(controller); pending.set(sessionPath, entries);
  let started = false;
  const timer = setTimeout(() => {
    if (!started) controller.abort(new Error('submission_expired'));
  }, SUBMISSION_WAIT_MS);
  timer.unref?.();
  const check = () => {
    combined.throwIfAborted();
    if (!started && Date.now() >= deadline) throw new Error('submission_expired');
  };
  return {
    deadline, signal: combined, check,
    start() { check(); started = true; clearTimeout(timer); },
    async wait<T>(operation: Promise<T>): Promise<T> {
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(combined.reason);
        combined.addEventListener('abort', onAbort, { once: true });
      });
      try {
        // Attach rejection handlers before checking an already-cancelled gate.
        const result = Promise.race([operation, aborted]);
        if (combined.aborted) onAbort();
        return await result;
      }
      finally {
        combined.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        entries.delete(controller);
        if (!entries.size) pending.delete(sessionPath);
      }
    },
  };
}
