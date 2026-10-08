const STORAGE_KEY = 'gsap-pwa-session';

export type PwaLoginMode = 'accessKey' | 'password';

export interface PwaSession {
  token?: string;
  account: string;
  expiresAt: number | string | null;
}

export interface PwaLoginInput {
  mode: PwaLoginMode;
  accessKey?: string;
  username?: string;
  password?: string;
}

export function readPwaSession(): PwaSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<PwaSession>;
    if (!data.token || !data.account) return null;
    if (typeof data.expiresAt === 'number' && data.expiresAt <= Date.now()) {
      clearPwaSession();
      return null;
    }
    return { token: data.token, account: data.account, expiresAt: data.expiresAt ?? null };
  } catch {
    return null;
  }
}

export function savePwaSession(session: PwaSession): void {
  if (!session.token) {
    clearPwaSession();
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  localStorage.setItem('gsap-token', session.token);
}

export function clearPwaSession(): void {
  localStorage.removeItem(STORAGE_KEY);
  const currentToken = localStorage.getItem('gsap-token') || '';
  if (currentToken.startsWith('pwa.')) localStorage.removeItem('gsap-token');
}

export async function legacyValidatePwaSession(session: PwaSession | null): Promise<boolean> {
  if (!session?.token) return false;
  try {
    const response = await fetch('/api/pwa-auth/status', {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data.authenticated === true;
  } catch {
    return false;
  }
}

export async function validatePwaSession(session: PwaSession | null = null): Promise<boolean> {
  try {
    const response = await fetch('/api/web-auth/session', {
      credentials: 'same-origin',
    });
    if (response.ok) {
      const data = await response.json();
      if (data.authenticated === true) return true;
    }
  } catch {
    // Fall through to legacy token validation.
  }
  return legacyValidatePwaSession(session);
}

export async function loginPwa(input: PwaLoginInput): Promise<PwaSession> {
  if (input.mode === 'accessKey') {
    return loginWebAuth({ credential: input.accessKey?.trim() || '' });
  }

  const username = input.username?.trim() || '';
  const password = input.password || '';
  try {
    return await loginWebAuth({ username, password });
  } catch (err) {
    try {
      return await loginLegacyPwa(username, password);
    } catch {
      throw err;
    }
  }
}

async function loginWebAuth(body: { credential?: string; username?: string; password?: string }): Promise<PwaSession> {
  const response = await fetch('/api/web-auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    throw new Error(data.error || 'invalid_credentials');
  }
  return {
    account: data.principal?.userId || data.principal?.deviceId || 'web-session',
    expiresAt: data.expiresAt ?? null,
  };
}

async function loginLegacyPwa(account: string, password: string): Promise<PwaSession> {
  const response = await fetch('/api/pwa-auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true || !data.token) {
    throw new Error(data.error || 'invalid_credentials');
  }
  return {
    token: data.token,
    account: data.account || account,
    expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : null,
  };
}
