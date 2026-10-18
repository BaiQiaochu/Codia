/** A receipt, not a saved task: never persist raw inputs, prompts or credentials. */
export const TEMPLATE_LAUNCH_PENDING_KEY = 'codia.task-console.pending-launch.v1';
export type PendingTemplateLaunch = {
  version: 1; requestId: string; fingerprint: string; createdAt: number; state: 'pending' | 'unknown';
};
const storageError = () => new Error('无法读取或保存启动防重记录，已阻止派发。请先检查已有运行。');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export function readPendingTemplateLaunch(): PendingTemplateLaunch | null {
  try {
    const raw = window.localStorage.getItem(TEMPLATE_LAUNCH_PENDING_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (record.version !== 1 || !/^[A-Za-z0-9_-]{8,100}$/.test(record.requestId) || !/^[a-f0-9]{64}$/.test(record.fingerprint)
      || !Number.isFinite(record.createdAt) || !['pending', 'unknown'].includes(record.state)) throw storageError();
    return { version: 1, requestId: record.requestId, fingerprint: record.fingerprint, createdAt: record.createdAt, state: record.state };
  } catch { throw storageError(); }
}
function save(record: PendingTemplateLaunch) {
  try {
    window.localStorage.setItem(TEMPLATE_LAUNCH_PENDING_KEY, JSON.stringify(record));
    const persisted = readPendingTemplateLaunch();
    if (!persisted || persisted.requestId !== record.requestId || persisted.fingerprint !== record.fingerprint || persisted.state !== record.state) throw storageError();
  } catch { throw storageError(); }
}
export async function preparePendingTemplateLaunch(body: unknown): Promise<PendingTemplateLaunch> {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境无法生成安全的启动指纹，已阻止派发。');
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(body)));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const fingerprint = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  const existing = readPendingTemplateLaunch();
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new Error('输入已改变，但旧启动请求仍未确认。请恢复原输入重试，或先核查已有运行；不会自动创建新请求。');
    if (existing.state === 'unknown') throw new Error('服务端无法确认旧启动结果。请先核查已有运行；已阻止再次派发。');
    return existing;
  }
  const pending: PendingTemplateLaunch = { version: 1, requestId: crypto.randomUUID(), fingerprint, createdAt: Date.now(), state: 'pending' };
  save(pending);
  return pending;
}
export function markPendingTemplateLaunchUnknown(requestId: string) {
  const pending = readPendingTemplateLaunch();
  if (pending?.requestId === requestId) save({ ...pending, state: 'unknown' });
}
/** Call only on a verified successful run receipt or explicit user review. */
export function clearPendingTemplateLaunch(requestId?: string) {
  try {
    const pending = readPendingTemplateLaunch();
    if (requestId && pending?.requestId !== requestId) return;
    window.localStorage.removeItem(TEMPLATE_LAUNCH_PENDING_KEY);
    if (window.localStorage.getItem(TEMPLATE_LAUNCH_PENDING_KEY) !== null) throw storageError();
  } catch { throw storageError(); }
}
