/**
  *
 *
  * */

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../stores';
import { gsapFetch } from '../hooks/use-gsap-fetch';
import { useI18n } from '../hooks/use-i18n';
import { formatSessionDate } from '../utils/format';
import { switchSession, archiveSession, deleteSession, renameSession, pinSession, createNewSession } from '../stores/session-actions';
import { updateKeyed } from '../stores/create-keyed-slice';
import type { Session, Agent } from '../types';
import { AgentAvatar, resolveAgentDisplayInfo } from '../utils/agent-display';
import {
  autoProjectIdForCwd,
  buildSessionProjectView,
  buildSessionSections,
  type SessionProjectCatalog,
  type SessionProjectFolderGroup,
  type SessionProjectGroup,
  type SessionViewMode,
} from './session-sections';
import {
  createSessionProjectInCatalog,
  deleteSessionProjectFolderFromCatalog,
  deleteSessionProjectFromCatalog,
  loadSessionProjectCatalog,
  patchSessionProjectFolderInCatalog,
  patchSessionProjectInCatalog,
  reorderSessionProjectFoldersInCatalog,
  reorderSessionProjectsInCatalog,
  setSessionProjectAssignmentForSession,
} from '../stores/session-project-actions';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { renderMarkdown } from '../utils/markdown';
import { getSessionDisplayTitle } from '../utils/session-title-display';
import { cwdFromAutoProjectId } from '../../../../shared/session-projects.ts';
import {
  normalizeSidebarUiPrefs,
  type SidebarSessionListRowMode,
  type SidebarUiPrefs,
  type SidebarUiProjectViewPrefs,
} from '../../../../shared/sidebar-ui-state.ts';
import styles from './SessionList.module.css';

const SESSION_VIEW_MODE_KEY = 'gsap-session-sidebar-view-mode';
const SESSION_DRAG_MIME = 'application/x-gsap-session-path';
const PROJECT_DRAG_MIME = 'application/x-gsap-project-id';
const FOLDER_DRAG_MIME = 'application/x-gsap-project-folder-id';
const PROJECT_SESSION_PREVIEW_LIMIT = 5;

const EMPTY_PROJECT_CATALOG: SessionProjectCatalog = { folders: [], projects: [] };

type SidebarDragState =
  | { kind: 'session'; sessionPath: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'folder'; folderId: string }
  | null;

type ProjectNameDialogState =
  | { kind: 'create-project'; value: string }
  | { kind: 'rename-project'; projectId: string; value: string }
  | { kind: 'rename-folder'; folderId: string; value: string }
  | null;

type ProjectActionMenuState = {
  position: { x: number; y: number };
  project: SessionProjectGroup;
} | null;

type FolderActionMenuState = {
  position: { x: number; y: number };
  folder: SessionProjectFolderGroup;
} | null;

interface BrowserSessionState {
  url: string | null;
  running: boolean;
  resumable: boolean;
  unavailableReason: string | null;
}

interface SessionSearchResult extends Session {
  matchKind: 'title' | 'content';
  snippet: string;
  score?: number;
}

function normalizeBrowserSessionStates(data: unknown): Record<string, BrowserSessionState> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const result: Record<string, BrowserSessionState> = {};
  for (const [sessionPath, rawState] of Object.entries(data as Record<string, unknown>)) {
    if (typeof rawState === 'string') {
      result[sessionPath] = {
        url: rawState,
        running: false,
        resumable: true,
        unavailableReason: null,
      };
      continue;
    }
    if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) continue;
    const state = rawState as Partial<BrowserSessionState>;
    result[sessionPath] = {
      url: typeof state.url === 'string' ? state.url : null,
      running: state.running === true,
      resumable: state.resumable !== false,
      unavailableReason: typeof state.unavailableReason === 'string' ? state.unavailableReason : null,
    };
  }
  return result;
}

function normalizeSessionSearchResults(data: unknown): SessionSearchResult[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((raw): SessionSearchResult[] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const item = raw as Partial<SessionSearchResult>;
    if (typeof item.path !== 'string' || !item.path) return [];
    return [{
      path: item.path,
      title: typeof item.title === 'string' ? item.title : null,
      firstMessage: typeof item.firstMessage === 'string' ? item.firstMessage : '',
      modified: typeof item.modified === 'string' ? item.modified : '',
      messageCount: typeof item.messageCount === 'number' ? item.messageCount : 0,
      agentId: typeof item.agentId === 'string' ? item.agentId : null,
      agentName: typeof item.agentName === 'string' ? item.agentName : null,
      cwd: typeof item.cwd === 'string' ? item.cwd : null,
      projectId: typeof item.projectId === 'string' ? item.projectId : null,
      pinnedAt: typeof item.pinnedAt === 'string' ? item.pinnedAt : null,
      hasSummary: item.hasSummary === true,
      rcAttachment: null,
      matchKind: item.matchKind === 'content' ? 'content' : 'title',
      snippet: typeof item.snippet === 'string' ? item.snippet : '',
      score: typeof item.score === 'number' ? item.score : undefined,
    }];
  });
}

function readInitialSessionViewMode(): SessionViewMode {
  try {
    return window.localStorage?.getItem(SESSION_VIEW_MODE_KEY) === 'project' ? 'project' : 'time';
  } catch {
    return 'time';
  }
}

function normalizeSidebarUiResponse(data: unknown): SidebarUiPrefs {
  const raw = data && typeof data === 'object' && !Array.isArray(data)
    ? (data as { sidebarUi?: unknown })
    : {};
  const sidebarUi = raw.sidebarUi && typeof raw.sidebarUi === 'object' && !Array.isArray(raw.sidebarUi)
    ? raw.sidebarUi
    : raw;
  return normalizeSidebarUiPrefs(sidebarUi);
}

function sidebarProjectViewPayload(
  collapsedProjectIds: Set<string>,
  collapsedFolderIds: Set<string>,
  showAllProjectIds: Set<string>,
): { projectView: SidebarUiProjectViewPrefs } {
  return {
    projectView: {
      collapsedProjectIds: [...collapsedProjectIds],
      collapsedFolderIds: [...collapsedFolderIds],
      showAllProjectIds: [...showAllProjectIds],
    },
  };
}

function dragSessionPath(event: React.DragEvent, state: SidebarDragState): string | null {
  const fromState = state?.kind === 'session' ? state.sessionPath : null;
  return event.dataTransfer.getData(SESSION_DRAG_MIME) || fromState;
}

function dragProjectId(event: React.DragEvent, state: SidebarDragState): string | null {
  const fromState = state?.kind === 'project' ? state.projectId : null;
  return event.dataTransfer.getData(PROJECT_DRAG_MIME) || fromState;
}

function dragFolderId(event: React.DragEvent, state: SidebarDragState): string | null {
  const fromState = state?.kind === 'folder' ? state.folderId : null;
  return event.dataTransfer.getData(FOLDER_DRAG_MIME) || fromState;
}

//

export function SessionList() {
  return <SessionListInner />;
}

// ── 内部组件 ──

