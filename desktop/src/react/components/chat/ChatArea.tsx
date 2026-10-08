import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from '../../stores';
import { sessionScopedListIncludes, sessionScopedValue } from '../../stores/session-slice';
import { loadMoreMessages } from '../../stores/session-actions';
import { captureChatSelection } from '../../stores/selection-actions';
import type { ChatListItem } from '../../stores/chat-types';
import { useContinuousBottomScroll } from '../../hooks/use-continuous-bottom-scroll';
import { useBoxSelection } from '../../hooks/use-box-selection';
import { ChatTranscript } from './ChatTranscript';
import { ChatTimelineNavigator } from './ChatTimelineNavigator';
import { buildTimelineAnchors } from './timeline-anchors';
import styles from './Chat.module.css';

const EMPTY_ITEMS: ChatListItem[] = [];
const MAX_ALIVE = 5;
const WIDE_PLUGIN_CARD_IDS = new Set(['knowledge-graph', 'mind-map']);
const LOAD_MORE_THRESHOLD = 200;
const SCROLL_THRESHOLD = 50;
const TIMELINE_HOVER_ZONE_PX = 64;
const TIMELINE_TOP_OFFSET_PX = 76;
const TIMELINE_HEIGHT_RATIO = 0.5;

function containsWidePluginCard(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const candidate = item as { type?: unknown; data?: unknown };
  if (candidate.type !== 'message' || !candidate.data || typeof candidate.data !== 'object') return false;
  const blocks = (candidate.data as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return false;
  return blocks.some((block) => (
    !!block
    && typeof block === 'object'
    && (block as { type?: unknown; card?: { pluginId?: unknown } }).type === 'plugin_card'
    && WIDE_PLUGIN_CARD_IDS.has(String((block as { card?: { pluginId?: unknown } }).card?.pluginId || ''))
  ));
}

function firstRenderableMessageId(items: ChatListItem[]): string | undefined {
  for (const item of items) {
    const id = safeMessageId(item);
    if (typeof id === 'string' && id) return id;
  }
  return undefined;
}

function safeMessageId(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const candidate = item as { type?: unknown; data?: unknown };
  if (candidate.type !== 'message' || !candidate.data || typeof candidate.data !== 'object') return null;
  const id = (candidate.data as { id?: unknown }).id;
  return typeof id === 'string' && id ? id : null;
}

export function ChatArea() {
  return (
    <>
      <PanelHost />
      <ScrollToBottomBtn />
    </>
  );
}

function PanelHost() {
  const currentPath = useStore(s => s.currentSessionPath);
  const currentHasItems = useStore(s => !!(currentPath && sessionScopedValue(s, s.chatSessions, currentPath)?.items?.length));
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const [alive, setAlive] = useState<string[]>([]);

  useEffect(() => {
    if (!currentPath || !currentHasItems) return;
    setAlive(prev => {
      if (prev.includes(currentPath)) return prev;
      if (prev.length >= MAX_ALIVE) {
        const evictIdx = prev.findIndex(p => p !== currentPath);
        const next = [...prev];
        next.splice(evictIdx, 1);
        next.push(currentPath);
        return next;
      }
      return [...prev, currentPath];
    });
  }, [currentPath, currentHasItems]);

  if (welcomeVisible || !currentPath) return null;

  return (
    <>
      {alive.map(path => (
        <Panel key={path} path={path} active={path === currentPath} />
      ))}
    </>
  );
}

const Panel = memo(function Panel({ path, active }: { path: string; active: boolean }) {
  const items = useStore(s => {
    const value = sessionScopedValue(s, s.chatSessions, path)?.items;
    return Array.isArray(value) ? value : EMPTY_ITEMS;
  });
  const hasMore = useStore(s => sessionScopedValue(s, s.chatSessions, path)?.hasMore ?? false);
  const loadingMore = useStore(s => sessionScopedValue(s, s.chatSessions, path)?.loadingMore ?? false);
  const isSessionStreaming = useStore(s => sessionScopedListIncludes(s, s.streamingSessions, path));
  const sessionAgentId = useStore(s => s.sessions.find(se => se.path === path)?.agentId ?? null);
  const sessionReadOnly = useStore(s => s.sessions.find(se => se.path === path)?.agentDeleted === true);
  const userName = useStore(s => s.userName ?? null);
  const userAvatarUrl = useStore(s => s.userAvatarUrl ?? null);
  const hasWidePluginCard = items.some(containsWidePluginCard);

  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const messageElementsRef = useRef(new Map<string, HTMLDivElement>());
  const [timelineRailVisible, setTimelineRailVisible] = useState(false);
  const bottomScroll = useContinuousBottomScroll({
    scrollRef: ref,
    contentRef,
    active,
    stickyThreshold: SCROLL_THRESHOLD,
  });
  const timelineAnchors = useMemo(() => buildTimelineAnchors(items), [items]);
  const handleCaptureSelection = useCallback(() => {
    if (!active) return;
    captureChatSelection(path);
  }, [active, path]);
  const orderedIds = useMemo(() => {
    const ids: string[] = [];
    for (const item of items) {
      const id = safeMessageId(item);
      if (id) ids.push(id);
    }
    return ids;
  }, [items]);
  const boxSelection = useBoxSelection({ messageElementsRef, orderedIds, sessionPath: path, active });
  const userIdentity = useMemo(() => ({ name: userName, avatarUrl: userAvatarUrl }), [userAvatarUrl, userName]);

  const handleShellPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const xFromRight = rect.right - event.clientX;
    const yFromTop = event.clientY - rect.top;
    const inRailX = xFromRight >= 0 && xFromRight <= TIMELINE_HOVER_ZONE_PX;
    const inRailY = yFromTop >= TIMELINE_TOP_OFFSET_PX
      && yFromTop <= TIMELINE_TOP_OFFSET_PX + rect.height * TIMELINE_HEIGHT_RATIO;
    setTimelineRailVisible(inRailX && inRailY);
  }, []);

  const handleShellPointerLeave = useCallback(() => {
    setTimelineRailVisible(false);
  }, []);

  const registerMessageElement = useCallback((messageId: string, element: HTMLDivElement | null) => {
    if (element) {
      messageElementsRef.current.set(messageId, element);
    } else {
      messageElementsRef.current.delete(messageId);
    }
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      const sticky = bottomScroll.checkSticky();
      if (active) {
        setScrollButton(el, !sticky, () => {
          bottomScroll.scrollToBottom({ mode: 'follow', forceSticky: true });
        });
      }
      if (el.scrollTop < LOAD_MORE_THRESHOLD) {
        const state = useStore.getState();
        const session = sessionScopedValue(state, state.chatSessions, path);
        if (session?.hasMore && !session.loadingMore) {
          loadMoreMessages(path);
        }
      }
      el.classList.add(styles['is-scrolling']);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        el.classList.remove(styles['is-scrolling']);
      }, 800);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    if (active) {
      setScrollButton(el, !bottomScroll.checkSticky(), () => {
        bottomScroll.scrollToBottom({ mode: 'follow', forceSticky: true });
      });
    }
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (hideTimer) clearTimeout(hideTimer);
      if (_scrollBtn.el === el) setScrollButton(null, false, null);
    };
  }, [active, bottomScroll, path]);

  const prevFirstId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const firstId = firstRenderableMessageId(items);
    const el = ref.current;
    if (el && prevFirstId.current && firstId !== prevFirstId.current) {
      const prevHeight = el.dataset.prevScrollHeight;
      if (prevHeight) {
        el.scrollTop += el.scrollHeight - Number(prevHeight);
      }
    }
    prevFirstId.current = firstId;
  }, [items]);

  useEffect(() => {
    const el = ref.current;
    if (el && loadingMore) {
      el.dataset.prevScrollHeight = String(el.scrollHeight);
    }
  }, [loadingMore]);

  useLayoutEffect(() => {
    if (active) bottomScroll.armInstantLanding();
  }, [active, bottomScroll]);

  const scrolledOnce = useRef(false);
  useLayoutEffect(() => {
    if (scrolledOnce.current) return;
    if (items.length > 0) {
      bottomScroll.scrollToBottom({ mode: 'instant', forceSticky: true });
      scrolledOnce.current = true;
    }
  }, [bottomScroll, items.length]);

  const prevLen = useRef(items.length);
  useEffect(() => {
    if (items.length > prevLen.current && active) {
      const last = items[items.length - 1];
      const role = last?.type === 'message' && last.data && typeof last.data === 'object'
        ? last.data.role
        : undefined;
      if (role === 'user') {
        bottomScroll.scrollToBottom({ mode: 'instant', forceSticky: true });
      } else {
        bottomScroll.followBottom();
      }
    }
    prevLen.current = items.length;
  }, [items, items.length, active, bottomScroll]);

  if (items.length === 0) return null;

  return (
    <div
      className={styles.sessionShell}
      onPointerMove={handleShellPointerMove}
      onPointerLeave={handleShellPointerLeave}
      style={{
        visibility: active ? 'visible' : 'hidden',
        zIndex: active ? 1 : 0,
        pointerEvents: active ? 'auto' : 'none',
      }}
    >
      <div
        ref={ref}
        className={styles.sessionPanel}
        data-chat-selection-root=""
        data-session-path={path}
        onPointerDown={boxSelection.onPointerDown}
        onClickCapture={boxSelection.onClickCapture}
        onMouseUp={handleCaptureSelection}
        onKeyUp={handleCaptureSelection}
      >
        <div
          ref={contentRef}
          className={[
            styles.sessionMessages,
            hasWidePluginCard ? styles.sessionMessagesWide : '',
            boxSelection.selectionModeActive ? styles.selectionModeActive : '',
          ].filter(Boolean).join(' ')}
        >
          {hasMore && (
            <div className={styles.loadMoreHint}>
              {loadingMore ? '...' : ''}
            </div>
          )}
          <ChatTranscript
            items={items}
            sessionPath={path}
            agentId={sessionAgentId}
            readOnly={sessionReadOnly}
            hideUserIdentity={false}
            userIdentity={userIdentity}
            registerMessageElement={registerMessageElement}
            enableProcessFold
          />
          {isSessionStreaming && (
            <div className={styles.typingIndicator}>
              <span /><span /><span />
            </div>
          )}
          <div className={styles.sessionFooter} />
        </div>
      </div>
      <ChatTimelineNavigator
        anchors={timelineAnchors}
        scrollRef={ref}
        contentRef={contentRef}
        messageElementsRef={messageElementsRef}
        active={active}
        railVisible={timelineRailVisible}
      />
      {boxSelection.box && (
        <div
          className={styles.selectionBox}
          style={{
            left: boxSelection.box.left,
            top: boxSelection.box.top,
            width: boxSelection.box.right - boxSelection.box.left,
            height: boxSelection.box.bottom - boxSelection.box.top,
          }}
        />
      )}
    </div>
  );
});

const _scrollBtn = {
  el: null as HTMLElement | null,
  visible: false,
  scrollToBottom: null as (() => void) | null,
  listeners: [] as (() => void)[],
};

function setScrollButton(el: HTMLElement | null, visible: boolean, scrollToBottom: (() => void) | null) {
  _scrollBtn.el = el;
  _scrollBtn.visible = visible;
  _scrollBtn.scrollToBottom = scrollToBottom;
  _scrollBtn.listeners.forEach(listener => listener());
}

function ScrollToBottomBtn() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const update = () => setVisible(_scrollBtn.visible);
    _scrollBtn.listeners.push(update);
    return () => { _scrollBtn.listeners = _scrollBtn.listeners.filter(f => f !== update); };
  }, []);

  if (!visible) return null;
  return (
    <button type="button" className={styles.scrollToBottomFab} onClick={() => {
      _scrollBtn.scrollToBottom?.();
    }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}
