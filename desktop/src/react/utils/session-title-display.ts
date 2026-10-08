import type { Session } from '../types';

const GENERATED_SESSION_STEM_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z(?:_[0-9a-f-]{8,64})?$/i;

function stripPathAndExtension(value: string): string {
  const base = value.split(/[\\/]/).filter(Boolean).pop() || value;
  return base.replace(/\.(jsonl|json)$/i, '').trim();
}

export function isGeneratedSessionTitle(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return GENERATED_SESSION_STEM_RE.test(stripPathAndExtension(trimmed));
}

function cleanTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getSessionDisplayTitle(session: Pick<Session, 'title' | 'firstMessage'> | null | undefined, fallback: string): string {
  const title = cleanTitle(session?.title);
  if (title && !isGeneratedSessionTitle(title)) return title;

  const firstMessage = cleanTitle(session?.firstMessage);
  if (firstMessage && !isGeneratedSessionTitle(firstMessage)) return firstMessage;

  return fallback;
}
