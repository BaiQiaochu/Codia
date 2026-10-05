import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type TouchEvent,
} from 'react';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { RegionalErrorBoundary } from '../components/RegionalErrorBoundary';
import { MainContent } from '../MainContent';
import { SidebarLayout, toggleSidebar } from '../components/SidebarLayout';
import { SessionList } from '../components/SessionList';
import { ArchivedChatsButton } from '../components/ArchivedChatsButton';
import { WelcomeScreen } from '../components/WelcomeScreen';
import { ChatArea } from '../components/chat/ChatArea';
import { InputArea } from '../components/InputArea';
import { RightWorkspacePanel } from '../components/right-workspace/RightWorkspacePanel';
import { WindowControls } from '../components/WindowControls';
import { StatusBar } from '../components/StatusBar';
import { ToastContainer } from '../components/ToastContainer';
import { useStore } from '../stores';
import { closePreview } from '../stores/preview-actions';
import { toggleJianSidebar } from '../stores/desk-actions';
import { createNewSession } from '../stores/session-actions';
import {
  finishMobileEdgeGesture,
  startMobileEdgeGesture,
  updateMobileEdgeGesture,
  type MobileEdge,
  type MobileEdgeGesture,
} from '../utils/mobile-edge-gesture';
import {
  initializeMobileRuntime,
  mobileAuthJson,
  readMobileAuthSession,
  type MobilePrincipal,
} from './mobile-init';

type AuthState = 'checking' | 'login' | 'ready';
type LoginMode = 'device' | 'password';

const MOBILE_REQUIRED_SCOPES = Object.freeze(['chat', 'resources.read', 'files.read', 'files.write']);
const MOBILE_UPDATE_AVAILABLE_EVENT = 'gsap-mobile-update-available';
const MOBILE_APPLY_UPDATE_EVENT = 'gsap-mobile-apply-update';
const LazyPreviewPanel = lazy(() => import('../components/PreviewPanel').then((module) => ({ default: module.PreviewPanel })));
const LazyMediaViewer = lazy(() => import('../components/shared/MediaViewer/MediaViewer').then((module) => ({ default: module.MediaViewer })));

export function MobileApp(): React.ReactElement {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [principal, setPrincipal] = useState<MobilePrincipal | null>(null);
  const [loginMode, setLoginMode] = useState<LoginMode>('device');
  const [loginSecret, setLoginSecret] = useState('');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);

  const bootstrap = useCallback(async () => {
    const session = await readMobileAuthSession();
    if (!session.authenticated || !session.principal) {
      setAuthState('login');
      return;
    }
    if (!principalHasRequiredScopes(session.principal, MOBILE_REQUIRED_SCOPES)) {
      await mobileAuthJson('/api/web-auth/logout', { method: 'POST' }).catch(() => null);
      setPrincipal(null);
      setLoginError('当前登录缺少网页工作台权限，请重新输入访问密钥。');
      setAuthState('login');
      return;
    }
    await initializeMobileRuntime(session.principal);
    setPrincipal(session.principal);
    setAuthState('ready');
  }, []);

  useEffect(() => {
    let cancelled = false;
    bootstrap().catch((err) => {
      console.warn('[mobile] bootstrap failed', err);
      if (!cancelled) setAuthState('login');
    });
    return () => {
      cancelled = true;
    };
  }, [bootstrap]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginError(null);
    try {
      const body = loginMode === 'device'
        ? { credential: loginSecret.trim() }
        : { username: loginUsername.trim(), password: loginPassword };
      await mobileAuthJson('/api/web-auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setLoginSecret('');
      setLoginPassword('');
      await bootstrap();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : '登录失败');
    }
  };

  if (authState === 'checking') {
    return <MobileLoadingScreen subtitle="正在连接 Codia..." />;
  }

  if (authState === 'login') {
    return (
      <MobileLoginScreen
        mode={loginMode}
        secret={loginSecret}
        username={loginUsername}
        password={loginPassword}
        error={loginError}
        onModeChange={(mode) => { setLoginMode(mode); setLoginError(null); }}
        onSecretChange={setLoginSecret}
        onUsernameChange={setLoginUsername}
        onPasswordChange={setLoginPassword}
        onSubmit={login}
      />
    );
  }

  return (
    <ErrorBoundary region="mobile">
      <MobileDesktopShell principal={principal} />
    </ErrorBoundary>
  );
}

