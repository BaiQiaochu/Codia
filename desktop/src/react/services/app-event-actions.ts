import { useStore } from '../stores';
import { codiaFetch } from '../hooks/use-codia-fetch';
import { applyAgentIdentity, loadAgents } from '../stores/agent-actions';
import { loadSessions } from '../stores/session-actions';
import { loadModels } from '../utils/ui-helpers';
import { activateWorkspaceDesk } from '../stores/desk-actions';
import { loadChannels } from '../stores/channel-actions';
import { applyChatLayout } from '../chat/layout';
import { applyEditorTypography } from '../editor/typography';
import { mergeWorkspaceHistory } from '../../../../shared/workspace-history.ts';
import {
  PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
  refreshPreviewDocumentTarget,
} from '../utils/preview-document-refresh';
import { isRemoteWorkbenchContentRef } from '../utils/remote-file-preview';

declare const i18n: {
  locale: string;
  defaultName: string;
  load(locale: string): Promise<void>;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- app events cross IPC/WS boundaries */

let agentSwitchVersion = 0;
let requestContextUsage: (sessionPath: string) => void = () => {};

interface AppEventOptions {
  source?: string;
}

export function configureAppEventActions(options: {
  requestContextUsage?: (sessionPath: string) => void;
}): void {
  requestContextUsage = options.requestContextUsage || (() => {});
}

function normalizeWorkspacePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function readConfigHomeFolder(config: any): string | null {
  return normalizeWorkspacePath(config?.desk?.home_folder ?? config?.deskHome);
}

export function readConfigCwdHistory(config: any): string[] {
  const history = Array.isArray(config?.cwd_history)
    ? config.cwd_history
    : Array.isArray(config?.cwdHistory)
      ? config.cwdHistory
      : [];
  return mergeWorkspaceHistory(history, []);
}

export function readConfigMemoryMasterEnabled(config: any): boolean {
  return config?.memory?.enabled !== false;
}

function handleAgentWorkspaceChanged(data: any): void {
  const state = useStore.getState();
  if (!data?.agentId || data.agentId !== state.currentAgentId) return;

  const previousHomeFolder = state.homeFolder || null;
  const previousSelectedFolder = state.selectedFolder || null;
  const nextHomeFolder = normalizeWorkspacePath(data.homeFolder);
  const selectedFollowedDefault = !previousSelectedFolder || previousSelectedFolder === previousHomeFolder;
  const nextSelectedFolder = selectedFollowedDefault ? nextHomeFolder : previousSelectedFolder;
  const nextCwdHistory = Array.isArray(data.cwdHistory)
    ? mergeWorkspaceHistory(data.cwdHistory, [])
    : state.cwdHistory;
  const deskWasShowingDefault =
    state.pendingNewSession
    || !state.currentSessionPath
    || !state.deskBasePath
    || (!!previousHomeFolder && state.deskBasePath === previousHomeFolder);

  useStore.setState({
    homeFolder: nextHomeFolder,
    selectedFolder: nextSelectedFolder,
    workspaceFolders: [],
    cwdHistory: nextCwdHistory,
  });

  if (deskWasShowingDefault) {
    void activateWorkspaceDesk(nextHomeFolder);
  }
}

export function handleAppEvent(type: string, data: any = {}, options: AppEventOptions = {}): void {
  switch (type) {
    case 'agent-switched': {
      const myVersion = ++agentSwitchVersion;

      applyAgentIdentity({
        agentName: data.agentName,
        agentId: data.agentId,
      });
      if (typeof data.memoryMasterEnabled === 'boolean') {
        useStore.setState({ memoryMasterEnabled: data.memoryMasterEnabled });
      }
      loadSessions();
      window.__loadDeskSkills?.();

      useStore.setState({
        currentChannel: null,
        channelMessages: [],
        channelMembers: [],
        channelMemberRoles: {},
        channelTotalUnread: 0,
        channelHeaderName: '',
        channelHeaderMembersText: '',
        channelInfoName: '',
        channelInfoDescription: '',
        channelIsDM: false,
      });
      loadChannels();

      loadModels();
      useStore.setState({ thinkingLevel: 'auto' });

      codiaFetch('/api/config').then((response) => response.json()).then((config: any) => {
        if (myVersion !== agentSwitchVersion) return;
        const homeFolder = readConfigHomeFolder(config);
        const memoryPatch = config?.memory && typeof config.memory === 'object'
          ? { memoryMasterEnabled: readConfigMemoryMasterEnabled(config) }
          : {};
        useStore.setState({
          homeFolder,
          selectedFolder: homeFolder,
          workspaceFolders: [],
          cwdHistory: readConfigCwdHistory(config),
          ...memoryPatch,
        });
        void activateWorkspaceDesk(homeFolder);
      }).catch(() => {});

      codiaFetch('/api/desk/cron').then((response) => response.json()).then((payload: any) => {
        if (myVersion !== agentSwitchVersion) return;
        useStore.setState({ automationCount: payload.jobs?.length || 0 });
      }).catch(() => {});
      useStore.setState({ activities: [] });
      break;
    }
    case 'skills-changed':
      window.__loadDeskSkills?.();
      window.dispatchEvent(new CustomEvent('codia-skills-changed', {
        detail: { agentId: data?.agentId || null },
      }));
      break;
    case 'locale-changed':
      i18n.load(data.locale).then(() => {
        i18n.defaultName = useStore.getState().agentName;
        useStore.setState({ locale: i18n.locale });
      });
      break;
    case 'models-changed': {
      loadModels();
      const sessionPath = useStore.getState().currentSessionPath;
      if (sessionPath) {
        requestContextUsage(sessionPath);
      }
      break;
    }
    case 'model-metadata-changed':
      loadModels();
      break;
    case 'agent-created':
    case 'agent-deleted':
      loadAgents();
      break;
    case 'agent-updated': {
      const currentAgentId = useStore.getState().currentAgentId;
      if (data.agentId && data.agentId !== currentAgentId) {
        loadAgents();
        break;
      }
      applyAgentIdentity({
        agentName: data.agentName,
        agentId: data.agentId,
        yuan: data.yuan,
        ui: { settings: false },
      });
      break;
    }
    case 'memory-master-changed': {
      const state = useStore.getState();
      if (!data.agentId) break;
      const enabled = data.enabled !== false;
      const patch: any = {};
      if (Array.isArray(state.agents)) {
        patch.agents = state.agents.map((agent: any) =>
          agent.id === data.agentId ? { ...agent, memoryMasterEnabled: enabled } : agent,
        );
      }
      if (data.agentId === state.currentAgentId) {
        patch.memoryMasterEnabled = enabled;
      }
      if (Object.keys(patch).length > 0) {
        useStore.setState(patch);
      }
      break;
    }
    case 'agent-workspace-changed':
      handleAgentWorkspaceChanged(data);
      break;
    case 'theme-changed':
      window.setTheme(data.theme);
      break;
    case 'editor-typography-changed':
      applyEditorTypography(data.editor ?? data);
      break;
    case 'chat-layout-changed':
      applyChatLayout(data.chat ?? data);
      break;
    case 'markdown-cover-updated':
      if (typeof data?.filePath === 'string' && data.filePath) {
        void refreshPreviewDocumentTarget(
          { kind: 'local-file', filePath: data.filePath },
          PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
        );
      } else if (isRemoteWorkbenchContentRef(data?.target)) {
        void refreshPreviewDocumentTarget(
          { kind: 'workbench-file', target: data.target },
          PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
        );
      }
      break;
    case 'session-file-updated':
      if (typeof data?.filePath === 'string' && data.filePath) {
        void refreshPreviewDocumentTarget(
          { kind: 'local-file', filePath: data.filePath },
          PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
        );
      }
      break;
    case 'network-proxy-changed':
      if (options.source === 'server') {
        window.platform?.settingsChanged?.('network-proxy-changed', data);
      }
      break;
    case 'paper-texture-changed':
      window.setPaperTexture(data.enabled);
      break;
    case 'leaves-overlay-changed':
      window.dispatchEvent(new CustomEvent('codia-settings', {
        detail: { type: 'leaves-overlay-changed', enabled: data.enabled },
      }));
      break;
  }
}
