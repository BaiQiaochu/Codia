import { useEffect, useState } from 'react';
import {
  clearPwaSession,
  loginPwa,
  readPwaSession,
  savePwaSession,
  validatePwaSession,
  type PwaLoginMode,
  type PwaSession,
} from '../pwa-auth';

declare function t(key: string, vars?: Record<string, string | number>): string;

const FALLBACK_TEXT: Record<string, string> = {
  'pwaLogin.checking': 'Checking sign-in...',
  'pwaLogin.title': 'Sign in to Codia',
  'pwaLogin.desc': 'Use a paired access key or your local account password.',
  'pwaLogin.accessKey': 'Access key',
  'pwaLogin.account': 'Account',
  'pwaLogin.password': 'Password',
  'pwaLogin.signIn': 'Sign in',
  'pwaLogin.signingIn': 'Signing in...',
  'pwaLogin.invalid': 'The credential is invalid.',
};

function tr(key: string): string {
  const value = typeof t === 'function' ? t(key) : key;
  return value && value !== key ? value : FALLBACK_TEXT[key] || key;
}

interface PwaLoginGateProps {
  children: React.ReactNode;
}

export function PwaLoginGate({ children }: PwaLoginGateProps) {
  const [isWeb, setIsWeb] = useState(false);
  const [checking, setChecking] = useState(true);
  const [session, setSession] = useState<PwaSession | null>(null);
  const [mode, setMode] = useState<PwaLoginMode>('accessKey');
  const [accessKey, setAccessKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const validateExistingSession = async () => {
      const existing = readPwaSession();
      if (await validatePwaSession(existing)) {
        if (existing) savePwaSession(existing);
        setSession(existing || { account: 'web-session', expiresAt: null });
      } else {
        clearPwaSession();
      }
    };

    Promise.resolve(typeof window.platform?.getPlatform === 'function' ? window.platform.getPlatform() : 'web')
      .then(async (platform) => {
        if (!alive) return;
        const web = platform === 'web';
        setIsWeb(web);
        if (!web) {
          setChecking(false);
          return;
        }
        await validateExistingSession();
        if (alive) setChecking(false);
      })
      .catch(async () => {
        if (!alive) return;
        setIsWeb(true);
        await validateExistingSession();
        if (alive) setChecking(false);
      });
    return () => { alive = false; };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const next = await loginPwa({ mode, accessKey: accessKey.trim(), username: username.trim(), password });
      savePwaSession(next);
      setSession(next);
      window.location.reload();
    } catch {
      setError(tr('pwaLogin.invalid'));
    } finally {
      setSubmitting(false);
    }
  };

  if (checking) {
    return <div className="pwa-login-screen"><div className="pwa-login-card">{tr('pwaLogin.checking')}</div></div>;
  }

  if (!isWeb || session) return <>{children}</>;

  const missingCredential = mode === 'accessKey'
    ? !accessKey.trim()
    : !username.trim() || !password;

  return (
    <div className="pwa-login-screen">
      <form className="pwa-login-card" onSubmit={submit}>
        <div className="pwa-login-brand">Codia</div>
        <h1>{tr('pwaLogin.title')}</h1>
        <p>{tr('pwaLogin.desc')}</p>
        <div className="pwa-login-mode" role="tablist" aria-label="PWA sign-in mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'accessKey'}
            className={mode === 'accessKey' ? 'active' : ''}
            onClick={() => setMode('accessKey')}
          >
            {tr('pwaLogin.accessKey')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'password'}
            className={mode === 'password' ? 'active' : ''}
            onClick={() => setMode('password')}
          >
            {tr('pwaLogin.password')}
          </button>
        </div>
        {mode === 'accessKey' ? (
          <label>
            <span>{tr('pwaLogin.accessKey')}</span>
            <input
              value={accessKey}
              onChange={(event) => setAccessKey(event.target.value)}
              autoComplete="one-time-code"
              inputMode="text"
              autoFocus
            />
          </label>
        ) : (
          <>
            <label>
              <span>{tr('pwaLogin.account')}</span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                inputMode="text"
                autoFocus
              />
            </label>
            <label>
              <span>{tr('pwaLogin.password')}</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </label>
          </>
        )}
        {error && <div className="pwa-login-error" role="alert">{error}</div>}
        <button type="submit" disabled={submitting || missingCredential}>
          {submitting ? tr('pwaLogin.signingIn') : tr('pwaLogin.signIn')}
        </button>
      </form>
    </div>
  );
}