function MobileDesktopShell({ principal }: { principal: MobilePrincipal | null }) {
  const sidebarOpen = useStore(s => s.sidebarOpen);
  const jianOpen = useStore(s => s.jianOpen);
  const previewOpen = useStore(s => s.previewOpen);
  const mediaViewer = useStore(s => s.mediaViewer);
  const currentTab = useStore(s => s.currentTab);
  const isNarrow = useNarrowMobileViewport();
  const edgeGestureRef = useRef<MobileEdgeGesture | null>(null);
  const [mobileUpdateAvailable, setMobileUpdateAvailable] = useState(() => window.__gsapMobileUpdateAvailable === true);

  useEffect(() => {
    useStore.setState({ currentTab: 'chat' });
  }, []);

  useEffect(() => {
    const handleUpdateAvailable = () => {
      window.__gsapMobileUpdateAvailable = true;
      setMobileUpdateAvailable(true);
    };
    if (window.__gsapMobileUpdateAvailable === true) setMobileUpdateAvailable(true);
    window.addEventListener(MOBILE_UPDATE_AVAILABLE_EVENT, handleUpdateAvailable);
    return () => {
      window.removeEventListener(MOBILE_UPDATE_AVAILABLE_EVENT, handleUpdateAvailable);
    };
  }, []);

  const applyMobileUpdate = useCallback(() => {
    window.dispatchEvent(new Event(MOBILE_APPLY_UPDATE_EVENT));
  }, []);

  useEffect(() => {
    if (isNarrow) useStore.setState({ sidebarOpen: false, jianOpen: false });
  }, [isNarrow]);

  const openMobileDrawerFromGesture = useCallback((edge: MobileEdge) => {
    if (edge === 'left') {
      useStore.setState({ jianOpen: false });
      toggleSidebar(true);
      return;
    }
    useStore.setState({ sidebarOpen: false });
    toggleJianSidebar(true);
  }, []);

  const handleTouchStart = useCallback((event: TouchEvent<HTMLElement>) => {
    edgeGestureRef.current = null;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    edgeGestureRef.current = startMobileEdgeGesture({
      clientX: touch.clientX,
      clientY: touch.clientY,
      viewportWidth: window.innerWidth || document.documentElement.clientWidth,
      isNarrow,
      drawerOpen: sidebarOpen || jianOpen,
      targetIgnored: shouldIgnoreMobileEdgeGestureTarget(event.target),
    });
  }, [isNarrow, jianOpen, sidebarOpen]);

  const handleTouchMove = useCallback((event: TouchEvent<HTMLElement>) => {
    const gesture = edgeGestureRef.current;
    if (!gesture || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const result = updateMobileEdgeGesture(gesture, touch.clientX, touch.clientY);
    edgeGestureRef.current = result.gesture;
    if (result.shouldPreventDefault) event.preventDefault();
  }, []);

  const handleTouchEnd = useCallback((event: TouchEvent<HTMLElement>) => {
    const gesture = edgeGestureRef.current;
    edgeGestureRef.current = null;
    if (!gesture) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const edge = finishMobileEdgeGesture(gesture, touch.clientX, touch.clientY);
    if (edge) openMobileDrawerFromGesture(edge);
  }, [openMobileDrawerFromGesture]);

  const showDrawerScrim = (sidebarOpen || jianOpen) && isNarrow;

  return (
    <main
      className="mobile-desktop-root"
      data-mobile-principal={principal?.credentialKind || 'session'}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={() => { edgeGestureRef.current = null; }}
    >
      <SidebarLayout />
      <MobileTitlebar
        sidebarOpen={sidebarOpen}
        jianOpen={jianOpen}
        previewOpen={previewOpen}
        onToggleSidebar={() => {
          if (!sidebarOpen) useStore.setState({ jianOpen: false });
          toggleSidebar(!sidebarOpen);
        }}
        onToggleJian={() => {
          if (!jianOpen) useStore.setState({ sidebarOpen: false });
          toggleJianSidebar(!jianOpen);
        }}
        onTogglePreview={toggleMobilePreviewPanel}
      />
      <div className="app mobile-desktop-app">
        <MobileChatSidebar
          open={sidebarOpen && currentTab === 'chat'}
          onNewSession={() => void createNewSession()}
          onCollapse={() => toggleSidebar(false)}
        />
        <MainContent>
          <MobileChatPage />
        </MainContent>
        {previewOpen && (
          <Suspense fallback={null}>
            <LazyPreviewPanel />
          </Suspense>
        )}
        {(!isNarrow || jianOpen) && <MobileWorkspaceRail open={jianOpen} />}
      </div>
      {showDrawerScrim && (
        <button
          className="mobile-drawer-scrim"
          type="button"
          aria-label={tr('sidebar.collapse', '关闭侧边栏')}
          onClick={closeMobileDrawers}
        />
      )}
      {mobileUpdateAvailable && (
        <div className="mobile-update-banner" role="status">
          <span>{tr('mobile.update.available', '有新版本可用')}</span>
          <button type="button" onClick={applyMobileUpdate}>{tr('mobile.update.reload', '刷新')}</button>
        </div>
      )}
      <ConnectionStatus />
      <StatusBar />
      {mediaViewer && (
        <Suspense fallback={null}>
          <LazyMediaViewer />
        </Suspense>
      )}
      <ToastContainer />
    </main>
  );
}

function MobileTitlebar({
  sidebarOpen,
  jianOpen,
  previewOpen,
  onToggleSidebar,
  onToggleJian,
  onTogglePreview,
}: {
  sidebarOpen: boolean;
  jianOpen: boolean;
  previewOpen: boolean;
  onToggleSidebar: () => void;
  onToggleJian: () => void;
  onTogglePreview: () => void;
}) {
  return (
    <div className="titlebar">
      <div className="tb-left-group">
        <button
          type="button"
          className={`tb-toggle tb-toggle-left${sidebarOpen ? ' active' : ''}`}
          id="tbToggleLeft"
          title={tr('sidebar.toggle', '会话列表')}
          aria-label={tr('sidebar.toggle', '会话列表')}
          aria-pressed={sidebarOpen}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onToggleSidebar}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="9" y1="3" x2="9" y2="21"></line>
          </svg>
        </button>
      </div>
      <div className="tb-center-group">
        <span className="mobile-titlebar-label">Codia</span>
      </div>
      <div className="tb-right-group">
        <button
          type="button"
          className={`tb-toggle tb-toggle-preview${previewOpen ? ' active' : ''}`}
          id="tbTogglePreview"
          title={tr('preview.toggle', '预览')}
          aria-label={tr('preview.toggle', '预览')}
          aria-pressed={previewOpen}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onTogglePreview}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 3.5h7l3 3v14H7z"></path>
            <path d="M14 3.5v3h3"></path>
            <path d="M9.5 11h5"></path>
            <path d="M9.5 14.5h5"></path>
          </svg>
        </button>
        <button
          type="button"
          className={`tb-toggle tb-toggle-right${jianOpen ? ' active' : ''}`}
          id="tbToggleRight"
          title={tr('sidebar.jian', '工作区')}
          aria-label={tr('sidebar.jian', '工作区')}
          aria-pressed={jianOpen}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onToggleJian}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="15" y1="3" x2="15" y2="21"></line>
          </svg>
        </button>
      </div>
      <WindowControls />
    </div>
  );
}

