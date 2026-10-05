import { AppError } from './errors.ts';

type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown) => boolean;
};

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/**
 * Retry with decorrelated jitter (AWS recommended).
 * delay = min(maxDelay, random(baseDelay, previousDelay * 3))
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T | undefined> {
  const { maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 30000, signal, shouldRetry } = opts;
  let prevDelay = baseDelayMs;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const appErr = AppError.wrap(err);
      const retry = shouldRetry ? shouldRetry(appErr) : appErr.retryable;
      if (!retry || attempt === maxAttempts - 1) throw appErr;

      if (signal?.aborted) throw appErr;

      const delay = Math.min(maxDelayMs, randomBetween(baseDelayMs, prevDelay * 3));
      prevDelay = delay;
      await sleep(delay, signal);
    }
  }
}