function SessionListInner() {
  const { t } = useI18n();
  const sessions = useStore(s => s.sessions);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const pendingSessionSwitchPath = useStore(s => s.pendingSessionSwitchPath);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const agents = useStore(s => s.agents);
  const streamingSessions = useStore(s => s.streamingSessions);
  const browserBySession = useStore(s => s.browserBySession);
  const storeProjectCatalog = useStore(s => s.sessionProjectCatalog);
  const storeProjectCatalogLoaded = useStore(s => s.sessionProjectCatalogLoaded);
  const setStoreProjectCatalog = useStore(s => s.setSessionProjectCatalog);

  const [browserSessions, setBrowserSessions] = useState<Record<string, BrowserSessionState>>({});
  const [viewMode, setViewModeState] = useState<SessionViewMode>(readInitialSessionViewMode);
  const [projectCatalogState, setProjectCatalogState] = useState<SessionProjectCatalog>(
    storeProjectCatalogLoaded ? storeProjectCatalog : EMPTY_PROJECT_CATALOG,
  );
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() => new Set());
  const [showAllProjectIds, setShowAllProjectIds] = useState<Set<string>>(() => new Set());
  const [sessionListRowMode, setSessionListRowMode] = useState<SidebarSessionListRowMode>('two-line');
  const [projectMenuPosition, setProjectMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [projectActionMenu, setProjectActionMenu] = useState<ProjectActionMenuState>(null);
  const [folderActionMenu, setFolderActionMenu] = useState<FolderActionMenuState>(null);
  const [projectNameDialog, setProjectNameDialog] = useState<ProjectNameDialogState>(null);
  const [dragState, setDragState] = useState<SidebarDragState>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [titleResults, setTitleResults] = useState<SessionSearchResult[]>([]);
  const [contentResults, setContentResults] = useState<SessionSearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<'idle' | 'title' | 'content' | 'done' | 'error'>('idle');
  const closingBrowserSessionsRef = useRef(new Set<string>());
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  const searchQueryTrimmed = searchQuery.trim();
  const sessionsSignature = useMemo(() => (
    sessions.map(s => `${s.path}:${s.title || ''}:${s.modified || ''}:${s.messageCount}:${s.projectId || ''}`).join('\n')
  ), [sessions]);
  const projectCatalog = storeProjectCatalogLoaded ? storeProjectCatalog : projectCatalogState;
  const setProjectCatalog = useCallback((next: SessionProjectCatalog | ((prev: SessionProjectCatalog) => SessionProjectCatalog)) => {
    setProjectCatalogState(prev => {
      const resolved = typeof next === 'function'
        ? (next as (prev: SessionProjectCatalog) => SessionProjectCatalog)(prev)
        : next;
      setStoreProjectCatalog(resolved);
      return resolved;
    });
  }, [setStoreProjectCatalog]);

  const setVisibleBrowserSessions = useCallback((data: unknown) => {
    const states = normalizeBrowserSessionStates(data);
    for (const sessionPath of closingBrowserSessionsRef.current) {
      delete states[sessionPath];
    }
    setBrowserSessions(states);
  }, []);

  const applySidebarUiPrefs = useCallback((data: unknown) => {
    const prefs = normalizeSidebarUiResponse(data);
    setCollapsedProjectIds(new Set(prefs.projectView.collapsedProjectIds));
    setCollapsedFolderIds(new Set(prefs.projectView.collapsedFolderIds));
    setShowAllProjectIds(new Set(prefs.projectView.showAllProjectIds));
    setSessionListRowMode(prefs.sessionList.rowMode);
  }, []);

  // Fetch browser sessions (re-fetch when browser state changes)
  useEffect(() => {
    let cancelled = false;
    if (sessions.length === 0) {
      setBrowserSessions({});
      return;
    }
    gsapFetch('/api/browser/session-states')
      .then(r => r.json())
      .then(data => {
        if (!cancelled) setVisibleBrowserSessions(data);
      })
      .catch(err => console.warn('[sessions] fetch browser sessions failed:', err));
    return () => {
      cancelled = true;
    };
  }, [sessions, browserBySession, setVisibleBrowserSessions]);

  useEffect(() => {
    if (!searchQueryTrimmed) {
      setTitleResults([]);
      setContentResults([]);
      setSearchStatus('idle');
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setTitleResults([]);
    setContentResults([]);
    setSearchStatus('title');

    const timer = window.setTimeout(async () => {
      const encodedQuery = encodeURIComponent(searchQueryTrimmed);
      try {
        const titleRes = await gsapFetch(`/api/sessions/search?q=${encodedQuery}&phase=title&limit=20`, {
          signal: controller.signal,
          timeout: 12_000,
        });
        const titleData = await titleRes.json();
        if (cancelled) return;
        setTitleResults(normalizeSessionSearchResults(titleData));
        setSearchStatus('content');

        const contentRes = await gsapFetch(`/api/sessions/search?q=${encodedQuery}&phase=content&limit=20`, {
          signal: controller.signal,
          timeout: 12_000,
        });
        const contentData = await contentRes.json();
        if (cancelled) return;
        setContentResults(normalizeSessionSearchResults(contentData));
        setSearchStatus('done');
      } catch (err) {
        if (controller.signal.aborted || cancelled) return;
        console.warn('[sessions] search failed:', err);
        setSearchStatus('error');
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchQueryTrimmed, sessionsSignature]);

  const setViewMode = useCallback((mode: SessionViewMode) => {
    setViewModeState(mode);
    try {
      window.localStorage?.setItem(SESSION_VIEW_MODE_KEY, mode);
    } catch {
      // localStorage can be unavailable in tests or privacy modes.
    }
  }, []);

  const persistSidebarProjectView = useCallback((
    nextCollapsedProjectIds: Set<string>,
    nextCollapsedFolderIds: Set<string>,
    nextShowAllProjectIds: Set<string>,
  ) => {
    gsapFetch('/api/preferences/sidebar-ui', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sidebarProjectViewPayload(
        nextCollapsedProjectIds,
        nextCollapsedFolderIds,
        nextShowAllProjectIds,
      )),
    }).catch(err => console.warn('[sessions] persist sidebar UI prefs failed:', err));
  }, []);

  useEffect(() => {
    if (viewMode !== 'project') return;
    if (storeProjectCatalogLoaded) {
      setProjectCatalogState(storeProjectCatalog);
      return;
    }
    let cancelled = false;
    loadSessionProjectCatalog()
      .then(catalog => {
        if (!cancelled) setProjectCatalog(catalog);
      })
      .catch(err => console.warn('[sessions] fetch project catalog failed:', err));
    return () => {
      cancelled = true;
    };
  }, [setProjectCatalog, storeProjectCatalog, storeProjectCatalogLoaded, viewMode]);

  useEffect(() => {
    let cancelled = false;
    gsapFetch('/api/preferences/sidebar-ui')
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        applySidebarUiPrefs(data);
      })
      .catch(err => console.warn('[sessions] fetch sidebar UI prefs failed:', err));
    return () => {
      cancelled = true;
    };
  }, [applySidebarUiPrefs]);

  useEffect(() => {
    const handleSettingsEvent = (event: Event) => {
      const detail = (event as CustomEvent)?.detail;
      if (detail?.sidebarUi) applySidebarUiPrefs({ sidebarUi: detail.sidebarUi });
    };
    window.addEventListener('hana-settings', handleSettingsEvent);
    window.platform?.onSettingsChanged?.((kind: string, payload: unknown) => {
      if (kind !== 'sidebar-ui-changed') return;
      const sidebarUi = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as { sidebarUi?: unknown }).sidebarUi
        : null;
      applySidebarUiPrefs({ sidebarUi: sidebarUi || payload });
    });
    return () => {
      window.removeEventListener('hana-settings', handleSettingsEvent);
    };
  }, [applySidebarUiPrefs]);

  useEffect(() => {
    if (!projectNameDialog) return;
    window.setTimeout(() => {
      projectNameInputRef.current?.focus();
      projectNameInputRef.current?.select();
    }, 0);
  }, [projectNameDialog]);

  const handleCloseBrowserSession = useCallback(async (sessionPath: string) => {
    closingBrowserSessionsRef.current.add(sessionPath);
    setBrowserSessions(prev => {
      const next = { ...prev };
      delete next[sessionPath];
      return next;
    });
    try {
      const res = await gsapFetch('/api/browser/close-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionPath }),
      });
      const data = await res.json();
      updateKeyed('browserBySession', sessionPath, { running: false, url: null, thumbnail: null });
      closingBrowserSessionsRef.current.delete(sessionPath);
      if (data?.sessions) {
        setBrowserSessions(normalizeBrowserSessionStates(data.sessions));
      }
    } catch (err) {
      closingBrowserSessionsRef.current.delete(sessionPath);
      console.warn('[sessions] close browser session failed:', err);
    }
  }, []);

  const updateSessionProjectAssignment = useCallback(async (sessionPath: string, projectId: string | null) => {
    await setSessionProjectAssignmentForSession(sessionPath, projectId);
  }, []);

  const patchProject = useCallback(async (projectId: string, patch: { folderId?: string | null; name?: string }) => {
    return patchSessionProjectInCatalog(projectId, patch);
  }, []);

  const patchFolder = useCallback(async (folderId: string, patch: { name?: string }) => {
    return patchSessionProjectFolderInCatalog(folderId, patch);
  }, []);

  const reorderProjects = useCallback(async (folderId: string | null, projectIds: string[]) => {
    await reorderSessionProjectsInCatalog(folderId, projectIds);
  }, []);

  const reorderFolders = useCallback(async (folderIds: string[]) => {
    await reorderSessionProjectFoldersInCatalog(folderIds);
  }, []);

  const createProject = useCallback(async (name: string) => {
    await createSessionProjectInCatalog({ name, folderId: null });
  }, []);

  const deleteProject = useCallback(async (project: SessionProjectGroup) => {
    const confirmed = window.confirm?.(t('sidebar.projects.deleteProjectConfirm', { name: project.name }));
    if (!confirmed) return;
    await deleteSessionProjectFromCatalog(project.id, project.items.map(item => item.path));
    setCollapsedProjectIds(prev => {
      const next = new Set(prev);
      next.delete(project.id);
      return next;
    });
    setShowAllProjectIds(prev => {
      const next = new Set(prev);
      next.delete(project.id);
      return next;
    });
  }, [t]);

  const deleteFolder = useCallback(async (folder: SessionProjectFolderGroup) => {
    const confirmed = window.confirm?.(t('sidebar.projects.deleteFolderConfirm', { name: folder.name }));
    if (!confirmed) return;
    await deleteSessionProjectFolderFromCatalog(folder.id);
    setCollapsedFolderIds(prev => {
      const next = new Set(prev);
      next.delete(folder.id);
      return next;
    });
  }, [t]);

  const handleCreateProjectSession = useCallback((project: SessionProjectGroup) => {
    const cwd = project.source === 'cwd' ? cwdFromAutoProjectId(project.id) : null;
    void createNewSession({ projectId: project.id, cwd });
  }, []);

  const handleProjectNameDialogSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectNameDialog) return;
    const name = projectNameDialog.value.trim();
    if (!name) return;
    if (projectNameDialog.kind === 'create-project') {
      await createProject(name);
    } else if (projectNameDialog.kind === 'rename-project') {
      await patchProject(projectNameDialog.projectId, { name });
    } else {
      await patchFolder(projectNameDialog.folderId, { name });
    }
    setProjectNameDialog(null);
  }, [createProject, patchFolder, patchProject, projectNameDialog]);

  const handleSessionDragStart = useCallback((event: React.DragEvent, session: Session) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(SESSION_DRAG_MIME, session.path);
    setDragState({ kind: 'session', sessionPath: session.path });
  }, []);

  const handleProjectDragStart = useCallback((event: React.DragEvent, projectId: string) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(PROJECT_DRAG_MIME, projectId);
    setDragState({ kind: 'project', projectId });
  }, []);

  const handleFolderDragStart = useCallback((event: React.DragEvent, folderId: string) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(FOLDER_DRAG_MIME, folderId);
    setDragState({ kind: 'folder', folderId });
  }, []);

  const clearDragState = useCallback(() => {
    setDragState(null);
    setDropTargetId(null);
  }, []);

  const ensureCatalogProject = useCallback(async (project: SessionProjectGroup, folderId: string | null = project.folderId) => {
    const existing = projectCatalog.projects.find(item => item.id === project.id);
    if (existing && existing.folderId === folderId) return;
    await patchProject(project.id, { name: project.name, folderId });
  }, [patchProject, projectCatalog.projects]);

  const handleDropOnProject = useCallback(async (event: React.DragEvent, project: SessionProjectGroup) => {
    event.preventDefault();
    event.stopPropagation();
    const sessionPath = dragSessionPath(event, dragState);
    const projectId = dragProjectId(event, dragState);
    clearDragState();
    if (sessionPath) {
      const session = sessions.find(item => item.path === sessionPath) || null;
      const ownCwdProject = session ? autoProjectIdForCwd(session.cwd) : null;
      const assignmentId = project.source === 'cwd' && ownCwdProject === project.id ? null : project.id;
      await updateSessionProjectAssignment(sessionPath, assignmentId);
      return;
    }
    if (projectId && projectId !== project.id) {
      const visibleView = buildSessionProjectView(sessions, projectCatalog);
      const visibleProjects = [
        ...visibleView.rootProjects,
        ...visibleView.folders.flatMap(folder => folder.projects),
      ];
      const draggedProject = visibleProjects.find(item => item.id === projectId) || null;
      if (!draggedProject) return;
      const targetFolderId = project.folderId || null;
      const levelProjects = visibleProjects.filter(item => (item.folderId || null) === targetFolderId);
      const nextProjectIds = levelProjects
        .map(item => item.id)
        .filter(id => id !== projectId);
      const insertIndex = nextProjectIds.indexOf(project.id);
      nextProjectIds.splice(insertIndex >= 0 ? insertIndex : nextProjectIds.length, 0, projectId);
      for (const id of nextProjectIds) {
        const visibleProject = visibleProjects.find(item => item.id === id);
        if (visibleProject) await ensureCatalogProject(visibleProject, targetFolderId);
      }
      await reorderProjects(targetFolderId, nextProjectIds);
    }
  }, [clearDragState, dragState, ensureCatalogProject, projectCatalog, reorderProjects, sessions, updateSessionProjectAssignment]);

  const handleDropOnProjectRoot = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const projectId = dragProjectId(event, dragState);
    clearDragState();
    if (!projectId) return;
    const visibleView = buildSessionProjectView(sessions, projectCatalog);
    const visibleProjects = [
      ...visibleView.rootProjects,
      ...visibleView.folders.flatMap(folder => folder.projects),
    ];
    const draggedProject = visibleProjects.find(item => item.id === projectId) || null;
    if (!draggedProject) return;
    const nextProjectIds = visibleView.rootProjects
      .map(item => item.id)
      .filter(id => id !== projectId);
    nextProjectIds.push(projectId);
    await ensureCatalogProject(draggedProject, null);
    await reorderProjects(null, nextProjectIds);
  }, [clearDragState, dragState, ensureCatalogProject, projectCatalog, reorderProjects, sessions]);

  const handleDropOnFolder = useCallback(async (event: React.DragEvent, folder: SessionProjectFolderGroup) => {
    event.preventDefault();
    event.stopPropagation();
    const projectId = dragProjectId(event, dragState);
    const folderId = dragFolderId(event, dragState);
    clearDragState();
    const visibleView = buildSessionProjectView(sessions, projectCatalog);
    if (projectId) {
      const visibleProjects = [
        ...visibleView.rootProjects,
        ...visibleView.folders.flatMap(item => item.projects),
      ];
      const draggedProject = visibleProjects.find(item => item.id === projectId) || null;
      if (!draggedProject) return;
      const nextProjectIds = folder.projects
        .map(item => item.id)
        .filter(id => id !== projectId);
      nextProjectIds.push(projectId);
      await ensureCatalogProject(draggedProject, folder.id);
      await reorderProjects(folder.id, nextProjectIds);
      return;
    }
    if (folderId && folderId !== folder.id) {
      const nextFolderIds = visibleView.folders
        .map(item => item.id)
        .filter(id => id !== folderId);
      const insertIndex = nextFolderIds.indexOf(folder.id);
      nextFolderIds.splice(insertIndex >= 0 ? insertIndex : nextFolderIds.length, 0, folderId);
      await reorderFolders(nextFolderIds);
    }
  }, [clearDragState, dragState, ensureCatalogProject, projectCatalog, reorderFolders, reorderProjects, sessions]);

  const activeSessionPath = pendingSessionSwitchPath || currentSessionPath;
  const renderSessionItem = (s: Session, options: { draggable?: boolean } = {}) => (
    <SessionItem
      key={s.path}
      session={s}
      isActive={!pendingNewSession && s.path === activeSessionPath}
      isPending={!pendingNewSession && pendingSessionSwitchPath === s.path}
      isStreaming={streamingSessions.includes(s.path)}
      isPinned={!!s.pinnedAt}
      agents={agents}
      browserState={browserSessions[s.path] || null}
      onCloseBrowser={handleCloseBrowserSession}
      rowMode={sessionListRowMode}
      draggable={options.draggable === true}
      onDragStart={handleSessionDragStart}
      onDragEnd={clearDragState}
    />
  );

  const sections = buildSessionSections(sessions, { mode: 'time' });
  const projectView = buildSessionProjectView(sessions, projectCatalog);
  const titleResultPaths = new Set(titleResults.map(result => result.path));
  const visibleContentResults = contentResults.filter(result => !titleResultPaths.has(result.path));
  const hasSearchResults = titleResults.length > 0 || visibleContentResults.length > 0;
  const isSearching = !!searchQueryTrimmed;
  const showEmptyState = sessions.length === 0 && !isSearching;
  const renderSortMenuButton = () => (
    <button
      type="button"
      className={styles.sectionIconButton}
      aria-label={t('sidebar.view.sort')}
      title={t('sidebar.view.sort')}
      onClick={(event) => setProjectMenuPosition({ x: event.clientX, y: event.clientY })}
    >
      <ListFilterIcon />
    </button>
  );
  const handleToggleProjectCollapsed = useCallback((projectId: string) => {
    setCollapsedProjectIds(prev => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      persistSidebarProjectView(next, collapsedFolderIds, showAllProjectIds);
      return next;
    });
  }, [collapsedFolderIds, persistSidebarProjectView, showAllProjectIds]);
  const handleToggleFolderCollapsed = useCallback((folderId: string) => {
    setCollapsedFolderIds(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      persistSidebarProjectView(collapsedProjectIds, next, showAllProjectIds);
      return next;
    });
  }, [collapsedProjectIds, persistSidebarProjectView, showAllProjectIds]);
  const handleShowAllProject = useCallback((projectId: string) => {
    setShowAllProjectIds(prev => {
      const next = new Set(prev);
      next.add(projectId);
      persistSidebarProjectView(collapsedProjectIds, collapsedFolderIds, next);
      return next;
    });
  }, [collapsedFolderIds, collapsedProjectIds, persistSidebarProjectView]);
  const handleProjectNameChange = useCallback((value: string) => {
    setProjectNameDialog(dialog => dialog ? { ...dialog, value } : dialog);
  }, []);
  const hasTodaySection = sections.some(section => section.kind === 'date' && section.group === 'today');
  const timeContent = sections.map(section => {
    const items = section.items.map(s => renderSessionItem(s));

    if (section.kind === 'pinned') {
      return (
        <section key={section.id} className={styles.pinnedSection}>
          <SectionTitle className={styles.pinnedSectionTitle}>
            <span>{t(section.titleKey)}</span>
            <PinIcon />
          </SectionTitle>
          {items}
        </section>
      );
    }

    return (
      <Fragment key={section.id}>
        <SectionTitle
          actions={section.group === 'today' ? renderSortMenuButton() : null}
        >
          <span>{t(section.titleKey)}</span>
        </SectionTitle>
        {items}
      </Fragment>
    );
  });
  if (!hasTodaySection && !showEmptyState) {
    const pinnedIndex = sections.findIndex(section => section.kind === 'pinned');
    timeContent.splice(Math.max(0, pinnedIndex + 1), 0, (
      <SectionTitle key="date:today-empty" actions={renderSortMenuButton()}>
        <span>{t('time.today')}</span>
      </SectionTitle>
    ));
  }
  const content = showEmptyState ? (
    <div className={styles.sessionEmpty}>{t('sidebar.empty')}</div>
  ) : isSearching ? (
    <SessionSearchResults
      titleResults={titleResults}
      contentResults={visibleContentResults}
      status={searchStatus}
      hasResults={hasSearchResults}
      agents={agents}
      activeSessionPath={activeSessionPath}
      pendingNewSession={pendingNewSession}
    />
  ) : viewMode === 'project' ? (
    <ProjectSessionView
      view={projectView}
      renderSessionItem={(session) => renderSessionItem(session, { draggable: true })}
      collapsedProjectIds={collapsedProjectIds}
      collapsedFolderIds={collapsedFolderIds}
      showAllProjectIds={showAllProjectIds}
      dragState={dragState}
      dropTargetId={dropTargetId}
      setDropTargetId={setDropTargetId}
      onToggleProject={handleToggleProjectCollapsed}
      onToggleFolder={handleToggleFolderCollapsed}
      onShowAllProject={handleShowAllProject}
      onProjectDragStart={handleProjectDragStart}
      onFolderDragStart={handleFolderDragStart}
      onDragEnd={clearDragState}
      onDropProject={handleDropOnProject}
      onDropFolder={handleDropOnFolder}
      onDropRoot={handleDropOnProjectRoot}
      onOpenMenu={setProjectMenuPosition}
      onCreateProject={() => setProjectNameDialog({ kind: 'create-project', value: '' })}
      onCreateProjectSession={handleCreateProjectSession}
      onOpenProjectMenu={(position, project) => setProjectActionMenu({ position, project })}
      onOpenFolderMenu={(position, folder) => setFolderActionMenu({ position, folder })}
    />
  ) : timeContent;

  return (
    <>
      <SessionSearchBox
        value={searchQuery}
        onChange={setSearchQuery}
        onClear={() => setSearchQuery('')}
      />
      <div className={styles.sessionListScroller}>
        {content}
      </div>
      {projectMenuPosition && (
        <ContextMenu
          position={projectMenuPosition}
          onClose={() => setProjectMenuPosition(null)}
          items={[
            {
              label: t('sidebar.view.time'),
              checked: viewMode === 'time',
              action: () => setViewMode('time'),
            },
            {
              label: t('sidebar.view.project'),
              checked: viewMode === 'project',
              action: () => setViewMode('project'),
            },
          ]}
        />
      )}
      {projectActionMenu && (
        <ContextMenu
          position={projectActionMenu.position}
          onClose={() => setProjectActionMenu(null)}
          items={[
            {
              label: t('sidebar.projects.renameProject'),
              action: () => setProjectNameDialog({
                kind: 'rename-project',
                projectId: projectActionMenu.project.id,
                value: projectActionMenu.project.name,
              }),
            },
            {
              label: t('sidebar.projects.deleteProject'),
              action: () => { void deleteProject(projectActionMenu.project); },
            },
          ]}
        />
      )}
      {folderActionMenu && (
        <ContextMenu
          position={folderActionMenu.position}
          onClose={() => setFolderActionMenu(null)}
          items={[
            {
              label: t('sidebar.projects.renameFolder'),
              action: () => setProjectNameDialog({
                kind: 'rename-folder',
                folderId: folderActionMenu.folder.id,
                value: folderActionMenu.folder.name,
              }),
            },
            {
              label: t('sidebar.projects.deleteFolder'),
              action: () => { void deleteFolder(folderActionMenu.folder); },
            },
          ]}
        />
      )}
      {projectNameDialog && (
        <ProjectNameDialog
          dialog={projectNameDialog}
          inputRef={projectNameInputRef}
          onChange={handleProjectNameChange}
          onSubmit={handleProjectNameDialogSubmit}
          onClose={() => setProjectNameDialog(null)}
        />
      )}
    </>
  );
}