function MobileChatSidebar({
  open,
  onNewSession,
  onCollapse,
}: {
  open: boolean;
  onNewSession: () => void;
  onCollapse: () => void;
}) {
  const currentAgentId = useStore(s => s.currentAgentId);

  return (
    <aside className={`sidebar${open ? '' : ' collapsed'}`} id="sidebar">
      <div className="sidebar-inner">
        <div className="sidebar-chat-content">
          <div className="sidebar-header">
            <span className="sidebar-title">{tr('sidebar.title', '会话')}</span>
            <div className="sidebar-header-actions">
              <button type="button" className="sidebar-action-btn" id="newSessionBtn" title={tr('sidebar.newChat', '新建会话')} onClick={onNewSession}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>
              <button type="button" className="sidebar-action-btn" id="sidebarCollapseBtn" title={tr('sidebar.collapse', '收起')} onClick={onCollapse}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 6 9 12 15 18"></polyline>
                </svg>
              </button>
            </div>
          </div>
          <div className="session-list" id="sessionList">
            <RegionalErrorBoundary region="mobile-sidebar" resetKeys={[currentAgentId]}>
              <SessionList />
            </RegionalErrorBoundary>
          </div>
          <div className="sidebar-footer">
            <ArchivedChatsButton />
          </div>
        </div>
      </div>
      <div className="resize-handle resize-handle-right" id="sidebarResizeHandle"></div>
    </aside>
  );
}

