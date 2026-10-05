import { create } from 'zustand';
import { createConnectionSlice, type ConnectionSlice } from './connection-slice';
import { createSessionSlice, type SessionSlice } from './session-slice';
import { sessionScopedKey } from './session-slice';
import { configureMessageLiveVersionSessionKeyResolver } from './message-live-version';
import { createSessionProjectSlice, type SessionProjectSlice } from './session-project-slice';
import { createStreamingSlice, type StreamingSlice } from './streaming-slice';
import { createUiSlice, type UiSlice } from './ui-slice';
import { createAgentSlice, type AgentSlice } from './agent-slice';
import { createChannelSlice, type ChannelSlice } from './channel-slice';
import { createDeskSlice, type DeskSlice } from './desk-slice';
import { createModelSlice, type ModelSlice } from './model-slice';
import { createInputSlice, type InputSlice } from './input-slice';
import { createChatSlice, type ChatSlice } from './chat-slice';
import { createToastSlice, type ToastSlice } from './toast-slice';
import { createArtifactSlice, type ArtifactSlice } from './preview-slice';
import { createBrowserSlice, type BrowserSlice } from './browser-slice';
import { createContextSlice, type ContextSlice } from './context-slice';
import { createAutomationSlice, type AutomationSlice } from './automation-slice';
import { createActivitySlice, type ActivitySlice } from './activity-slice';
import { createAgentActivitySlice, type AgentActivitySlice } from './agent-activity-slice';
import { createBridgeSlice, type BridgeSlice } from './bridge-slice';
import { createPluginUiSlice, type PluginUiSlice } from './plugin-ui-slice';
import { createSelectionSlice, type SelectionSlice } from './selection-slice';
import { createSubagentPreviewSlice, type SubagentPreviewSlice } from './subagent-preview-slice';
import { createComputerOverlaySlice, type ComputerOverlaySlice } from './computer-overlay-slice';
import { createScreenshotSlice, type ScreenshotSlice } from './screenshot-slice';
import { createRuntimeTimelineSlice, type RuntimeTimelineSlice } from './runtime-timeline-slice';

export type StoreState = ConnectionSlice &
  SessionSlice &
  SessionProjectSlice &
  StreamingSlice &
  UiSlice &
  AgentSlice &
  ChannelSlice &
  DeskSlice &
  ModelSlice &
  InputSlice &
  ChatSlice &
  ToastSlice &
  ArtifactSlice &
  BrowserSlice &
  ContextSlice &
  AutomationSlice &
  ActivitySlice &
  AgentActivitySlice &
  BridgeSlice &
  PluginUiSlice &
  SelectionSlice &
  SubagentPreviewSlice &
  ComputerOverlaySlice &
  ScreenshotSlice &
  RuntimeTimelineSlice;

export const useStore = create<StoreState>()((set, _get, _api) => ({
  ...createConnectionSlice(set, _get),
  ...createSessionSlice(set),
  ...createSessionProjectSlice(set),
  ...createStreamingSlice(set, _get),
  ...createUiSlice(set),
  ...createAgentSlice(set),
  ...createChannelSlice(set),
  ...createDeskSlice(set, _get),
  ...createModelSlice(set),
  ...createInputSlice(set),
  ...createChatSlice(set, _get),
  ...createToastSlice(set, _get),
  ...createArtifactSlice(set),
  ...createBrowserSlice(set),
  ...createContextSlice(set),
  ...createAutomationSlice(set),
  ...createActivitySlice(set),
  ...createAgentActivitySlice(set),
  ...createBridgeSlice(set),
  ...createPluginUiSlice(set),
  ...createSelectionSlice(set),
  ...createSubagentPreviewSlice(set),
  ...createComputerOverlaySlice(set),
  ...createScreenshotSlice(set),
  ...createRuntimeTimelineSlice(set, _get),
}));

configureMessageLiveVersionSessionKeyResolver((sessionPath) => (
  sessionScopedKey(useStore.getState(), sessionPath)
));

// Re-export slice types
export type {
  ConnectionSlice,
  SessionSlice,
  SessionProjectSlice,
  StreamingSlice,
  UiSlice,
  AgentSlice,
  ChannelSlice,
  DeskSlice,
  ModelSlice,
  InputSlice,
  ChatSlice,
  ToastSlice,
  ArtifactSlice,
  BrowserSlice,
  ContextSlice,
  AutomationSlice,
  ActivitySlice,
  AgentActivitySlice,
  BridgeSlice,
  PluginUiSlice,
  SelectionSlice,
  SubagentPreviewSlice,
  ComputerOverlaySlice,
  ScreenshotSlice,
  RuntimeTimelineSlice,
};
