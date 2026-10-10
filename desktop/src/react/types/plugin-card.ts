export interface PluginCardSessionRef {
  sessionId: string;
  sessionPath?: string | null;
  path?: string | null;
  legacySessionPath?: string | null;
}

export interface PluginCardDetails {
  type: string;
  pluginId: string;
  route?: string;
  title?: string;
  description: string;
  aspectRatio?: string;
  sessionId?: string | null;
  sessionRef?: PluginCardSessionRef | null;
  sessionPath?: string | null;
  mode?: 'transcript' | 'full' | string;
  composer?: boolean;
  unavailableReason?: string;
}
