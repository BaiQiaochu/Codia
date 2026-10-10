import { isQuickActionId, type QuickActionId } from '../../../../shared/quick-actions';
export const INPUT_DRAFT_REQUEST_EVENT = 'codia-input-draft-request';

export type InputDraftRequestMode = 'replace' | 'append';

export interface InputDraftRequestDetail {
  text: string;
  mode: InputDraftRequestMode;
  focus: boolean;
  source?: string;
  quickAction?: QuickActionId;
}

type RawInputDraftRequest = Partial<InputDraftRequestDetail> | string | null | undefined;

function normalizeInputDraftRequest(input: RawInputDraftRequest): InputDraftRequestDetail | null {
  const raw = typeof input === 'string' ? { text: input } : input;
  if (!raw || (typeof raw.text !== 'string' && !isQuickActionId(raw.quickAction))) return null;

  const text = (raw.text || '').trim();
  if (!text && !isQuickActionId(raw.quickAction)) return null;

  const mode: InputDraftRequestMode = raw.mode === 'append' ? 'append' : 'replace';
  const source = typeof raw.source === 'string' && raw.source.trim()
    ? raw.source.trim()
    : undefined;

  return {
    text,
    ...(isQuickActionId(raw.quickAction) ? { quickAction: raw.quickAction } : {}),
    mode,
    focus: raw.focus !== false,
    ...(source ? { source } : {}),
  };
}

export function readInputDraftRequestDetail(event: Event): InputDraftRequestDetail | null {
  if (event.type !== INPUT_DRAFT_REQUEST_EVENT) return null;
  return normalizeInputDraftRequest((event as CustomEvent<RawInputDraftRequest>).detail);
}

export function requestInputDraft(input: RawInputDraftRequest): boolean {
  const detail = normalizeInputDraftRequest(input);
  if (!detail || typeof window === 'undefined') return false;
  window.dispatchEvent(new CustomEvent(INPUT_DRAFT_REQUEST_EVENT, { detail }));
  return true;
}