function MobileChatPage() {
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const hasPanels = !welcomeVisible && !!currentSessionPath;

  return (
    <>
      <div className={`chat-area${hasPanels ? ' has-panels' : ''}`} data-byoung-chat-color-scope="">
        <WelcomeContainer />
        <RegionalErrorBoundary region="mobile-chat" resetKeys={[currentSessionPath]}>
          <ChatArea />
        </RegionalErrorBoundary>
      </div>
      <div className="input-area" data-byoung-chat-color-scope="">
        <RegionalErrorBoundary
          region="mobile-input"
          resetKeys={[currentSessionPath]}
        >
          <InputArea key={currentSessionPath || '__new'} surface="mobile" />
        </RegionalErrorBoundary>
      </div>
    </>
  );
}

function WelcomeContainer() {
  const visible = useStore(s => s.welcomeVisible);
  return (
    <div className={`welcome${visible ? '' : ' hidden'}`} id="welcome">
      <WelcomeScreen enableSettings={false} />
    </div>
  );
}

function MobileWorkspaceRail({ open }: { open: boolean }) {
  return (
    <aside className={`jian-sidebar${open ? '' : ' collapsed'}`} id="jianSidebar">
      <div className="resize-handle resize-handle-left" id="jianResizeHandle"></div>
      <div className="jian-sidebar-inner">
        <RegionalErrorBoundary region="right-workspace">
          <RightWorkspacePanel />
        </RegionalErrorBoundary>
      </div>
    </aside>
  );
}

function ConnectionStatus() {
  const connected = useStore(s => s.connected);
  const statusKey = useStore(s => s.statusKey);
  const statusVars = useStore(s => s.statusVars);
  return (
    <div className={`connection-status${connected ? ' connected' : ''}`}>
      <span className="status-dot"></span>
      <span className="status-text">{statusKey ? tr(statusKey, '', statusVars) || statusKey : ''}</span>
    </div>
  );
}

function MobileLoadingScreen({ subtitle }: { subtitle: string }) {
  return (
    <main className="onboarding">
      <section className="onboarding-step active">
        <img className="onboarding-avatar" src="./icon.png" alt="" />
        <h1 className="onboarding-title">Codia</h1>
        <p className="onboarding-subtitle">{subtitle}</p>
      </section>
    </main>
  );
}

