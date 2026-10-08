/**
  *
  * */

import { useCallback, useEffect, useRef, useState, lazy, Suspense, type TouchEvent } from 'react';
import { ChatCircleDots, UsersThree, FlowArrow, Wrench, Flower, Plus } from '@phosphor-icons/react';
import codiaBrandEmblem from '../assets/codia/codia-brand-emblem.png';
import { useStore } from './stores';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RegionalErrorBoundary } from './components/RegionalErrorBoundary';

const SkillViewerOverlay = lazy(() => import('./components/SkillViewerOverlay').then(m => ({ default: m.SkillViewerOverlay })));
const PreviewPanel = lazy(() => import('./components/PreviewPanel').then(m => ({ default: m.PreviewPanel })));
const ActivityPanel = lazy(() => import('./components/ActivityPanel').then(m => ({ default: m.ActivityPanel })));
const AutomationPanel = lazy(() => import('./components/AutomationPanel').then(m => ({ default: m.AutomationPanel })));
const SkillsPanel = lazy(() => import('./components/SkillsPanel').then(m => ({ default: m.SkillsPanel })));
const BridgePanel = lazy(() => import('./components/BridgePanel').then(m => ({ default: m.BridgePanel })));
import { RightWorkspacePanel } from './components/right-workspace/RightWorkspacePanel';
import { PluginPageView } from './components/plugin/PluginPageView';
import { InputArea } from './components/InputArea';
import { SessionList } from './components/SessionList';
import { SidebarNoticeSlot } from './components/notices/SidebarNoticeSlot';
import { ArchivedChatsButton } from './components/ArchivedChatsButton';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ChatArea } from './components/chat/ChatArea';
import {
  ChannelsPanel,
  ChannelMessages,
  ChannelInput,
  ChannelReadonly,
  ChannelMembers,
  ChannelAgentActivityPanel,
  ChannelAgentSettingsPanel,
} from './components/ChannelsPanel';
import { WidgetButtons } from './components/plugin/WidgetButtons';
const ChannelListSidebar = lazy(() => import('./components/channels/ChannelList').then(m => ({ default: m.ChannelListSidebar })));
import { ChannelHeader } from './components/channels/ChannelHeader';
const ChannelCreateOverlay = lazy(() => import('./components/channels/ChannelCreateOverlay').then(m => ({ default: m.ChannelCreateOverlay })));
const ChannelWorkspacePanel = lazy(() => import('./components/channels/ChannelWorkspacePanel').then(m => ({ default: m.ChannelWorkspacePanel })));
const ChannelWorkflowWindow = lazy(() => import('./components/channels/ChannelWorkflowWindow').then(m => ({ default: m.ChannelWorkflowWindow })));
import { SidebarLayout, toggleSidebar } from './components/SidebarLayout';
import { FloatPreviewCard, useFloatCard } from './components/FloatPreviewCard';
import { useSidebarResize } from './hooks/use-sidebar-resize';
import { createNewSession } from './stores/session-actions';
import { toggleJianSidebar } from './stores/desk-actions';
import { WindowControls } from './components/WindowControls';
import { ToastContainer } from './components/ToastContainer';
import { InputContextMenu } from './components/InputContextMenu';
import { StatusBar } from './components/StatusBar';
import { SelectionQuoteActionSurface } from './components/selection/SelectionQuoteActionSurface';
import { MediaViewer } from './components/shared/MediaViewer/MediaViewer';
import { SettingsModalShell } from './components/SettingsModalShell';
import { initTheme, initDragPrevention } from './bootstrap';
import { initApp } from './app-init';
import { MainContent } from './MainContent';
import { useAnyBrowserRunning } from './stores/browser-slice';
import { openSettingsModal } from './stores/settings-modal-actions';
import { switchTab } from './components/channels/tab-router';
import { calculateInputCardBottomInset, parseCssPixels } from './utils/input-card-layout';
import {
  finishMobileEdgeGesture,
  startMobileEdgeGesture,
  updateMobileEdgeGesture,
  type MobileEdge,
  type MobileEdgeGesture,
} from './utils/mobile-edge-gesture';

declare function t(key: string, vars?: Record<string, string | number>): string;