function SectionTitle({
  children,
  actions = null,
  className = '',
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`${styles.sessionSectionTitle}${className ? ` ${className}` : ''}`}>
      <div className={styles.sessionSectionTitleMain}>{children}</div>
      {actions && <div className={styles.sectionTitleActions}>{actions}</div>}
    </div>
  );
}

function ProjectNameDialog({
  dialog,
  inputRef,
  onChange,
  onSubmit,
  onClose,
}: {
  dialog: NonNullable<ProjectNameDialogState>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const titleKey = dialog.kind === 'create-project'
    ? 'sidebar.projects.newProject'
    : dialog.kind === 'rename-folder'
      ? 'sidebar.projects.renameFolder'
      : 'sidebar.projects.renameProject';
  const placeholderKey = dialog.kind === 'rename-folder'
    ? 'sidebar.projects.newFolderPrompt'
    : 'sidebar.projects.newProjectPrompt';
  const actionKey = dialog.kind === 'rename-project'
    ? 'sidebar.projects.save'
    : dialog.kind === 'rename-folder'
      ? 'sidebar.projects.save'
    : 'sidebar.projects.createAction';

  return createPortal(
    <div
      className={styles.projectNameDialogBackdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form className={styles.projectNameDialog} onSubmit={onSubmit}>
        <div className={styles.projectNameDialogTitle}>{t(titleKey)}</div>
        <input
          ref={inputRef}
          className={styles.projectNameInput}
          value={dialog.value}
          placeholder={t(placeholderKey)}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
          }}
        />
        <div className={styles.projectNameDialogActions}>
          <button type="button" onClick={onClose}>{t('sidebar.projects.cancel')}</button>
          <button type="submit" disabled={!dialog.value.trim()}>{t(actionKey)}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function ProjectSessionView({
  view,
  renderSessionItem,
  collapsedProjectIds,
  collapsedFolderIds,
  showAllProjectIds,
  dragState,
  dropTargetId,
  setDropTargetId,
  onToggleProject,
  onToggleFolder,
  onShowAllProject,
  onProjectDragStart,
  onFolderDragStart,
  onDragEnd,
  onDropProject,
  onDropFolder,
  onDropRoot,
  onOpenMenu,
  onCreateProject,
  onCreateProjectSession,
  onOpenProjectMenu,
  onOpenFolderMenu,
}: {
  view: ReturnType<typeof buildSessionProjectView>;
  renderSessionItem: (session: Session) => React.ReactNode;
  collapsedProjectIds: Set<string>;
  collapsedFolderIds: Set<string>;
  showAllProjectIds: Set<string>;
  dragState: SidebarDragState;
  dropTargetId: string | null;
  setDropTargetId: (id: string | null) => void;
  onToggleProject: (projectId: string) => void;
  onToggleFolder: (folderId: string) => void;
  onShowAllProject: (projectId: string) => void;
  onProjectDragStart: (event: React.DragEvent, projectId: string) => void;
  onFolderDragStart: (event: React.DragEvent, folderId: string) => void;
  onDragEnd: () => void;
  onDropProject: (event: React.DragEvent, project: SessionProjectGroup) => void;
  onDropFolder: (event: React.DragEvent, folder: SessionProjectFolderGroup) => void;
  onDropRoot: (event: React.DragEvent) => void;
  onOpenMenu: (position: { x: number; y: number }) => void;
  onCreateProject: () => void;
  onCreateProjectSession: (project: SessionProjectGroup) => void;
  onOpenProjectMenu: (position: { x: number; y: number }, project: SessionProjectGroup) => void;
  onOpenFolderMenu: (position: { x: number; y: number }, folder: SessionProjectFolderGroup) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <section className={styles.pinnedSection}>
        <SectionTitle className={styles.pinnedSectionTitle}>
          <span>{t('sidebar.pinned')}</span>
          <PinIcon />
        </SectionTitle>
        {view.pinned.map(session => renderSessionItem(session))}
      </section>
      <SectionTitle
        actions={(
          <>
            <button
              type="button"
              className={styles.sectionIconButton}
              aria-label={t('sidebar.projects.create')}
              title={t('sidebar.projects.create')}
              onClick={onCreateProject}
            >
              <ProjectPlusIcon />
            </button>
            <button
              type="button"
              className={styles.sectionIconButton}
              aria-label={t('sidebar.view.sort')}
              title={t('sidebar.view.sort')}
              onClick={(event) => onOpenMenu({ x: event.clientX, y: event.clientY })}
            >
              <ListFilterIcon />
            </button>
          </>
        )}
      >
        <span>{t('sidebar.projects.title')}</span>
      </SectionTitle>
      <div
        className={`${styles.projectRootDrop}${dropTargetId === 'root' ? ` ${styles.dropTarget}` : ''}`}
        onDragOver={(event) => {
          if (dragState?.kind !== 'project') return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTargetId('root');
        }}
        onDragLeave={() => setDropTargetId(null)}
        onDrop={onDropRoot}
      >
        {view.rootProjects.map(project => (
          <ProjectBlock
            key={project.id}
            project={project}
            collapsed={collapsedProjectIds.has(project.id)}
            showAll={showAllProjectIds.has(project.id)}
            onToggle={() => onToggleProject(project.id)}
            onShowAll={() => onShowAllProject(project.id)}
            renderSessionItem={renderSessionItem}
            dropTargetId={dropTargetId}
            setDropTargetId={setDropTargetId}
            onProjectDragStart={onProjectDragStart}
            onDragEnd={onDragEnd}
            onDropProject={onDropProject}
            onCreateProjectSession={onCreateProjectSession}
            onOpenProjectMenu={onOpenProjectMenu}
          />
        ))}
        {view.folders.map(folder => (
          <FolderBlock
            key={folder.id}
            folder={folder}
            collapsed={collapsedFolderIds.has(folder.id)}
            collapsedProjectIds={collapsedProjectIds}
            showAllProjectIds={showAllProjectIds}
            onToggle={() => onToggleFolder(folder.id)}
            onToggleProject={onToggleProject}
            onShowAllProject={onShowAllProject}
            renderSessionItem={renderSessionItem}
            dragState={dragState}
            dropTargetId={dropTargetId}
            setDropTargetId={setDropTargetId}
            onProjectDragStart={onProjectDragStart}
            onFolderDragStart={onFolderDragStart}
            onDragEnd={onDragEnd}
            onDropProject={onDropProject}
            onDropFolder={onDropFolder}
            onCreateProjectSession={onCreateProjectSession}
            onOpenProjectMenu={onOpenProjectMenu}
            onOpenFolderMenu={onOpenFolderMenu}
          />
        ))}
      </div>
      {view.rootProjects.length === 0 && view.folders.length === 0 && (
        <div className={styles.sessionEmpty}>{t('sidebar.projects.empty')}</div>
      )}
    </>
  );
}

function ProjectBlock({
  project,
  collapsed,
  showAll,
  onToggle,
  onShowAll,
  renderSessionItem,
  dropTargetId,
  setDropTargetId,
  onProjectDragStart,
  onDragEnd,
  onDropProject,
  onCreateProjectSession,
  onOpenProjectMenu,
}: {
  project: SessionProjectGroup;
  collapsed: boolean;
  showAll: boolean;
  onToggle: () => void;
  onShowAll: () => void;
  renderSessionItem: (session: Session) => React.ReactNode;
  dropTargetId: string | null;
  setDropTargetId: (id: string | null) => void;
  onProjectDragStart: (event: React.DragEvent, projectId: string) => void;
  onDragEnd: () => void;
  onDropProject: (event: React.DragEvent, project: SessionProjectGroup) => void;
  onCreateProjectSession: (project: SessionProjectGroup) => void;
  onOpenProjectMenu: (position: { x: number; y: number }, project: SessionProjectGroup) => void;
}) {
  const visibleItems = collapsed
    ? []
    : showAll
      ? project.items
      : project.items.slice(0, PROJECT_SESSION_PREVIEW_LIMIT);
  const hasMore = !collapsed && !showAll && project.items.length > PROJECT_SESSION_PREVIEW_LIMIT;
  const lastDragEndAtRef = useRef(0);
  const { t } = useI18n();
  return (
    <div className={styles.projectBlock}>
      <div
        className={`${styles.projectRow}${dropTargetId === project.id ? ` ${styles.dropTarget}` : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        draggable
        onClick={() => {
          if (Date.now() - lastDragEndAtRef.current < 250) return;
          onToggle();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onToggle();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenProjectMenu({ x: event.clientX, y: event.clientY }, project);
        }}
        onDragStart={(event) => onProjectDragStart(event, project.id)}
        onDragEnd={() => {
          lastDragEndAtRef.current = Date.now();
          onDragEnd();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTargetId(project.id);
        }}
        onDragLeave={() => setDropTargetId(null)}
        onDrop={(event) => onDropProject(event, project)}
      >
        <FolderIcon />
        <span className={styles.projectName}>{project.name}</span>
        <button
          type="button"
          className={styles.projectNewSessionButton}
          aria-label={t('sidebar.projects.newChatInProject', { name: project.name })}
          title={t('sidebar.projects.newChatInProject', { name: project.name })}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCreateProjectSession(project);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            onCreateProjectSession(project);
          }}
        >
          <NewChatIcon />
        </button>
      </div>
      <div className={styles.projectSessionList}>
        {visibleItems.map(session => renderSessionItem(session))}
        {hasMore && (
          <button type="button" className={styles.projectShowMoreButton} onClick={onShowAll}>
            {t('sidebar.projects.showMore')}
          </button>
        )}
      </div>
    </div>
  );
}

function FolderBlock({
  folder,
  collapsed,
  collapsedProjectIds,
  showAllProjectIds,
  onToggle,
  onToggleProject,
  onShowAllProject,
  renderSessionItem,
  dragState,
  dropTargetId,
  setDropTargetId,
  onProjectDragStart,
  onFolderDragStart,
  onDragEnd,
  onDropProject,
  onDropFolder,
  onCreateProjectSession,
  onOpenProjectMenu,
  onOpenFolderMenu,
}: {
  folder: SessionProjectFolderGroup;
  collapsed: boolean;
  collapsedProjectIds: Set<string>;
  showAllProjectIds: Set<string>;
  onToggle: () => void;
  onToggleProject: (projectId: string) => void;
  onShowAllProject: (projectId: string) => void;
  renderSessionItem: (session: Session) => React.ReactNode;
  dragState: SidebarDragState;
  dropTargetId: string | null;
  setDropTargetId: (id: string | null) => void;
  onProjectDragStart: (event: React.DragEvent, projectId: string) => void;
  onFolderDragStart: (event: React.DragEvent, folderId: string) => void;
  onDragEnd: () => void;
  onDropProject: (event: React.DragEvent, project: SessionProjectGroup) => void;
  onDropFolder: (event: React.DragEvent, folder: SessionProjectFolderGroup) => void;
  onCreateProjectSession: (project: SessionProjectGroup) => void;
  onOpenProjectMenu: (position: { x: number; y: number }, project: SessionProjectGroup) => void;
  onOpenFolderMenu: (position: { x: number; y: number }, folder: SessionProjectFolderGroup) => void;
}) {
  const lastDragEndAtRef = useRef(0);
  return (
    <div className={styles.folderBlock}>
      <div
        className={`${styles.projectRow}${dropTargetId === folder.id ? ` ${styles.dropTarget}` : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        draggable
        onClick={() => {
          if (Date.now() - lastDragEndAtRef.current < 250) return;
          onToggle();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onToggle();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenFolderMenu({ x: event.clientX, y: event.clientY }, folder);
        }}
        onDragStart={(event) => onFolderDragStart(event, folder.id)}
        onDragEnd={() => {
          lastDragEndAtRef.current = Date.now();
          onDragEnd();
        }}
        onDragOver={(event) => {
          if (dragState?.kind === 'session') return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTargetId(folder.id);
        }}
        onDragLeave={() => setDropTargetId(null)}
        onDrop={(event) => onDropFolder(event, folder)}
      >
        <FolderIcon />
        <span className={styles.projectName}>{folder.name}</span>
      </div>
      {!collapsed && (
        <div className={styles.folderProjectList}>
          {folder.projects.map(project => (
            <ProjectBlock
              key={project.id}
              project={project}
              collapsed={collapsedProjectIds.has(project.id)}
              showAll={showAllProjectIds.has(project.id)}
              onToggle={() => onToggleProject(project.id)}
              onShowAll={() => onShowAllProject(project.id)}
              renderSessionItem={renderSessionItem}
              dropTargetId={dropTargetId}
              setDropTargetId={setDropTargetId}
              onProjectDragStart={onProjectDragStart}
              onDragEnd={onDragEnd}
              onDropProject={onDropProject}
              onCreateProjectSession={onCreateProjectSession}
              onOpenProjectMenu={onOpenProjectMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg className={styles.projectIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function ListFilterIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M7 12h10" />
      <path d="M10 17h4" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg className={styles.pinnedTitleIcon} width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path fill="currentColor" d="M15.9894 4.9502L16.52 4.42014V4.42014L15.9894 4.9502ZM19.0716 8.03562L18.541 8.56568L19.0716 8.03562ZM8.73837 19.429L8.20777 19.9591L8.73837 19.429ZM4.62169 15.3081L5.15229 14.7781L4.62169 15.3081ZM17.5669 14.9943L17.3032 14.2922L17.5669 14.9943ZM15.6498 15.7146L15.9136 16.4167H15.9136L15.6498 15.7146ZM8.3322 8.38177L7.62798 8.12375L8.3322 8.38177ZM9.02665 6.48636L9.73087 6.74438V6.74438L9.02665 6.48636ZM5.84504 10.6735L6.04438 11.3965L5.84504 10.6735ZM7.30167 10.1351L6.86346 9.52646L6.86346 9.52646L7.30167 10.1351ZM7.67582 9.79038L8.24665 10.2768H8.24665L7.67582 9.79038ZM14.251 16.3805L14.742 16.9475L14.742 16.9475L14.251 16.3805ZM13.3806 18.2012L12.6574 18.0022V18.0022L13.3806 18.2012ZM13.9169 16.7466L13.3075 16.3094L13.3075 16.3094L13.9169 16.7466ZM2.71846 12.7552L1.96848 12.76L1.96848 12.76L2.71846 12.7552ZM2.93045 11.9521L2.28053 11.5778H2.28053L2.93045 11.9521ZM11.3052 21.3431L11.3064 20.5931H11.3064L11.3052 21.3431ZM12.0933 21.1347L11.7215 20.4833L11.7215 20.4833L12.0933 21.1347ZM11.6973 2.03606L11.8588 2.76845L11.6973 2.03606ZM1.4694 21.4699C1.17666 21.763 1.1769 22.2379 1.46994 22.5306C1.76298 22.8233 2.23786 22.8231 2.5306 22.5301L1.4694 21.4699ZM7.18383 17.8721C7.47657 17.5791 7.47633 17.1042 7.18329 16.8114C6.89024 16.5187 6.41537 16.5189 6.12263 16.812L7.18383 17.8721ZM15.4588 5.48026L18.541 8.56568L19.6022 7.50556L16.52 4.42014L15.4588 5.48026ZM9.26897 18.8989L5.15229 14.7781L4.09109 15.8382L8.20777 19.9591L9.26897 18.8989ZM17.3032 14.2922L15.386 15.0125L15.9136 16.4167L17.8307 15.6964L17.3032 14.2922ZM9.03642 8.63979L9.73087 6.74438L8.32243 6.22834L7.62798 8.12375L9.03642 8.63979ZM6.04438 11.3965C6.75583 11.2003 7.29719 11.0625 7.73987 10.7438L6.86346 9.52646C6.69053 9.65097 6.46601 9.72428 5.6457 9.95044L6.04438 11.3965ZM7.62798 8.12375C7.33502 8.92332 7.24338 9.14153 7.10499 9.30391L8.24665 10.2768C8.60041 9.86175 8.7823 9.33337 9.03642 8.63979L7.62798 8.12375ZM7.73987 10.7438C7.92696 10.6091 8.09712 10.4523 8.24665 10.2768L7.10499 9.30391C7.0337 9.38757 6.9526 9.46229 6.86346 9.52646L7.73987 10.7438ZM15.386 15.0125C14.697 15.2714 14.1716 15.4571 13.76 15.8135L14.742 16.9475C14.9028 16.8082 15.1192 16.7152 15.9136 16.4167L15.386 15.0125ZM14.1037 18.4001C14.329 17.5813 14.4021 17.3569 14.5263 17.1838L13.3075 16.3094C12.9902 16.7517 12.8529 17.2919 12.6574 18.0022L14.1037 18.4001ZM13.76 15.8135C13.5903 15.9605 13.4384 16.1269 13.3075 16.3094L14.5263 17.1838C14.5887 17.0968 14.6611 17.0175 14.742 16.9475L13.76 15.8135ZM5.15229 14.7781C4.50615 14.1313 4.06799 13.691 3.78366 13.3338C3.49835 12.9753 3.46889 12.8201 3.46845 12.7505L1.96848 12.76C1.97215 13.3422 2.26127 13.8297 2.61002 14.2679C2.95976 14.7073 3.47115 15.2176 4.09109 15.8382L5.15229 14.7781ZM5.6457 9.95044C4.80048 10.1835 4.10396 10.3743 3.58296 10.5835C3.06341 10.792 2.57116 11.0732 2.28053 11.5778L3.58038 12.3264C3.615 12.2663 3.71693 12.146 4.1418 11.9755C4.56523 11.8055 5.16337 11.6394 6.04438 11.3965L5.6457 9.95044ZM3.46845 12.7505C3.46751 12.6016 3.50616 12.4553 3.58038 12.3264L2.28053 11.5778C2.07354 11.9372 1.96586 12.3452 1.96848 12.76L3.46845 12.7505ZM8.20777 19.9591C8.83164 20.5836 9.34464 21.0987 9.78647 21.4506C10.227 21.8015 10.7179 22.0922 11.3041 22.0931L11.3064 20.5931C11.2369 20.593 11.0814 20.5644 10.721 20.2773C10.3618 19.9912 9.91923 19.5499 9.26897 18.8989L8.20777 19.9591ZM12.6574 18.0022C12.4133 18.8897 12.2462 19.4924 12.0751 19.9188C11.9033 20.3467 11.7821 20.4487 11.7215 20.4833L12.465 21.7861C12.974 21.4956 13.2573 21.0004 13.4671 20.4775C13.6776 19.9532 13.8694 19.2516 14.1037 18.4001L12.6574 18.0022ZM11.3041 22.0931C11.7112 22.0937 12.1114 21.9879 12.465 21.7861L11.7215 20.4833C11.595 20.5555 11.4519 20.5933 11.3064 20.5931L11.3041 22.0931ZM18.541 8.56568C19.6045 9.63022 20.3403 10.3695 20.7917 10.9788C21.2353 11.5774 21.2863 11.8959 21.2321 12.1464L22.6982 12.4634C22.8881 11.5854 22.5382 10.8162 21.9969 10.0857C21.4635 9.36592 20.6305 8.53486 19.6022 7.50556L18.541 8.56568ZM17.8307 15.6964C19.1921 15.1849 20.294 14.773 21.0771 14.3384C21.8718 13.8973 22.5083 13.3416 22.6982 12.4634L21.2321 12.1464C21.178 12.3968 21.0001 12.6655 20.3491 13.0268C19.6865 13.3946 18.7112 13.7632 17.3032 14.2922L17.8307 15.6964ZM16.52 4.42014C15.4841 3.3832 14.6481 2.54353 13.9246 2.00638C13.1908 1.46165 12.4175 1.10912 11.5357 1.30367L11.8588 2.76845C12.1086 2.71335 12.4277 2.7633 13.0304 3.21075C13.6433 3.66579 14.3876 4.40801 15.4588 5.48026L16.52 4.42014ZM9.73087 6.74438C10.2525 5.32075 10.6161 4.33403 10.9812 3.66315C11.3402 3.00338 11.609 2.82357 11.8588 2.76845L11.5357 1.30367C10.654 1.49819 10.1005 2.14332 9.66362 2.94618C9.23278 3.73793 8.82688 4.85154 8.32243 6.22834L9.73087 6.74438ZM2.5306 22.5301L7.18383 17.8721L6.12263 16.812L1.4694 21.4699L2.5306 22.5301Z" />
    </svg>
  );
}

function ProjectPlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.8" y="4.8" width="14.4" height="14.4" rx="4.2" />
      <path d="M8.8 12h6.4" />
      <path d="M12 8.8v6.4" />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function SessionSearchBox({
  value,
  onChange,
  onClear,
}: {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.sessionSearchBox}>
      <svg className={styles.sessionSearchIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        className={styles.sessionSearchInput}
        value={value}
        placeholder={t('sidebar.searchPlaceholder')}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          className={styles.sessionSearchClear}
          aria-label={t('sidebar.searchClear')}
          onClick={onClear}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

function SessionSearchResults({
  titleResults,
  contentResults,
  status,
  hasResults,
  agents,
  activeSessionPath,
  pendingNewSession,
}: {
  titleResults: SessionSearchResult[];
  contentResults: SessionSearchResult[];
  status: 'idle' | 'title' | 'content' | 'done' | 'error';
  hasResults: boolean;
  agents: Agent[];
  activeSessionPath: string | null;
  pendingNewSession: boolean;
}) {
  const { t } = useI18n();

  if (status === 'error') {
    return <div className={styles.sessionSearchEmpty}>{t('sidebar.searchFailed')}</div>;
  }

  return (
    <>
      {titleResults.length > 0 && (
        <SessionSearchSection
          title={t('sidebar.searchTitleMatches')}
          results={titleResults}
          agents={agents}
          activeSessionPath={activeSessionPath}
          pendingNewSession={pendingNewSession}
        />
      )}
      {status === 'title' && (
        <div className={styles.sessionSearchStatus}>{t('sidebar.searchingTitles')}</div>
      )}
      {(contentResults.length > 0 || status === 'content') && (
        <SessionSearchSection
          title={t('sidebar.searchContentMatches')}
          results={contentResults}
          agents={agents}
          activeSessionPath={activeSessionPath}
          pendingNewSession={pendingNewSession}
          placeholder={status === 'content' && contentResults.length === 0 ? t('sidebar.searchingContent') : null}
        />
      )}
      {status === 'done' && !hasResults && (
        <div className={styles.sessionSearchEmpty}>{t('sidebar.searchNoResults')}</div>
      )}
    </>
  );
}

function SessionSearchSection({
  title,
  results,
  agents,
  activeSessionPath,
  pendingNewSession,
  placeholder = null,
}: {
  title: string;
  results: SessionSearchResult[];
  agents: Agent[];
  activeSessionPath: string | null;
  pendingNewSession: boolean;
  placeholder?: string | null;
}) {
  return (
    <section className={styles.sessionSearchSection}>
      <div className={styles.sessionSearchSectionTitle}>{title}</div>
      {placeholder ? (
        <div className={styles.sessionSearchStatus}>{placeholder}</div>
      ) : results.map(result => (
        <SessionSearchItem
          key={`${result.matchKind}:${result.path}`}
          result={result}
          isActive={!pendingNewSession && result.path === activeSessionPath}
          agents={agents}
        />
      ))}
    </section>
  );
}

const SessionSearchItem = memo(function SessionSearchItem({
  result,
  isActive,
  agents,
}: {
  result: SessionSearchResult;
  isActive: boolean;
  agents: Agent[];
}) {
  const { t } = useI18n();
  const parts: string[] = [];
  if (result.agentName || result.agentId) parts.push(result.agentName || result.agentId!);
  if (result.cwd) {
    const dirName = result.cwd.split(/[/\\]/).filter(Boolean).pop();
    if (dirName) parts.push(dirName);
  }
  if (result.modified) parts.push(formatSessionDate(result.modified));

  const handleClick = useCallback(() => {
    switchSession(result);
  }, [result]);

  return (
    <button
      type="button"
      className={`${styles.sessionSearchItem}${isActive ? ` ${styles.sessionSearchItemActive}` : ''}`}
      data-session-path={result.path}
      onClick={handleClick}
    >
      <span className={styles.sessionItemHeader}>
        {result.agentId && (
          <AgentBadge agentId={result.agentId} agentName={result.agentName} agents={agents} />
        )}
        <span className={styles.sessionItemTitle}>
          {getSessionDisplayTitle(result, t('session.untitled'))}
        </span>
      </span>
      <span className={styles.sessionItemMeta}>{parts.join(' · ')}</span>
      {result.snippet && (
        <span className={styles.sessionSearchSnippet}>{result.snippet}</span>
      )}
    </button>
  );
});

// ── Session Item ──

const SessionItem = memo(function SessionItem({ session: s, isActive, isPending, isStreaming, isPinned, agents, browserState, onCloseBrowser, rowMode, draggable = false, onDragStart, onDragEnd }: {
  session: Session;
  isActive: boolean;
  isPending: boolean;
  isStreaming: boolean;
  isPinned: boolean;
  agents: Agent[];
  browserState: BrowserSessionState | null;
  onCloseBrowser: (sessionPath: string) => void;
  rowMode: SidebarSessionListRowMode;
  draggable?: boolean;
  onDragStart?: (event: React.DragEvent, session: Session) => void;
  onDragEnd?: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [summaryPreviewPosition, setSummaryPreviewPosition] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editDisplayTitle = getSessionDisplayTitle(s, '');

  const handleClick = useCallback(() => {
    if (editing) return;
    switchSession(s);
  }, [s, editing]);

  const handleArchive = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    archiveSession(s.path);
  }, [s.path]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(t('session.deleteConfirm'))) void deleteSession(s.path);
  }, [s.path, t]);

  const handlePin = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    pinSession(s.path, !isPinned);
  }, [s.path, isPinned]);

  const beginRename = useCallback(() => {
    setEditValue(editDisplayTitle);
    setEditing(true);
  }, [editDisplayTitle]);

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    beginRename();
  }, [beginRename]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    setEditing(false);
    if (trimmed && trimmed !== editDisplayTitle) {
      renameSession(s.path, trimmed);
    }
  }, [editDisplayTitle, editValue, s.path]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
    }
  }, [commitRename]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSummaryPreviewPosition(null);
    setMenuPosition({ x: e.clientX, y: e.clientY });
  }, []);

  // Auto-focus input when editing starts
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Meta line
  const rcLabel = s.rcAttachment ? `${formatRcPlatform(s.rcAttachment.platform)} 接管中` : null;
  const displayTitle = getSessionDisplayTitle(s, t('session.untitled'));
  const isSingleLine = rowMode === 'single-line';
  const itemTitle = [displayTitle, rcLabel].filter(Boolean).join(' · ');
  const browserUrl = browserState?.url || null;
  const browserTitle = [
    browserUrl,
    browserState?.unavailableReason,
    t('browser.close'),
  ].filter(Boolean).join('\n');

  const handleBrowserClose = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onCloseBrowser(s.path);
  }, [onCloseBrowser, s.path]);

  const rowClassName = [
    styles.sessionItem,
    isActive ? styles.sessionItemActive : '',
    isPending ? styles.sessionItemPending : '',
    isSingleLine ? styles.sessionItemSingleLine : '',
  ].filter(Boolean).join(' ');
  const shellClassName = [
    styles.sessionItemShell,
    isSingleLine ? styles.sessionItemShellSingleLine : '',
  ].filter(Boolean).join(' ');
  const rowBody = (
    <>
      <span className={styles.sessionItemHeader}>
        {s.agentId && (
          <AgentBadge agentId={s.agentId} agentName={s.agentName} agents={agents} />
        )}
        {(isPending || isStreaming) && (
          <span
            className={styles.sessionStreamingDot}
            data-state={isPending ? 'pending' : 'running'}
          />
        )}
        {editing ? (
          <input
            ref={inputRef}
            className={styles.sessionRenameInput}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={commitRename}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className={styles.sessionItemTitle}>
            {displayTitle}
          </span>
        )}
        {isSingleLine && rcLabel && (
          <span className={styles.sessionRcBadgeInline}>
            {rcLabel}
          </span>
        )}
      </span>

      {/* Conversation rows intentionally show the title only. Connection and
          workspace details remain available from the context menu/tooltips. */}
    </>
  );

  return (
    <>
      <div
        className={shellClassName}
        draggable={draggable && !editing}
        onDragStart={draggable ? (event) => onDragStart?.(event, s) : undefined}
        onDragEnd={draggable ? onDragEnd : undefined}
      >
        {editing ? (
          <div
            className={rowClassName}
            data-session-path={s.path}
            data-row-mode={rowMode}
            data-switch-pending={isPending ? 'true' : 'false'}
            title={itemTitle}
            onContextMenu={handleContextMenu}
          >
            {rowBody}
          </div>
        ) : (
          <button
            type="button"
            className={rowClassName}
            data-session-path={s.path}
            data-row-mode={rowMode}
            data-switch-pending={isPending ? 'true' : 'false'}
            title={itemTitle}
            onClick={handleClick}
            onContextMenu={handleContextMenu}
          >
            {rowBody}
          </button>
        )}

        {!editing && (
          <div className={styles.sessionItemActions} data-session-actions="">
            <button
              type="button"
              className={styles.sessionPinBtn}
              title={t(isPinned ? 'session.unpin' : 'session.pin')}
              aria-label={t(isPinned ? 'session.unpin' : 'session.pin')}
              onClick={handlePin}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 17v5" />
                <path d="M5 17h14" />
                <path d="M7 3h10l-2 9H9L7 3z" />
                <path d="M9 12l-2 5h10l-2-5" />
              </svg>
            </button>
            <button
              type="button"
              className={styles.sessionRenameBtn}
              title={t('session.rename')}
              aria-label={t('session.rename')}
              onClick={startRename}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              </svg>
            </button>
            <button
              type="button"
              className={styles.sessionArchiveBtn}
              title={t('session.archive')}
              aria-label={t('session.archive')}
              onClick={handleArchive}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="21 8 21 21 3 21 3 8" />
                <rect x="1" y="3" width="22" height="5" />
                <line x1="10" y1="12" x2="14" y2="12" />
              </svg>
            </button>
            <button
              type="button"
              className={styles.sessionDeleteBtn}
              title={t('session.delete')}
              aria-label={t('session.delete')}
              onClick={handleDelete}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" />
                <path d="M8 6V4h8v2" />
                <path d="M19 6l-1 14H6L5 6" />
                <path d="M10 11v5" />
                <path d="M14 11v5" />
              </svg>
            </button>
          </div>
        )}

        {browserUrl && (
          <button
            type="button"
            className={styles.sessionBrowserBadge}
            title={browserTitle}
            aria-label={t('browser.close')}
            data-running={browserState?.running ? 'true' : 'false'}
            data-resumable={browserState?.resumable ? 'true' : 'false'}
            onClick={handleBrowserClose}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          </button>
        )}
      </div>
      {menuPosition && (
        <SessionContextMenu
          session={s}
          isPinned={isPinned}
          position={menuPosition}
          onClose={() => setMenuPosition(null)}
          onRename={beginRename}
          onShowSummary={(position) => setSummaryPreviewPosition(position)}
        />
      )}
      {summaryPreviewPosition && (
        <SessionSummaryPreviewCard
          session={s}
          position={summaryPreviewPosition}
          onClose={() => setSummaryPreviewPosition(null)}
        />
      )}
    </>
  );
});