function MobileLoginScreen({
  mode,
  secret,
  username,
  password,
  error,
  onModeChange,
  onSecretChange,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
}: {
  mode: LoginMode;
  secret: string;
  username: string;
  password: string;
  error: string | null;
  onModeChange: (mode: LoginMode) => void;
  onSecretChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const loginDisabled = mode === 'device'
    ? !secret.trim()
    : !username.trim() || !password;

  return (
    <main className="onboarding">
      <form className="onboarding-step active" onSubmit={onSubmit}>
        <img className="onboarding-avatar" src="./icon.png" alt="" />
        <h1 className="onboarding-title">网页访问 Codia</h1>
        <p className="onboarding-subtitle">
          {mode === 'device'
            ? '输入桌面端为这台设备生成的访问密钥。登录后会改用 HttpOnly 会话 cookie。'
            : '使用桌面端设置的本地账号登录。远程明文 HTTP 会被服务器拒绝，请使用本机、HTTPS 或可信隧道。'}
        </p>

        <div className="provider-grid" role="tablist" aria-label="登录方式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'device'}
            className={`provider-card${mode === 'device' ? ' selected' : ''}`}
            onClick={() => onModeChange('device')}
          >
            访问密钥
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'password'}
            className={`provider-card${mode === 'password' ? ' selected' : ''}`}
            onClick={() => onModeChange('password')}
          >
            用户名密码
          </button>
        </div>

        {mode === 'device' ? (
          <label className="custom-field">
            <span className="ob-field-label">访问密钥</span>
            <input
              className="ob-input"
              value={secret}
              onChange={(event) => onSecretChange(event.target.value)}
              autoComplete="one-time-code"
              spellCheck={false}
            />
          </label>
        ) : (
          <>
            <label className="custom-field">
              <span className="ob-field-label">用户名</span>
              <input
                className="ob-input"
                value={username}
                onChange={(event) => onUsernameChange(event.target.value)}
                autoComplete="username"
                spellCheck={false}
              />
            </label>
            <label className="custom-field">
              <span className="ob-field-label">密码</span>
              <input
                className="ob-input"
                value={password}
                onChange={(event) => onPasswordChange(event.target.value)}
                type="password"
                autoComplete="current-password"
              />
            </label>
          </>
        )}

        {error && <div className="ob-status error">{error}</div>}
        <div className="onboarding-actions">
          <button className="ob-btn ob-btn-primary" type="submit" disabled={loginDisabled}>登录</button>
        </div>
      </form>
    </main>
  );
}

function toggleMobilePreviewPanel() {
  const state = useStore.getState();
  if (state.previewOpen) {
    closePreview();
    return;
  }
  useStore.setState({ previewOpen: true, sidebarOpen: false, jianOpen: false });
}

function closeMobileDrawers() {
  useStore.setState({ sidebarOpen: false, jianOpen: false });
}

function shouldIgnoreMobileEdgeGestureTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, button, [contenteditable="true"], [data-mobile-gesture-ignore="true"]'));
}

function principalHasRequiredScopes(principal: MobilePrincipal, requiredScopes: readonly string[]): boolean {
  const scopes = Array.isArray(principal.scopes) ? principal.scopes : [];
  return requiredScopes.every((scope) => scopeAllows(scopes, scope));
}

function scopeAllows(scopes: string[], required: string): boolean {
  if (scopes.includes(required)) return true;
  const [namespace] = required.split('.');
  return scopes.includes(namespace) || scopes.includes(`${namespace}.*`);
}

function tr(key: string, fallback: string, vars?: Record<string, string | number>): string {
  try {
    const value = window.t?.(key, vars);
    return !value || value === key ? fallback : value;
  } catch {
    return fallback;
  }
}

function useNarrowMobileViewport(): boolean {
  const [isNarrow, setIsNarrow] = useState(() => {
    if (typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(max-width: 860px)').matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(max-width: 860px)');
    const apply = () => setIsNarrow(media.matches);
    apply();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
    media.addListener(apply);
    return () => media.removeListener(apply);
  }, []);

  return isNarrow;
}

