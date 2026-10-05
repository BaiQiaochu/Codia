export type TranslationVars = Record<string, string | number>;

export interface ErrorPayload {
  error?: string;
}

export interface ModelDescriptor {
  id: string;
  provider?: string;
  [key: string]: unknown;
}

export type ProviderModelEntry = string | ModelDescriptor;

export interface ProviderConfigLike {
  models?: ProviderModelEntry[];
  [key: string]: unknown;
}

export interface LegacyModelOverride {
  displayName?: string;
  [key: string]: unknown;
}

export interface ModelMetaPayload {
  displayName?: string;
  name?: string;
  type?: 'chat' | 'image' | 'audio' | 'music' | 'video' | string;
  context?: number | null;
  maxOutput?: number | null;
  image?: boolean;
  vision?: boolean;
  video?: boolean;
  reasoning?: boolean;
  [key: string]: unknown;
}

export interface EditorMarkdownTypographyPayload {
  fontPreset?: 'follow' | 'serif' | 'sans';
  bodyFontSize?: number;
  heading1FontSize?: number;
  heading2FontSize?: number;
  heading3FontSize?: number;
  heading4FontSize?: number;
  heading5FontSize?: number;
  heading6FontSize?: number;
  lineHeight?: number;
  contentPadding?: number;
}

export interface EditorTypographyPayload {
  markdown?: EditorMarkdownTypographyPayload;
}

export interface SettingsConfigPayload extends Record<string, unknown> {
  providers?: Record<string, ProviderConfigLike>;
  agent?: {
    name?: string;
    yuan?: string;
    [key: string]: unknown;
  };
  user?: {
    name?: string;
    [key: string]: unknown;
  };
  desk?: {
    home_folder?: string | null;
    heartbeat_master?: boolean;
    cron_auto_approve?: boolean;
    heartbeat_enabled?: boolean;
    heartbeat_interval?: number;
    [key: string]: unknown;
  };
  workspace_context?: {
    inject_agents_md?: boolean;
    inject_claude_md?: boolean;
    [key: string]: unknown;
  };
  channels?: {
    enabled?: boolean;
    [key: string]: unknown;
  };
  models?: {
    chat?: string | ModelDescriptor;
    overrides?: Record<string, LegacyModelOverride>;
    [key: string]: unknown;
  };
  memory?: {
    enabled?: boolean;
    [key: string]: unknown;
  };
  experience?: {
    enabled?: boolean;
    [key: string]: unknown;
  };
  tools?: {
    disabled?: string[];
    [key: string]: unknown;
  };
  availableTools?: string[];
  capabilities?: {
    learn_skills?: {
      enabled?: boolean;
      safety_review?: boolean;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  file_backup?: {
    enabled?: boolean;
    retention_days?: number;
    max_file_size_kb?: number;
    [key: string]: unknown;
  };
  network_proxy?: {
    mode?: 'system' | 'manual' | 'direct';
    httpProxy?: string;
    httpsProxy?: string;
    wsProxy?: string;
    wssProxy?: string;
    noProxy?: string;
    [key: string]: unknown;
  };
  sandbox?: boolean;
  sandbox_network?: boolean;
  keep_awake?: boolean;
  update_channel?: string;
  auto_check_updates?: boolean;
  locale?: string;
  timezone?: string;
  editor?: EditorTypographyPayload;
  _identity?: string;
  _ishiki?: string;
  _publicIshiki?: string;
  _userProfile?: string;
  _experience?: string;
}

export interface GlobalModelsPayload extends Record<string, unknown> {
  models?: {
    utility?: string | ModelDescriptor;
    utility_large?: string | ModelDescriptor;
    [key: string]: unknown;
  };
  search?: {
    provider?: string;
    api_key?: string;
    [key: string]: unknown;
  };
  utility_api?: {
    provider?: string;
    base_url?: string;
    api_key?: string;
    [key: string]: unknown;
  };
}

export interface TextContentPayload extends ErrorPayload {
  content?: string;
}

export interface PinsPayload extends ErrorPayload {
  pins?: string[];
}

export interface HealthPayload extends ErrorPayload {
  avatars?: Partial<Record<'agent' | 'user', boolean>>;
}

export interface PluginSettingsPayload extends ErrorPayload {
  allow_full_access?: boolean;
  plugin_dev_tools_enabled?: boolean;
  plugins_dir?: string;
}

export interface AgentSwitchPayload extends ErrorPayload {
  ok?: boolean;
  agent?: {
    id: string;
    name: string;
  };
}

export interface ImageProviderDefaults {
  size?: string;
  aspect_ratio?: string;
  format?: string;
  quality?: string;
  audioFormat?: string;
  audioResponseFormat?: string;
  musicFormat?: string;
  musicResponseFormat?: string;
  videoDuration?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  baseUrl?: string;
  mediaBaseUrl?: string;
  workflow?: string;
  workflowPath?: string;
  voice_id?: string;
  [key: string]: unknown;
}

export interface ImageGenConfigPayload {
  defaultImageModel?: { id: string; provider: string } | null;
  defaultAudioModel?: { id: string; provider: string } | null;
  defaultMusicModel?: { id: string; provider: string } | null;
  defaultVideoModel?: { id: string; provider: string } | null;
  providerDefaults?: Record<string, ImageProviderDefaults>;
}

export function isModelDescriptor(value: unknown): value is ModelDescriptor {
  return !!value
    && typeof value === 'object'
    && 'id' in value
    && typeof (value as { id?: unknown }).id === 'string';
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