interface SessionSummaryResponse {
  hasSummary?: boolean;
  summary?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

type SummaryState =
  | { status: 'loading'; text: null }
  | { status: 'ready'; text: string }
  | { status: 'empty'; text: null }
  | { status: 'error'; text: null };

const SessionContextMenu = memo(function SessionContextMenu({
  session,
  isPinned,
  position,
  onClose,
  onRename,
  onShowSummary,
}: {
  session: Session;
  isPinned: boolean;
  position: { x: number; y: number };
  onClose: () => void;
  onRename: () => void;
  onShowSummary: (position: { x: number; y: number }) => void;
}) {
  const { t } = useI18n();
  const items = useMemo<ContextMenuItem[]>(() => [
    {
      label: t('session.summary.open'),
      disabled: session.hasSummary !== true,
      action: () => onShowSummary(position),
    },
    {
      label: t(isPinned ? 'session.unpin' : 'session.pin'),
      action: () => pinSession(session.path, !isPinned),
    },
    {
      label: t('session.rename'),
      action: onRename,
    },
    {
      label: t('session.archive'),
      danger: true,
      action: () => archiveSession(session.path),
    },
    {
      label: t('session.delete'),
      danger: true,
      action: () => {
        if (window.confirm(t('session.deleteConfirm'))) void deleteSession(session.path);
      },
    },
  ], [isPinned, onRename, onShowSummary, position, session.hasSummary, session.path, t]);

  return (
    <ContextMenu
      items={items}
      position={position}
      onClose={onClose}
    />
  );
});

const SessionSummaryPreviewCard = memo(function SessionSummaryPreviewCard({
  session,
  position,
  onClose,
}: {
  session: Session;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const cardRef = useRef<HTMLDivElement>(null);
  const [summaryState, setSummaryState] = useState<SummaryState>(
    session.hasSummary === true
      ? { status: 'loading', text: null }
      : { status: 'empty', text: null },
  );

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    let { x, y } = position;
    if (x + rect.width > window.innerWidth) x = Math.max(4, window.innerWidth - rect.width - 4);
    if (y + rect.height > window.innerHeight) y = Math.max(4, window.innerHeight - rect.height - 4);
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }, [position, summaryState]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (cardRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const handleContextMenu = (e: MouseEvent) => {
      if (cardRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClick, true);
      document.addEventListener('contextmenu', handleContextMenu, true);
      document.addEventListener('keydown', handleKeyDown);
    });
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('contextmenu', handleContextMenu, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (session.hasSummary !== true) {
      setSummaryState({ status: 'empty', text: null });
      return;
    }

    let cancelled = false;
    setSummaryState({ status: 'loading', text: null });
    gsapFetch(`/api/sessions/summary?path=${encodeURIComponent(session.path)}`)
      .then(res => res.json())
      .then((data: SessionSummaryResponse) => {
        if (cancelled) return;
        const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
        if (data.hasSummary && summary) {
          setSummaryState({ status: 'ready', text: summary });
        } else {
          setSummaryState({ status: 'empty', text: null });
        }
      })
      .catch(() => {
        if (!cancelled) setSummaryState({ status: 'error', text: null });
      });

    return () => {
      cancelled = true;
    };
  }, [session.path, session.hasSummary]);

  return createPortal(
    <div
      ref={cardRef}
      className={styles.sessionSummaryCard}
      style={{ left: position.x, top: position.y }}
      data-testid="session-summary-card"
      data-scrollable="true"
    >
      <div className={styles.sessionSummaryTitle}>{t('session.summary.title')}</div>
      <div className={styles.sessionSummaryBody}>
        {summaryState.status === 'ready' ? (
          <div dangerouslySetInnerHTML={{ __html: renderMarkdown(summaryState.text) }} />
        ) : (
          <span className={styles.sessionSummaryPlaceholder}>
            {summaryState.status === 'loading'
              ? t('session.summary.loading')
              : summaryState.status === 'error'
                ? t('session.summary.loadFailed')
                : t('session.summary.empty')}
          </span>
        )}
      </div>
    </div>,
    document.body,
  );
});

function formatRcPlatform(platform: string) {
  const lower = (platform || '').toLowerCase();
  if (lower === 'tg' || lower === 'telegram') return 'Telegram';
  if (lower === 'feishu' || lower === 'fs') return '椋炰功';
  if (lower === 'wechat' || lower === 'wx') return '微信';
  if (lower === 'qq') return 'QQ';
  return platform || 'Bridge';
}

// ── Agent Avatar Badge ──

const AgentBadge = memo(function AgentBadge({ agentId, agentName, agents }: {
  agentId: string;
  agentName: string | null;
  agents: Agent[];
}) {
  const info = resolveAgentDisplayInfo({
    id: agentId,
    agents,
    fallbackAgentName: agentName || agentId,
  });

  return (
    <AgentAvatar
      info={info}
      className={styles.sessionAgentBadge}
      title={agentName || agentId}
    />
  );
});