//
initTheme();
initDragPrevention();

function tx(key: string, fallback: string, vars?: Record<string, string | number>): string {
  const translate = typeof window !== 'undefined' ? window.t : undefined;
  if (typeof translate !== 'function') return fallback;
  try {
    const value = translate(key, vars);
    return value && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
}

function CriticalRegionFallback({
  title,
  hint,
  onRetry,
}: {
  title: string;
  hint: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        minHeight: 180,
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        color: 'var(--text-secondary, #6b7785)',
        textAlign: 'center',
      }}
    >
      <div style={{ fontWeight: 600, color: 'var(--text, #172033)' }}>{title}</div>
      <div style={{ maxWidth: 420, fontSize: 12, lineHeight: 1.6 }}>{hint}</div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          border: '1px solid var(--border-light, #d8d8d8)',
          borderRadius: 6,
          background: 'var(--bg, #fff)',
          color: 'inherit',
          padding: '5px 14px',
          cursor: 'pointer',
        }}
      >
        {tx('action.retry', '重试')}
      </button>
    </div>
  );
}

function isNarrowMobileViewport(): boolean {
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(max-width: 720px)').matches;
  }
  return window.innerWidth <= 720;
}

function shouldIgnoreMobileEdgeGestureTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, button, [contenteditable="true"], [data-mobile-gesture-ignore="true"]'));
}

function closeMobileDrawers() {
  useStore.setState({ sidebarOpen: false, jianOpen: false });
}

//

function WelcomeContainer() {
  const visible = useStore(s => s.welcomeVisible);
  return (
    <div className={`welcome${visible ? '' : ' hidden'}`} id="welcome">
      <WelcomeScreen />
    </div>
  );
}

function ConnectionStatus() {
  const connected = useStore(s => s.connected);
  const statusKey = useStore(s => s.statusKey);
  const statusVars = useStore(s => s.statusVars);
  return (
    <div className={`connection-status${connected ? ' connected' : ''}`}>
      <span className="status-dot"></span>
      <span className="status-text">{statusKey ? t(statusKey, statusVars) : ''}</span>
    </div>
  );
}

function ChannelInputArea() {
  const currentChannel = useStore(s => s.currentChannel);
  const isDM = useStore(s => s.channelIsDM);

  if (!currentChannel) return null;

  if (isDM) {
    return (
      <div className="channel-readonly-notice" data-byoung-chat-color-scope="">
        <ChannelReadonly />
      </div>
    );
  }

  return (
    <div className="channel-input-area" data-byoung-chat-color-scope="">
      <ChannelInput />
    </div>
  );
}

function JianChannelInfo() {
  const isDM = useStore(s => s.channelIsDM);

  if (isDM) {
    return (
      <div className="channel-info-stack">
        <div className="jian-card">
          <div className="channel-info-section">
            <div className="channel-info-label">{t('channel.dmLabel')}</div>
            <div className="channel-members-list">
              <ChannelMembers />
            </div>
          </div>
        </div>
        <ChannelAgentSettingsPanel />
        <ChannelAgentActivityPanel />
      </div>
    );
  }

  return (
    <div className="channel-info-stack">
      <Suspense fallback={null}>
        <ChannelWorkspacePanel />
      </Suspense>
      <ChannelAgentSettingsPanel />
      <ChannelAgentActivityPanel />
    </div>
  );
}

// App root component.

function App() {
  useSidebarResize();
  const sidebarOpen = useStore(s => s.sidebarOpen);
  const jianOpen = useStore(s => s.jianOpen);
  const currentTab = useStore(s => s.currentTab);
  const channelTotalUnread = useStore(s => s.channelTotalUnread);
  const browserRunning = useAnyBrowserRunning();
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const currentSessionId = useStore(s => s.currentSessionId);
  const currentAgentId = useStore(s => s.currentAgentId);
  const currentChannel = useStore(s => s.currentChannel);
  const channels = useStore(s => s.channels);
  const userName = useStore(s => s.userName);
  const userAvatarUrl = useStore(s => s.userAvatarUrl);
  const activePanel = useStore(s => s.activePanel);
  const previewOpen = useStore(s => s.previewOpen);
  const channelCreateOverlayVisible = useStore(s => s.channelCreateOverlayVisible);
  const isChatMode = currentTab === 'chat';
  const isPluginTab = typeof currentTab === 'string' && currentTab.startsWith('plugin:');
  const sidebarVisible = sidebarOpen && !isPluginTab;
  const currentSessionIdentityKey = currentSessionId || currentSessionPath || '__new';
  const hasPanels = !welcomeVisible && !!currentSessionPath;
  const rightSidebarOpen = currentTab !== 'workflow' && jianOpen;
  const { floatCard, show: showFloat, scheduleHide: scheduleFloatHide, cancelHide: cancelFloatHide, hide: hideFloat } = useFloatCard();
  const mobileEdgeGestureRef = useRef<MobileEdgeGesture | null>(null);
  const titlebarModeClass = isChatMode ? ' titlebar-chat-mode' : ' titlebar-workspace-mode';
  const titlebarClassName = `titlebar${titlebarModeClass}`;
  const goChat = useCallback(() => {
    useStore.getState().setActivePanel(null);
    switchTab('chat');
  }, []);
  const goWorkflow = useCallback(async () => {
    useStore.getState().setActivePanel(null);
    switchTab('workflow');
  }, []);
  const goActivity = useCallback(() => {
    const state = useStore.getState();
    if (state.activePanel === 'activity') {
      state.setActivePanel(null);
      return;
    }
    switchTab('chat');
    useStore.getState().setActivePanel('activity');
  }, []);

  useEffect(() => {
    initApp().catch((err: unknown) => {
      console.error('[init] initialization failed', err);
      window.platform?.appReady?.();
    });
  }, []);

  const inputAreaRef = useRef<HTMLDivElement>(null);
  const inputCardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = inputAreaRef.current;
    if (!el) return;
    const parent = el.closest('.main-content') as HTMLElement | null;
    if (!parent) return;

    const updateInputHeight = (entry?: ResizeObserverEntry) => {
      if (currentTab !== 'chat') return;
      const surfaceHeight = entry?.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height;
      const card = inputCardRef.current;
      const editorElement = card?.querySelector<HTMLElement>('#inputBox');
      if (!card || !editorElement) {
        if (surfaceHeight > 0) parent.style.setProperty('--input-card-h', `${surfaceHeight}px`);
        parent.style.removeProperty('--input-card-bottom-inset');
        return;
      }

      const editorStyle = window.getComputedStyle(editorElement);
      const editorFontSize = parseCssPixels(editorStyle.fontSize, 16);
      const editorLineHeight = parseCssPixels(editorStyle.lineHeight, editorFontSize * 1.6);
      const cardRect = card.getBoundingClientRect();
      const surfaceRect = el.getBoundingClientRect();
      const queuePanel = el.querySelector<HTMLElement>('[data-prompt-queue-panel]');
      const cardHeight = cardRect.height || card.offsetHeight;
      const editorHeight = editorElement.getBoundingClientRect().height || editorElement.offsetHeight;
      if (cardHeight <= 0) return;
      const upperSurfaceHeight = Math.max(0, cardRect.top - surfaceRect.top);
      const bottomInset = calculateInputCardBottomInset({
        cardHeight,
        editorHeight,
        editorLineHeight,
        upperChromeHeight: upperSurfaceHeight,
      });
      const reservedBottomInset = queuePanel
        ? Math.max(bottomInset, bottomInset + upperSurfaceHeight)
        : bottomInset;

      parent.style.setProperty('--input-card-h', `${queuePanel ? Math.max(surfaceHeight, cardHeight) : cardHeight}px`);
      parent.style.setProperty('--input-card-bottom-inset', `${reservedBottomInset}px`);
    };

    updateInputHeight();
    const ro = new ResizeObserver(([entry]) => updateInputHeight(entry));
    ro.observe(el);
    if (inputCardRef.current) ro.observe(inputCardRef.current);
    const editorElement = inputCardRef.current?.querySelector<HTMLElement>('#inputBox');
    if (editorElement) ro.observe(editorElement);
    const frame = window.requestAnimationFrame(() => updateInputHeight());
    return () => {
      window.cancelAnimationFrame(frame);
      ro.disconnect();
      parent.style.removeProperty('--input-card-bottom-inset');
    };
  }, [currentSessionPath, currentTab]);

  const openMobileDrawerFromGesture = useCallback((edge: MobileEdge) => {
    hideFloat();
    if (edge === 'left') {
      useStore.setState({ jianOpen: false });
      toggleSidebar(true);
      return;
    }
    useStore.setState({ sidebarOpen: false });
    toggleJianSidebar(true);
  }, [hideFloat]);

  const handleMobileEdgeTouchStart = useCallback((event: TouchEvent<HTMLElement>) => {
    mobileEdgeGestureRef.current = null;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    mobileEdgeGestureRef.current = startMobileEdgeGesture({
      clientX: touch.clientX,
      clientY: touch.clientY,
      viewportWidth: window.innerWidth || document.documentElement.clientWidth,
      isNarrow: isNarrowMobileViewport(),
      drawerOpen: sidebarOpen || jianOpen,
      targetIgnored: shouldIgnoreMobileEdgeGestureTarget(event.target),
    });
  }, [jianOpen, sidebarOpen]);

  const handleMobileEdgeTouchMove = useCallback((event: TouchEvent<HTMLElement>) => {
    const gesture = mobileEdgeGestureRef.current;
    if (!gesture || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const result = updateMobileEdgeGesture(gesture, touch.clientX, touch.clientY);
    mobileEdgeGestureRef.current = result.gesture;
    if (result.shouldPreventDefault) event.preventDefault();
  }, []);

  const handleMobileEdgeTouchEnd = useCallback((event: TouchEvent<HTMLElement>) => {
    const gesture = mobileEdgeGestureRef.current;
    mobileEdgeGestureRef.current = null;
    if (!gesture) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const edge = finishMobileEdgeGesture(gesture, touch.clientX, touch.clientY);
    if (edge) openMobileDrawerFromGesture(edge);
  }, [openMobileDrawerFromGesture]);

  return (
    <ErrorBoundary>
      {/* Headless behavior components */}
      <SidebarLayout />
      <ChannelsPanel />

      <div className="app-shell">
        {/* ── Titlebar ── */}
        <div className={titlebarClassName}>
          <div className="tb-left-group">
            <button type="button"
              className={`tb-toggle tb-toggle-left${sidebarOpen ? ' active' : ''}`}
              id="tbToggleLeft"
              title={t('sidebar.toggle')}
              onClick={() => { hideFloat(); toggleSidebar(); }}
              onMouseEnter={(e) => showFloat('left', e.currentTarget)}
              onMouseLeave={scheduleFloatHide}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="9" y1="3" x2="9" y2="21"></line>
              </svg>
            </button>
            {!sidebarVisible && (
              <div className="codia-titlebar-brand" data-testid="codia-titlebar-brand" aria-label="Codia 小豆蔻">
                <img src={codiaBrandEmblem} alt="" />
                <strong>Codia</strong>
              </div>
            )}
            <div className="tb-left-tools"></div>
          </div>
          <div className="tb-right-group">
            <div className="tb-right-tools">
              <WidgetButtons />
            </div>
            <div className="tb-pinned-tools" data-titlebar-pinned-tools>
              <button type="button"
                className={`tb-toggle tb-toggle-right${jianOpen ? ' active' : ''}`}
                id="tbToggleRight"
                title={t('sidebar.jian')}
                onClick={() => { hideFloat(); toggleJianSidebar(); }}
                onMouseEnter={(e) => showFloat('right', e.currentTarget)}
                onMouseLeave={scheduleFloatHide}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="15" y1="3" x2="15" y2="21"></line>
                </svg>
              </button>
            </div>
          </div>
          <WindowControls />
        </div>

        {/* ── App body ── */}
        <div
          className="app"
          onTouchStart={handleMobileEdgeTouchStart}
          onTouchMove={handleMobileEdgeTouchMove}
          onTouchEnd={handleMobileEdgeTouchEnd}
          onTouchCancel={() => { mobileEdgeGestureRef.current = null; }}
        >
        {/* Left sidebar */}
        <aside className={`sidebar${sidebarVisible ? '' : ' collapsed'}`} id="sidebar">
          <div className="sidebar-inner">
            <div className="codia-brand-lockup">
              <img src={codiaBrandEmblem} alt="" className="codia-brand-mark" />
              <div><strong>Codia</strong><span>小豆蔻 · AI 工作室</span></div>
            </div>
            <nav className="codia-primary-nav" aria-label="主导航">
              <div className={`codia-chat-nav-row${currentTab === 'chat' && activePanel === null ? ' active' : ''}`}>
                <button type="button" className="codia-nav-item" onClick={goChat}><ChatCircleDots weight="fill" /><span>聊天</span></button>
                <button type="button" className="codia-new-chat-btn" id="newSessionBtn" title={t('sidebar.newChat')} aria-label={t('sidebar.newChat')} onClick={() => { goChat(); void createNewSession(); }}>
                  <Plus size={17} weight="bold" aria-hidden="true" />
                </button>
              </div>
              <button type="button" className={`codia-nav-item${currentTab === 'channels' ? ' active' : ''}`} onClick={() => switchTab('channels')}><UsersThree weight="fill" /><span>Agent 小队</span>{channelTotalUnread > 0 && <span className="codia-nav-badge" aria-label={`${channelTotalUnread} 条未读消息`}>{channelTotalUnread > 99 ? '99+' : channelTotalUnread}</span>}</button>
              <button type="button" className={`codia-nav-item${currentTab === 'workflow' ? ' active' : ''}`} onClick={() => void goWorkflow()}><FlowArrow weight="fill" /><span>工作流</span></button>
              <button type="button" className={`codia-nav-item${activePanel === 'activity' ? ' active' : ''}`} onClick={goActivity}><Wrench weight="fill" /><span>活动与插件</span></button>
            </nav>
            <div className={`sidebar-chat-content${currentTab === 'chat' ? '' : ' hidden'}`}>
              <>
              <button type="button" className={`sidebar-activity-bar browser-bg-bar${browserRunning ? '' : ' hidden'}`} id="browserBgBar" title={t('browser.backgroundHint')} onClick={() => window.platform?.openBrowserViewer?.()}>
                <svg className="browser-bg-globe" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="2" y1="12" x2="22" y2="12"></line>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
                </svg>
                <span>{t('browser.background')}</span>
              </button>
              <div className="session-list" id="sessionList">
                <RegionalErrorBoundary region="sidebar" resetKeys={[currentAgentId]}>
                  <SessionList />
                </RegionalErrorBoundary>
                <SidebarNoticeSlot />
              </div>
              <div className="sidebar-footer">
                <ArchivedChatsButton />
              </div>
              </>
            </div>

            {/* 频道 tab 内容 */}
            <div className={`sidebar-channel-content${currentTab === 'channels' ? '' : ' hidden'}`}>
              {currentTab === 'channels' && (
                <Suspense fallback={null}>
                  <ChannelListSidebar />
                </Suspense>
              )}
            </div>
          </div>
          <button type="button" className="codia-profile" onClick={() => openSettingsModal('me')}>
            {userAvatarUrl ? <img src={userAvatarUrl} alt="" /> : <span className="codia-profile-avatar">{(userName || 'U').slice(0, 1).toUpperCase()}</span>}
            <span><strong>{userName && userName !== 'User' ? userName : '个人空间'}</strong><small>账户与偏好设置</small></span>
            <Flower size={16} weight="fill" />
          </button>
          <div className="resize-handle resize-handle-right" id="sidebarResizeHandle"></div>
        </aside>

        {/* Main content */}
        <MainContent>

          <div
            className={`chat-area${currentTab === 'chat' ? '' : ' hidden'}${hasPanels ? ' has-panels' : ''}`}
            data-byoung-chat-color-scope=""
          >
            <WelcomeContainer />
            <RegionalErrorBoundary
              region="chat"
              resetKeys={[currentSessionIdentityKey]}
            >
              <ChatArea />
            </RegionalErrorBoundary>
          </div>

          <div
            className={`input-area${currentTab === 'chat' ? '' : ' hidden'}`}
            data-byoung-chat-color-scope=""
            ref={inputAreaRef}
          >
            <RegionalErrorBoundary
              region="input"
              resetKeys={[currentSessionIdentityKey]}
              fallback={({ reset }) => (
                <CriticalRegionFallback
                  title="输入区暂时无法显示"
                  hint="发送控件渲染遇到异常。重试不会丢失当前会话；如果仍异常，请切换会话或刷新窗口。"
                  onRetry={reset}
                />
              )}
            >
              <InputArea key={currentSessionIdentityKey} cardRef={inputCardRef} visible={currentTab === 'chat' && activePanel === null} />
            </RegionalErrorBoundary>
          </div>

          {currentTab === 'channels' && (
            <div className="channel-page">
              <div className="channel-view active">
                {currentChannel ? (
                  <>
                    <ChannelHeader />
                    <div className="channel-messages" data-byoung-chat-color-scope="">
                      <ChannelMessages />
                    </div>
                    <ChannelInputArea />
                  </>
                ) : (
                  <div className="channel-select-empty">
                    {t('channel.selectHint')}
                  </div>
                )}
              </div>
              {currentChannel && (
                <aside className="channel-inspector-rail" id="channelInspector" data-channel-inspector="">
                  <div className="resize-handle resize-handle-left" id="channelInspectorResizeHandle"></div>
                  <JianChannelInfo />
                </aside>
              )}
            </div>
          )}

          {currentTab === 'workflow' && (
            <Suspense fallback={<div className="workflow-page-loading">正在打开工作流…</div>}>
              <ChannelWorkflowWindow open pageMode standalone onClose={() => switchTab('chat')} />
            </Suspense>
          )}

          {isPluginTab && (
            <div style={{ flex: 1, display: 'flex' }}>
              <PluginPageView pluginId={currentTab.slice(7)} />
            </div>
          )}

          {/* Floating panels render into main-content */}
          <Suspense fallback={null}>
            {activePanel === 'activity' && <ActivityPanel />}
            {activePanel === 'automation' && <AutomationPanel />}
            {activePanel === 'skills' && <SkillsPanel />}
            {activePanel === 'bridge' && <BridgePanel />}
          </Suspense>
        </MainContent>

        <Suspense fallback={null}>
          {previewOpen && <PreviewPanel />}
        </Suspense>

        {/* Right sidebar (Jian) */}
        <aside className={`jian-sidebar${rightSidebarOpen ? '' : ' collapsed'}`} id="jianSidebar">
          <div className="resize-handle resize-handle-left" id="jianResizeHandle"></div>
          <div className="jian-sidebar-inner">
            <div className={`jian-chat-content${currentTab === 'chat' || isPluginTab || currentTab === 'channels' ? '' : ' hidden'}`}>
              <RegionalErrorBoundary region="right-workspace">
                <RightWorkspacePanel />
              </RegionalErrorBoundary>
            </div>
          </div>
        </aside>
        </div>
      </div>

      {(sidebarOpen || jianOpen) && (
        <button
          className="mobile-drawer-scrim"
          type="button"
          aria-label={t('sidebar.collapse')}
          onClick={closeMobileDrawers}
        />
      )}

      {/* Connection status */}
      <ConnectionStatus />

      {/* Channel create overlay */}
      <Suspense fallback={null}>
        {channelCreateOverlayVisible && <ChannelCreateOverlay />}
      </Suspense>

      {/* Skill viewer overlay */}
      <Suspense fallback={null}><SkillViewerOverlay /></Suspense>

      {/* Float preview card */}
      {floatCard && (
        <FloatPreviewCard
          state={floatCard}
          onMouseEnter={cancelFloatHide}
          onMouseLeave={scheduleFloatHide}
          onAction={hideFloat}
        />
      )}

      {/* Connection status bar */}
      <StatusBar />

      {/* Media viewer overlay */}
      <MediaViewer />

      {/* In-window settings overlay */}
      <SettingsModalShell />

      {/* Input context menu (cut/copy/paste) */}
      <InputContextMenu />

      {/* Selection quote action */}
      <SelectionQuoteActionSurface />

      {/* Toast notifications */}
      <ToastContainer />
    </ErrorBoundary>
  );
}

export default App;
