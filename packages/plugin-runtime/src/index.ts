export type MaybePromise<T> = T | Promise<T>;

export type JsonSchema = Record<string, unknown>;

export const GSAP_BUS_SKIP = Symbol.for('gsap.event-bus.skip');

export interface GsapToolResult {
  content?: Array<Record<string, unknown>>;
  details?: Record<string, unknown>;
}

export interface GsapSessionRef {
  sessionId: string;
  sessionPath?: string | null;
  legacySessionPath?: string | null;
}

export type GsapSessionTarget = string | GsapSessionRef | {
  sessionId?: string | null;
  sessionPath?: string | null;
  path?: string | null;
  legacySessionPath?: string | null;
};

export interface GsapSessionFile {
  id?: string | null;
  fileId?: string | null;
  sessionId?: string | null;
  sessionPath?: string | null;
  filePath?: string;
  realPath?: string;
  displayName?: string;
  filename?: string;
  label?: string;
  ext?: string | null;
  mime?: string;
  size?: number;
  kind?: string;
  isDirectory?: boolean;
  origin?: string;
  operations?: unknown[];
  createdAt?: number | string;
  storageKind?: string;
  status?: string;
  missingAt?: number | string | null;
  resource?: GsapResourceEnvelope;
  [key: string]: unknown;
}

export interface GsapResourceEnvelope {
  schemaVersion: 1;
  resourceId: string;
  name: string;
  studioId: string;
  type: 'file' | string;
  source: 'session_file' | string;
  sourceId?: string;
  fileId?: string;
  displayName?: string;
  filename?: string;
  ext?: string | null;
  mime?: string;
  size?: number | null;
  kind?: string;
  isDirectory?: boolean;
  origin?: string;
  operations?: string[];
  createdAt?: number | string;
  mtimeMs?: number;
  lifecycle: {
    status: string;
    missingAt: number | string | null;
  };
  storage: {
    provider: string;
    storageKind?: string;
    localOnly?: boolean;
  };
  links: {
    self: string;
    content?: string;
  };
  [key: string]: unknown;
}

export type GsapResourceRef =
  | { kind: 'local-file'; path: string }
  | { kind: 'mount'; mountId: string; path: string }
  | { kind: 'session-file'; fileId: string; sessionId?: string; sessionPath?: string }
  | { kind: 'resource'; resourceId: string }
  | { kind: 'url'; url: string };

export interface GsapResourceVersion {
  mtimeMs?: number;
  size?: number | null;
  sha256?: string;
  etag?: string;
  sequence?: number;
}

export type GsapResourceDescriptor = GsapResourceRef & {
  provider?: string;
  filePath?: string;
  displayName?: string;
};

export interface GsapResourceStat {
  resourceKey: string;
  resource: GsapResourceDescriptor;
  exists: boolean;
  isDirectory: boolean;
  version?: GsapResourceVersion;
  filePath?: string;
}

export interface GsapResourceReadResult {
  resourceKey: string;
  resource: GsapResourceDescriptor;
  content: Uint8Array;
  version?: GsapResourceVersion;
  filePath?: string;
}

export interface GsapResourceMutationResult {
  changeType: 'created' | 'modified';
  resourceKey: string;
  resource: GsapResourceDescriptor;
  version?: GsapResourceVersion;
  filePath?: string;
}

export interface GsapResourceWriteConflictResult {
  ok: false;
  conflict: true;
  resourceKey: string;
  resource: GsapResourceDescriptor;
  version?: GsapResourceVersion;
  filePath?: string;
}

export type GsapResourceWriteExpectedVersionResult =
  | GsapResourceMutationResult
  | GsapResourceWriteConflictResult;

export interface GsapResourceMoveResult {
  oldResourceKey: string;
  newResourceKey: string;
  oldResource: GsapResourceDescriptor;
  newResource: GsapResourceDescriptor;
  oldFilePath?: string;
  newFilePath?: string;
}

export interface GsapResourceTrashOptions {
  namespace?: string;
  metadata?: Record<string, unknown>;
}

export interface GsapResourceTrashResult {
  resourceKey: string;
  resource: GsapResourceDescriptor;
  trashId: string;
  trashPath?: string;
  payloadPath?: string;
  filePath?: string;
}

export interface GsapResourceEdit {
  oldText: string;
  newText: string;
}

export interface GsapResourceListItem {
  name: string;
  isDirectory: boolean;
  size: number | null;
  mtimeMs: number;
}

export interface GsapResourceListResult {
  resourceKey: string;
  resource: GsapResourceDescriptor;
  items: GsapResourceListItem[];
}

export interface GsapResourceSearchOptions {
  query?: string;
  [key: string]: unknown;
}

export interface GsapResourceSearchMatch {
  filePath: string;
  line: number;
  text: string;
  name?: string;
  relativePath?: string;
  parentSubdir?: string;
  isDirectory?: boolean;
  size?: number | null;
  mtimeMs?: number;
}

export interface GsapResourceSearchResult {
  resourceKey: string;
  resource: GsapResourceDescriptor;
  matches: GsapResourceSearchMatch[];
}

export interface GsapResourceMaterializeResult {
  resourceKey: string;
  resource: GsapResourceDescriptor;
  filePath: string;
  version?: GsapResourceVersion;
}

export interface GsapResourceWatchTarget {
  ref?: GsapResourceRef;
  filePath: string;
  isDirectory?: boolean;
  resourceKey: string;
  resource: GsapResourceDescriptor;
}

export interface GsapPluginResourceMutationOptions {
  emit?: boolean;
}

export interface GsapPluginResources {
  stat(ref: GsapResourceRef | Record<string, unknown>): Promise<GsapResourceStat>;
  read(ref: GsapResourceRef | Record<string, unknown>): Promise<GsapResourceReadResult>;
  list(ref: GsapResourceRef | Record<string, unknown>): Promise<GsapResourceListResult>;
  search(ref: GsapResourceRef | Record<string, unknown>, options?: GsapResourceSearchOptions): Promise<GsapResourceSearchResult>;
  materialize(ref: GsapResourceRef | Record<string, unknown>): Promise<GsapResourceMaterializeResult>;
  write(ref: GsapResourceRef | Record<string, unknown>, content: string | Uint8Array | ArrayBuffer, options?: GsapPluginResourceMutationOptions): Promise<GsapResourceMutationResult>;
  writeExpectedVersion(ref: GsapResourceRef | Record<string, unknown>, content: string | Uint8Array | ArrayBuffer, expectedVersion: GsapResourceVersion, options?: GsapPluginResourceMutationOptions): Promise<GsapResourceWriteExpectedVersionResult>;
  edit(ref: GsapResourceRef | Record<string, unknown>, edits: GsapResourceEdit[], options?: GsapPluginResourceMutationOptions): Promise<GsapResourceMutationResult>;
  mkdir(ref: GsapResourceRef | Record<string, unknown>, options?: GsapPluginResourceMutationOptions): Promise<GsapResourceMutationResult>;
  delete(ref: GsapResourceRef | Record<string, unknown>, options?: GsapPluginResourceMutationOptions): Promise<GsapResourceMutationResult>;
  copy(from: GsapResourceRef | Record<string, unknown>, to: GsapResourceRef | Record<string, unknown>, options?: GsapPluginResourceMutationOptions): Promise<GsapResourceMutationResult>;
  rename(from: GsapResourceRef | Record<string, unknown>, to: GsapResourceRef | Record<string, unknown>, options?: GsapPluginResourceMutationOptions): Promise<GsapResourceMoveResult>;
  move(from: GsapResourceRef | Record<string, unknown>, to: GsapResourceRef | Record<string, unknown>, options?: GsapPluginResourceMutationOptions): Promise<GsapResourceMoveResult>;
  trash(ref: GsapResourceRef | Record<string, unknown>, trashOptions?: GsapResourceTrashOptions, options?: GsapPluginResourceMutationOptions): Promise<GsapResourceTrashResult>;
  resolveWatchTarget?(ref: GsapResourceRef | Record<string, unknown>): GsapResourceWatchTarget;
}

export interface GsapExecutionBoundary {
  schemaVersion: 1;
  boundaryId: string;
  kind: 'local_process' | string;
  serverNodeId: string;
  studioId: string;
  workbench?: {
    kind: string;
    root: string | null;
    [key: string]: unknown;
  };
  sandbox?: {
    kind: string;
    enforcedBy?: string;
    [key: string]: unknown;
  };
  filesystem?: {
    policy: string;
    [key: string]: unknown;
  };
  network?: {
    policy: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GsapPluginNetworkFetchInit extends RequestInit {
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxResponseBytes?: number;
}

export interface GsapPluginNetwork {
  fetch(input: string | URL | Request, init?: GsapPluginNetworkFetchInit): Promise<Response>;
}

export interface GsapSessionFileMediaItem {
  type: 'session_file';
  fileId: string;
  sessionId?: string | null;
  sessionPath?: string | null;
  filePath?: string;
  label?: string;
  mime?: string;
  size?: number;
  kind?: string;
  [key: string]: unknown;
}

export interface GsapStagedSessionFile {
  file?: GsapSessionFile | null;
  sessionFile?: GsapSessionFile | null;
  mediaItem: GsapSessionFileMediaItem;
}

export interface GsapMediaDetails {
  media: {
    items: GsapSessionFileMediaItem[];
  };
}

export interface GsapToolContext {
  serverId: string;
  serverNodeId?: string;
  userId: string;
  studioId: string;
  connectionKind?: 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud' | string;
  credentialKind?: 'none' | 'loopback_token' | 'device_credential' | 'user_session' | string;
  platformAccountId?: string | null;
  officialServiceKind?: 'relay' | 'cloud_studio' | 'inference' | 'billing' | string | null;
  executionBoundary?: GsapExecutionBoundary;
  pluginId: string;
  pluginDir: string;
  dataDir: string;
  capabilities?: string[];
  sensitiveCapabilities?: string[];
  sessionId?: string | null;
  sessionRef?: GsapSessionRef | null;
  /** @deprecated Use sessionId/sessionRef. Kept for legacy plugins. */
  sessionPath?: string | null;
  bus: GsapEventBus;
  network: GsapPluginNetwork;
  resources: GsapPluginResources;
  config: GsapPluginConfigStore;
  log: GsapPluginLogger;
  registerSessionFile?: (input: Record<string, unknown>) => GsapSessionFile;
  stageFile?: (input: Record<string, unknown>) => GsapStagedSessionFile;
  [key: string]: unknown;
}

export type GsapToolSessionPermissionKind =
  | 'read'
  | 'read_only'
  | 'plugin_output'
  | 'session_file_output'
  | 'workspace_write'
  | 'external_side_effect'
  | 'review'
  | string;

export interface GsapToolSessionPermission<Input = unknown> {
  readOnly?: boolean;
  kind?: GsapToolSessionPermissionKind;
  auto?: 'allow' | 'review';
  description?: string;
  sideEffect?: Record<string, unknown>;
  describeSideEffect?: (input: Input) => Record<string, unknown> | null | undefined;
}

export interface GsapToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  parameters?: JsonSchema;
  promptSnippet?: string;
  promptGuidelines?: string;
  sessionPermission?: GsapToolSessionPermission<Input>;
  metadata?: Record<string, unknown>;
  invocationStyle?: 'sdk_tool' | 'pi_tool';
  execute(input: Input, ctx: GsapToolContext): MaybePromise<Output>;
}

export type GsapSlashPermission = 'anyone' | 'owner' | 'admin';
export type GsapSlashScope = 'session' | 'global';

export interface GsapCommandContext {
  [key: string]: unknown;
}

export interface GsapCommandResult {
  reply?: string;
  silent?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface GsapCommandDefinition<Context = GsapCommandContext> {
  name: string;
  aliases?: string[];
  description?: string;
  scope?: GsapSlashScope;
  permission?: GsapSlashPermission;
  usage?: string;
  handler?: (ctx: Context) => MaybePromise<GsapCommandResult | void>;
  execute?: (ctx: Context) => MaybePromise<unknown>;
}

export type GsapProviderRuntimeKind = 'http' | 'oauth-http' | 'local-cli' | 'browser-cli' | 'plugin';
export type GsapMediaCapabilityName = 'imageGeneration' | 'videoGeneration' | 'speechGeneration' | string;
export type GsapMediaOutputKind = 'file_glob' | 'json_stdout' | 'url_stdout';
export type GsapCliBindingSource = 'prompt' | 'modelId' | 'inputFile' | 'outputDir' | 'size' | 'duration';

export type GsapCliArgBinding =
  | { literal: string }
  | { option: string; from: GsapCliBindingSource };

export interface GsapCliOutputContract {
  kind: GsapMediaOutputKind;
  directory?: GsapCliBindingSource | string;
  pattern?: string;
  [key: string]: unknown;
}

export interface GsapCliCommandSpec {
  executable: string;
  args: GsapCliArgBinding[];
  timeoutMs: number;
  output: GsapCliOutputContract;
}

export interface GsapProviderRuntime {
  kind: GsapProviderRuntimeKind;
  protocolId?: string;
  command?: GsapCliCommandSpec;
  [key: string]: unknown;
}

export interface GsapProviderChatCapability {
  projection?: 'models-json' | 'sdk-auth-alias' | 'none' | string;
  runtimeProviderId?: string;
  displayProviderId?: string;
  allowListSource?: string;
  [key: string]: unknown;
}

export interface GsapMediaReferenceImageLimits {
  min?: number;
  max?: number;
  [key: string]: unknown;
}

export interface GsapMediaInputLimits {
  referenceImages?: GsapMediaReferenceImageLimits;
  [key: string]: unknown;
}

export interface GsapProviderMediaMode {
  id: string;
  label?: string;
  parameterSchema?: JsonSchema;
  defaults?: Record<string, unknown>;
  inputLimits?: GsapMediaInputLimits;
  pricing?: Record<string, unknown>;
  agentHints?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GsapProviderMediaModel {
  id: string;
  displayName?: string;
  protocolId: string;
  inputs?: string[];
  outputs?: string[];
  supportsEdit?: boolean;
  aliases?: string[];
  credentialLaneId?: string;
  modes?: GsapProviderMediaMode[];
  parameterSchema?: JsonSchema;
  defaults?: Record<string, unknown>;
  inputLimits?: GsapMediaInputLimits;
  [key: string]: unknown;
}

export interface GsapProviderCredentialLane {
  id: string;
  kind?: string;
  label?: string;
  [key: string]: unknown;
}

export interface GsapProviderMediaCapability {
  defaultModelId?: string;
  models: GsapProviderMediaModel[];
  credentialLanes?: GsapProviderCredentialLane[];
  [key: string]: unknown;
}

export interface GsapProviderCapabilities {
  chat?: GsapProviderChatCapability;
  media?: Partial<Record<GsapMediaCapabilityName, GsapProviderMediaCapability>>;
  [key: string]: unknown;
}

export interface GsapProviderSource {
  kind: 'builtin' | 'plugin' | 'user' | string;
  pluginId?: string;
  [key: string]: unknown;
}

export interface GsapProviderDefinition {
  id: string;
  displayName?: string;
  name?: string;
  authType?: 'api-key' | 'oauth' | 'none' | string;
  authJsonKey?: string;
  defaultBaseUrl?: string;
  defaultApi?: string;
  api?: string;
  models?: unknown[];
  runtime?: GsapProviderRuntime;
  capabilities?: GsapProviderCapabilities;
  source?: GsapProviderSource;
  [key: string]: unknown;
}

export type GsapExtensionFactory<Pi = unknown> = (pi: Pi) => MaybePromise<void>;

export interface GsapPluginConfigStore {
  get<T = unknown>(key: string, options?: GsapPluginConfigScopeOptions): MaybePromise<T | undefined>;
  getAll?(options?: GsapPluginConfigScopeOptions & { redacted?: boolean }): MaybePromise<Record<string, unknown>>;
  set<T = unknown>(key: string, value: T, options?: GsapPluginConfigScopeOptions): MaybePromise<void>;
  setMany?(values: Record<string, unknown>, options?: GsapPluginConfigScopeOptions): MaybePromise<Record<string, unknown>>;
  getSchema?(): JsonSchema;
}

export interface GsapPluginConfigScopeOptions {
  scope?: 'global' | 'per-agent' | 'per-session';
  agentId?: string;
  sessionId?: string;
  /** @deprecated Use sessionId. Kept for legacy config scopes. */
  sessionPath?: string;
}

export interface GsapSessionTurnContext {
  system?: string | Array<string | { text: string; label?: string }>;
  beforeUser?: string | Array<string | { text: string; label?: string }>;
  afterUser?: string | Array<string | { text: string; label?: string }>;
  metadata?: Record<string, unknown>;
}

export interface GsapSessionCreateInput {
  agentId?: string | null;
  cwd?: string | null;
  memoryEnabled?: boolean;
  model?: string | { id?: string; modelId?: string; provider?: string; providerId?: string };
  workspaceFolders?: string[];
  authorizedFolders?: string[];
  thinkingLevel?: string;
  permissionMode?: string;
  ownerPluginId?: string | null;
  kind?: string | null;
  sessionKind?: string | null;
  visibility?: 'public' | 'plugin_private' | 'private' | string;
}

export interface GsapSessionSendInput {
  text: string;
  context?: GsapSessionTurnContext | null;
  images?: unknown[];
  videos?: unknown[];
  audios?: unknown[];
  imageAttachmentPaths?: string[];
  videoAttachmentPaths?: string[];
  audioAttachmentPaths?: string[];
  [key: string]: unknown;
}

export interface GsapSessionListFilter {
  agentId?: string;
  ownerPluginId?: string;
  includePluginPrivate?: boolean;
}

export interface GsapSessionUpdateInput {
  title?: string;
  pinned?: boolean;
  projectId?: string | null;
  thinkingLevel?: string;
  permissionMode?: string;
  ownerPluginId?: string | null;
  kind?: string | null;
  visibility?: 'public' | 'plugin_private' | 'private' | string;
}

export interface GsapAgentCreateInput {
  id?: string;
  name: string;
  yuan?: string;
  ownerPluginId?: string | null;
  visibility?: 'public' | 'plugin_private' | 'private' | string;
  kind?: string | null;
  initialFiles?: Record<string, string>;
  initialMemory?: Record<string, unknown>;
  memoryPolicy?: { enabled?: boolean };
}

export interface GsapAgentUpdateInput {
  name?: string;
  yuan?: string;
  ownerPluginId?: string | null;
  visibility?: 'public' | 'plugin_private' | 'private' | string;
  kind?: string | null;
  memoryPolicy?: { enabled?: boolean };
  toolPolicy?: { disabled?: string[] };
  config?: Record<string, unknown>;
}

export interface GsapModelSampleInput {
  systemPrompt?: string;
  messages: Array<{ role: string; content: unknown }>;
  sessionId?: string;
  sessionRef?: GsapSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  agentId?: string;
  temperature?: number;
  maxTokens?: number;
  operation?: string;
}

export interface GsapMediaProviderFilter {
  capability?: string;
}

export interface GsapMediaModelRef {
  providerId?: string;
  provider?: string;
  modelId?: string;
  model?: string;
  capability?: string;
  credentialLaneId?: string;
}

export type GsapSessionFileReference =
  | { kind: 'session_file'; fileId: string }
  | { type: 'session_file'; fileId: string };

export type GsapGenerateImageReference = GsapSessionFileReference;

export interface GsapMediaDelivery {
  mode?: 'session' | 'response' | string;
  ttlMs?: number;
  [key: string]: unknown;
}

export interface GsapGenerateImageInput {
  sessionId?: string;
  sessionRef?: GsapSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  prompt: string;
  count?: number;
  image?: string | GsapGenerateImageReference | GsapGenerateImageReference[];
  referenceImages?: GsapGenerateImageReference[];
  ratio?: string;
  resolution?: string;
  quality?: string;
  mode?: string;
  options?: Record<string, unknown>;
  model?: string;
  provider?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  delivery?: GsapMediaDelivery;
  deliveryMode?: string;
  deliveryTarget?: unknown;
}

export interface GsapGenerateVideoInput {
  sessionId?: string;
  sessionRef?: GsapSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  prompt: string;
  image?: GsapGenerateImageReference | GsapGenerateImageReference[] | string;
  referenceImages?: GsapGenerateImageReference[];
  images?: string[];
  duration?: number;
  ratio?: string;
  resolution?: string;
  mode?: string;
  options?: Record<string, unknown>;
  model?: string;
  provider?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  delivery?: GsapMediaDelivery;
  deliveryMode?: string;
  deliveryTarget?: unknown;
  [key: string]: unknown;
}

export interface GsapGenerateMediaInput {
  kind?: 'image' | 'video' | 'audio' | 'image_generation' | 'video_generation' | 'speech_recognition' | 'asr' | 'transcription' | string;
  type?: string;
  mediaKind?: string;
  sessionId?: string;
  sessionRef?: GsapSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  fileId?: string;
  prompt?: string;
  image?: string | GsapGenerateImageReference | GsapGenerateImageReference[];
  referenceImages?: GsapGenerateImageReference[];
  duration?: number;
  ratio?: string;
  resolution?: string;
  quality?: string;
  mode?: string;
  options?: Record<string, unknown>;
  model?: string;
  provider?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  delivery?: GsapMediaDelivery;
  deliveryMode?: string;
  [key: string]: unknown;
}

export interface GsapTranscribeAudioInput {
  sessionId?: string;
  sessionRef?: GsapSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  fileId: string;
  language?: string;
  providerId?: string;
  provider?: string;
  modelId?: string;
  model?: string;
}

export interface GsapTranscribeAudioResult {
  ok: true;
  transcription: unknown;
  taskId?: string;
  stream?: unknown;
}

export interface GsapEventBus {
  emit(event: unknown, sessionPath?: string | null): unknown;
  emit(type: string, payload?: unknown): unknown;
  subscribe(callback: (event: unknown, sessionPath?: string | null) => void, filter?: GsapBusSubscriptionFilter): () => void;
  subscribe(type: string, handler: (payload: unknown) => void): () => void;
  request<T = unknown>(type: string, payload?: unknown, options?: Record<string, unknown>): Promise<T>;
  hasHandler?(type: string): boolean;
  handle?(type: string, handler: (payload: unknown) => MaybePromise<unknown>): () => void;
  listCapabilities?(): GsapEventBusCapability[];
  getCapability?(type: string): GsapEventBusCapability | null;
}

export interface GsapBusSubscriptionFilter {
  types?: string[] | Set<string>;
  sessionPath?: string;
  [key: string]: unknown;
}

export interface GsapEventBusCapability {
  type: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  permission: string;
  errors: string[];
  stability: string;
  owner: string;
  since?: string;
  available?: boolean;
}

export interface GsapNormalizedUsage {
  input: {
    totalTokens: number | null;
    uncachedTokens: number | null;
  };
  output: {
    totalTokens: number | null;
    reasoningTokens: number | null;
  };
  cache: {
    readTokens: number | null;
    writeTokens: number | null;
    missTokens: number | null;
    hit: boolean | null;
    created: boolean | null;
    hitRatio: number | null;
    support: 'reported' | 'not_reported' | 'not_supported';
  };
  totalTokens: number | null;
  costTotal: number | null;
}

export type GsapUsageAttribution =
  | { kind: 'session'; agentId: string | null; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'phone_conversation'; agentId: string; conversationId: string; conversationType: 'channel' | 'dm'; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'memory'; agentId: string | null }
  | { kind: 'automation'; jobId?: string | null; runId?: string | null; agentId?: string | null }
  | { kind: 'plugin'; pluginId: string; agentId?: string | null; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'utility'; agentId?: string | null; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'unknown' };

export interface GsapUsageSource {
  subsystem: 'session' | 'phone' | 'memory' | 'automation' | 'subagent' | 'compaction' | 'plugin' | 'utility' | 'vision' | 'unknown' | string;
  operation: string;
  surface: 'desktop' | 'mobile' | 'bridge' | 'channel' | 'dm' | 'cron' | 'heartbeat' | 'system' | 'plugin' | 'unknown' | string;
  trigger: 'user' | 'manual' | 'threshold' | 'overflow' | 'daily' | 'scheduled' | 'startup' | 'tool' | 'unknown' | string;
  actor?: {
    kind: 'session' | 'phone_conversation' | 'automation' | 'plugin' | 'subagent' | 'unknown' | string;
    agentId?: string | null;
    sessionId?: string | null;
    sessionPath?: string | null;
    taskId?: string | null;
    [key: string]: unknown;
  };
  parent?: {
    kind: 'session' | 'phone_conversation' | 'automation' | 'plugin' | 'unknown' | string;
    sessionPath?: string;
    conversationId?: string;
    conversationType?: 'channel' | 'dm';
    taskId?: string;
    pluginId?: string;
    [key: string]: unknown;
  };
}

export interface GsapUsageLedgerEntry {
  schemaVersion: 1;
  requestId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'aborted' | 'usage_missing';
  source: GsapUsageSource;
  attribution: GsapUsageAttribution;
  model: {
    provider: string | null;
    modelId: string | null;
    api: string | null;
  };
  usage: GsapNormalizedUsage | null;
  rawUsageShape: string | null;
  error: {
    name: string | null;
    message: string | null;
  } | null;
}

export interface GsapUsageListFilter {
  since?: string;
  until?: string;
  attributionKind?: string;
  sessionPath?: string;
  agentId?: string;
  subsystem?: string;
  operation?: string;
  modelId?: string;
  provider?: string;
  status?: 'ok' | 'error' | 'aborted' | 'usage_missing' | string;
  limit?: number;
}

export interface GsapUsageListResult {
  entries: GsapUsageLedgerEntry[];
  nextCursor: string | null;
}

export interface GsapUsageEventMeta {
  sessionId?: string | null;
  sessionPath?: string | null;
  sessionRef?: GsapSessionRef | null;
}

export interface GsapPluginLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface GsapBusHandlerContext {
  serverId: string;
  serverNodeId?: string;
  userId: string;
  studioId: string;
  connectionKind?: 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud' | string;
  credentialKind?: 'none' | 'loopback_token' | 'device_credential' | 'user_session' | string;
  platformAccountId?: string | null;
  officialServiceKind?: 'relay' | 'cloud_studio' | 'inference' | 'billing' | string | null;
  executionBoundary?: GsapExecutionBoundary;
  pluginId: string;
  sessionId?: string | null;
  sessionRef?: GsapSessionRef | null;
  /** @deprecated Use sessionId/sessionRef. Kept for legacy plugins. */
  sessionPath?: string | null;
  bus: GsapEventBus;
  network: GsapPluginNetwork;
  resources?: GsapPluginResources;
  config?: GsapPluginConfigStore;
  log?: GsapPluginLogger;
  [key: string]: unknown;
}

export interface GsapBusHandlerDefinition<
  Payload = unknown,
  Result = unknown,
  Context extends GsapBusHandlerContext = GsapBusHandlerContext,
> {
  type: string;
  handle(payload: Payload, ctx: Context): MaybePromise<Result>;
}

export interface GsapPluginContext {
  serverId: string;
  serverNodeId?: string;
  userId: string;
  studioId: string;
  connectionKind?: 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud' | string;
  credentialKind?: 'none' | 'loopback_token' | 'device_credential' | 'user_session' | string;
  platformAccountId?: string | null;
  officialServiceKind?: 'relay' | 'cloud_studio' | 'inference' | 'billing' | string | null;
  executionBoundary?: GsapExecutionBoundary;
  pluginId: string;
  pluginDir: string;
  dataDir: string;
  capabilities?: string[];
  sensitiveCapabilities?: string[];
  sessionId?: string | null;
  sessionRef?: GsapSessionRef | null;
  /** @deprecated Use sessionId/sessionRef. Kept for legacy plugins. */
  sessionPath?: string | null;
  bus: GsapEventBus;
  network: GsapPluginNetwork;
  resources: GsapPluginResources;
  config: GsapPluginConfigStore;
  log: GsapPluginLogger;
  registerTool?: (tool: GsapToolDefinition) => () => void;
  registerSessionFile?: (input: Record<string, unknown>) => GsapSessionFile;
  stageFile?: (input: Record<string, unknown>) => GsapStagedSessionFile;
  [key: string]: unknown;
}

export type GsapPluginDisposable = () => void;

export interface GsapPluginLifecycleHelpers {
  register(disposable: GsapPluginDisposable): void;
}

export interface GsapPluginLifecycle {
  onload?(ctx: GsapPluginContext, helpers: GsapPluginLifecycleHelpers): MaybePromise<void>;
  onunload?(ctx: GsapPluginContext): MaybePromise<void>;
}

export interface GsapPluginInstance {
  ctx: GsapPluginContext;
  register: (disposable: GsapPluginDisposable) => void;
  onload?(): MaybePromise<void>;
  onunload?(): MaybePromise<void>;
}

export type GsapTaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'aborted';

export interface GsapTaskProgress {
  current?: number;
  total?: number;
  percent?: number;
  message?: string;
}

export interface GsapTaskRecord {
  taskId: string;
  type: string;
  parentSessionPath?: string | null;
  pluginId?: string | null;
  agentId?: string | null;
  meta?: Record<string, unknown>;
  progress?: GsapTaskProgress | null;
  status: GsapTaskStatus;
  aborted?: boolean;
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
}

export interface GsapTaskSchedule {
  scheduleId: string;
  type: string;
  pluginId?: string | null;
  agentId?: string | null;
  parentSessionPath?: string | null;
  payload?: unknown;
  meta?: Record<string, unknown>;
  intervalMs?: number | null;
  runAt?: number | string | null;
  enabled?: boolean;
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  lastResult?: unknown;
  lastError?: string | null;
  runCount?: number;
}

export interface GsapTaskRegisterInput {
  taskId: string;
  type: string;
  parentSessionPath?: string | null;
  pluginId?: string | null;
  agentId?: string | null;
  meta?: Record<string, unknown>;
  persist?: boolean;
}

export interface GsapTaskUpdateInput {
  taskId: string;
  status?: GsapTaskStatus;
  progress?: GsapTaskProgress | null;
  meta?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  parentSessionPath?: string | null;
  pluginId?: string | null;
  agentId?: string | null;
}

export interface GsapTaskScheduleInput {
  scheduleId: string;
  type: string;
  pluginId?: string | null;
  agentId?: string | null;
  parentSessionPath?: string | null;
  payload?: unknown;
  meta?: Record<string, unknown>;
  intervalMs?: number;
  runAt?: number | string | Date;
  enabled?: boolean;
}

const EMPTY_PARAMETERS: JsonSchema = { type: 'object', properties: {} };

export function defineTool<Input = unknown, Output = unknown>(
  definition: GsapToolDefinition<Input, Output>,
): GsapToolDefinition<Input, Output> & { parameters: JsonSchema } {
  return {
    ...definition,
    parameters: definition.parameters ?? EMPTY_PARAMETERS,
  };
}

export function defineCommand<Context = GsapCommandContext>(
  definition: GsapCommandDefinition<Context>,
): GsapCommandDefinition<Context> {
  return { ...definition };
}

export function defineProvider<T extends GsapProviderDefinition>(definition: T): T {
  return definition;
}

export function defineBusHandler<
  Payload = unknown,
  Result = unknown,
  Context extends GsapBusHandlerContext = GsapBusHandlerContext,
>(
  definition: GsapBusHandlerDefinition<Payload, Result, Context>,
): GsapBusHandlerDefinition<Payload, Result, Context> {
  return { ...definition };
}

export function requestBus<Result = unknown, Payload = unknown>(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  type: string,
  payload?: Payload,
  options?: Record<string, unknown>,
): Promise<Result> {
  if (!ctx.bus || typeof ctx.bus.request !== 'function') {
    throw new Error('plugin bus request unavailable');
  }
  return ctx.bus.request<Result>(type, payload, options);
}

function pluginIdFromContext(ctx: { pluginId?: string | null }): string | null {
  return typeof ctx.pluginId === 'string' && ctx.pluginId.length > 0 ? ctx.pluginId : null;
}

function withOwnerPlugin<T extends Record<string, unknown>>(
  ctx: { pluginId?: string | null },
  input: T,
): T {
  const pluginId = pluginIdFromContext(ctx);
  if (!pluginId || input.ownerPluginId) return input;
  return { ...input, ownerPluginId: pluginId };
}

function withContextMetadata(
  ctx: { pluginId?: string | null },
  context: GsapSessionTurnContext | null | undefined,
): GsapSessionTurnContext | null | undefined {
  if (!context) return context;
  const pluginId = pluginIdFromContext(ctx);
  if (!pluginId) return context;
  return {
    ...context,
    metadata: {
      pluginId,
      ...(context.metadata || {}),
    },
  };
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeSessionTarget(target: GsapSessionTarget): Record<string, unknown> {
  if (typeof target === 'string') return { sessionPath: target };
  if (!target || typeof target !== 'object') return { sessionPath: target as unknown };

  const sessionId = textOrNull((target as any).sessionId);
  const sessionPath = textOrNull((target as any).sessionPath) || textOrNull((target as any).path);
  const legacySessionPath = textOrNull((target as any).legacySessionPath);
  if (!sessionId) {
    return sessionPath ? { sessionPath } : {};
  }

  const sessionRef: GsapSessionRef = {
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
    ...(legacySessionPath ? { legacySessionPath } : {}),
  };
  return {
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
    ...(legacySessionPath ? { legacySessionPath } : {}),
    sessionRef,
  };
}

function sessionRefFromTarget(target: GsapSessionTarget): GsapSessionRef | null {
  const payload = normalizeSessionTarget(target);
  return (payload.sessionRef as GsapSessionRef | undefined) || null;
}

export function createSession(
  ctx: { pluginId?: string | null; bus?: Pick<GsapEventBus, 'request'> | null },
  input: GsapSessionCreateInput = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:create', withOwnerPlugin(ctx, { ...input }), options);
}

export function getSession(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  target: GsapSessionTarget,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:get', normalizeSessionTarget(target), options);
}

export function listSessions(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  filter: GsapSessionListFilter = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:list', filter, options);
}

export function updateSession(
  ctx: { pluginId?: string | null; bus?: Pick<GsapEventBus, 'request'> | null },
  target: GsapSessionTarget,
  patch: GsapSessionUpdateInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:update', {
    ...normalizeSessionTarget(target),
    ...withOwnerPlugin(ctx, { ...patch }),
  }, options);
}

export function sendSessionMessage(
  ctx: { pluginId?: string | null; bus?: Pick<GsapEventBus, 'request'> | null },
  target: GsapSessionTarget,
  input: GsapSessionSendInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:send', {
    ...normalizeSessionTarget(target),
    ...input,
    context: withContextMetadata(ctx, input.context),
  }, options);
}

export function subscribeSessionEvents(
  ctx: { bus?: Pick<GsapEventBus, 'subscribe'> | null },
  target: GsapSessionTarget,
  handler: (event: unknown, meta: { sessionId: string | null; sessionPath: string | null; sessionRef: GsapSessionRef | null }) => void,
): () => void {
  if (!ctx.bus || typeof ctx.bus.subscribe !== 'function') {
    throw new Error('plugin bus subscribe unavailable');
  }
  const filter = normalizeSessionTarget(target);
  const targetRef = sessionRefFromTarget(target);
  return ctx.bus.subscribe((event, scopedSessionPath) => {
    const eventSessionId = event && typeof event === 'object' ? textOrNull((event as any).sessionId) : null;
    const sessionId = eventSessionId || targetRef?.sessionId || null;
    const sessionPath = scopedSessionPath || targetRef?.sessionPath || null;
    const sessionRef = sessionId ? {
      sessionId,
      ...(sessionPath ? { sessionPath } : {}),
      ...(targetRef?.legacySessionPath ? { legacySessionPath: targetRef.legacySessionPath } : {}),
    } : null;
    handler(event, { sessionId, sessionPath, sessionRef });
  }, filter);
}

export function listAgents(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  filter: { ownerPluginId?: string; includePluginPrivate?: boolean } = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:list', filter, options);
}

export function getAgentProfile(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  agentId: string,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:profile', { agentId }, options);
}

export function createAgent(
  ctx: { pluginId?: string | null; bus?: Pick<GsapEventBus, 'request'> | null },
  input: GsapAgentCreateInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:create', withOwnerPlugin(ctx, { ...input }), options);
}

export function updateAgent(
  ctx: { pluginId?: string | null; bus?: Pick<GsapEventBus, 'request'> | null },
  agentId: string,
  patch: GsapAgentUpdateInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:update', { agentId, ...withOwnerPlugin(ctx, { ...patch }) }, options);
}

export function sampleText(
  ctx: { pluginId?: string | null; bus?: Pick<GsapEventBus, 'request'> | null },
  input: GsapModelSampleInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'model:sample-text', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function listMediaProviders(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  filter: GsapMediaProviderFilter = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'provider:media-providers', filter, options);
}

export function resolveMediaModel(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  ref: GsapMediaModelRef,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'provider:resolve-media-model', ref, options);
}

export function generateImage(
  ctx: { pluginId?: string | null; bus?: Pick<GsapEventBus, 'request'> | null },
  input: GsapGenerateImageInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'media:generate-image', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function generateVideo(
  ctx: { pluginId?: string | null; bus?: Pick<GsapEventBus, 'request'> | null },
  input: GsapGenerateVideoInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'media:generate-video', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function generateMedia(
  ctx: { pluginId?: string | null; bus?: Pick<GsapEventBus, 'request'> | null },
  input: GsapGenerateMediaInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'media:generate', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function transcribeAudio(
  ctx: { pluginId?: string | null; bus?: Pick<GsapEventBus, 'request'> | null },
  input: GsapTranscribeAudioInput,
  options?: Record<string, unknown>,
): Promise<GsapTranscribeAudioResult> {
  return requestBus(ctx, 'media:transcribe-audio', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options).then(normalizeTranscribeAudioResult);
}

function normalizeTranscribeAudioResult(result: unknown): GsapTranscribeAudioResult {
  if (result && typeof result === 'object' && (result as any).ok === true
    && Object.prototype.hasOwnProperty.call(result, 'transcription')) {
    return result as GsapTranscribeAudioResult;
  }
  return { ok: true, transcription: result };
}

export function listUsageEntries(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  filter: GsapUsageListFilter = {},
  options?: Record<string, unknown>,
): Promise<GsapUsageListResult> {
  return requestBus<GsapUsageListResult, GsapUsageListFilter>(ctx, 'usage:list', filter, options);
}

export function subscribeUsageEvents(
  ctx: { bus?: { subscribe?: (handler: (event: unknown, sessionPath?: string | null) => void, filter?: Record<string, unknown>) => () => void } | null },
  handler: (entry: GsapUsageLedgerEntry, meta: GsapUsageEventMeta) => void,
): () => void {
  if (!ctx.bus || typeof ctx.bus.subscribe !== 'function') {
    throw new Error('plugin bus subscribe unavailable');
  }
  return ctx.bus.subscribe((event, sessionPath) => {
    if (!event || typeof event !== 'object') return;
    const typed = event as { type?: unknown; entry?: unknown };
    if (typed.type !== 'llm_usage') return;
    const entry = typed.entry as GsapUsageLedgerEntry;
    const entrySessionId =
      textOrNull((entry as any)?.attribution?.sessionId)
      || textOrNull((entry as any)?.source?.actor?.sessionId)
      || textOrNull((entry as any)?.source?.parent?.sessionId);
    const entrySessionPath =
      textOrNull((entry as any)?.attribution?.sessionPath)
      || textOrNull((entry as any)?.source?.actor?.sessionPath)
      || textOrNull((entry as any)?.source?.parent?.sessionPath)
      || textOrNull(sessionPath);
    handler(entry, {
      ...(entrySessionId ? { sessionId: entrySessionId } : {}),
      sessionPath: entrySessionPath,
      ...(entrySessionId ? {
        sessionRef: {
          sessionId: entrySessionId,
          ...(entrySessionPath ? { sessionPath: entrySessionPath } : {}),
        },
      } : {}),
    });
  }, { types: ['llm_usage'] });
}

export function registerTask(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  input: GsapTaskRegisterInput,
): Promise<{ ok: true }> {
  return requestBus(ctx, 'task:register', input);
}

export function updateTask(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  input: GsapTaskUpdateInput,
): Promise<{ ok: true; task: GsapTaskRecord }> {
  return requestBus(ctx, 'task:update', input);
}

export function completeTask(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  taskId: string,
  result?: unknown,
): Promise<{ ok: true; task: GsapTaskRecord }> {
  return requestBus(ctx, 'task:complete', { taskId, result });
}

export function failTask(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  taskId: string,
  error: unknown,
): Promise<{ ok: true; task: GsapTaskRecord }> {
  return requestBus(ctx, 'task:fail', { taskId, error });
}

export function cancelTask(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  taskId: string,
  reason?: string,
): Promise<{ result: string; canceled: boolean }> {
  return requestBus(ctx, 'task:cancel', { taskId, reason });
}

export function scheduleTask(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  input: GsapTaskScheduleInput,
): Promise<{ ok: true; schedule: GsapTaskSchedule }> {
  return requestBus(ctx, 'task:schedule', input);
}

export function unscheduleTask(
  ctx: { bus?: Pick<GsapEventBus, 'request'> | null },
  scheduleId: string,
): Promise<{ ok: true; removed: boolean }> {
  return requestBus(ctx, 'task:unschedule', { scheduleId });
}

export function sessionFileToMediaItem(file: GsapSessionFile): GsapSessionFileMediaItem {
  const fileId = firstText(file.fileId, file.id);
  if (!fileId) {
    throw new Error('SessionFile media item requires id or fileId');
  }

  const item: GsapSessionFileMediaItem = {
    type: 'session_file',
    fileId,
  };
  assignDefined(item, 'sessionId', file.sessionId);
  assignDefined(item, 'sessionPath', file.sessionPath);
  assignDefined(item, 'filePath', file.filePath);
  assignDefined(item, 'label', firstText(file.label, file.displayName, file.filename));
  assignDefined(item, 'mime', file.mime);
  assignDefined(item, 'size', file.size);
  assignDefined(item, 'kind', file.kind);
  return item;
}

type GsapMediaInput = GsapSessionFile | GsapSessionFileMediaItem | GsapStagedSessionFile;

export function createMediaDetails(items: GsapMediaInput[]): GsapMediaDetails {
  return {
    media: {
      items: items.map(normalizeMediaItem),
    },
  };
}

export function defineExtension<Pi = unknown>(factory: GsapExtensionFactory<Pi>): GsapExtensionFactory<Pi> {
  return factory;
}

export function definePlugin(lifecycle: GsapPluginLifecycle): new () => GsapPluginInstance {
  return class DefinedGsapPlugin implements GsapPluginInstance {
    ctx!: GsapPluginContext;
    register!: (disposable: GsapPluginDisposable) => void;

    async onload(): Promise<void> {
      await lifecycle.onload?.(this.ctx, { register: this.register });
    }

    async onunload(): Promise<void> {
      await lifecycle.onunload?.(this.ctx);
    }
  };
}

function normalizeMediaItem(input: GsapMediaInput): GsapSessionFileMediaItem {
  if (isRecord(input) && isRecord(input.mediaItem)) {
    return normalizeSessionFileMediaItem(input.mediaItem);
  }
  if (isRecord(input) && input.type === 'session_file') {
    return normalizeSessionFileMediaItem(input);
  }
  if (isRecord(input)) {
    return sessionFileToMediaItem(input);
  }
  throw new Error('media details item must be a SessionFile, staged file, or session_file media item');
}

function normalizeSessionFileMediaItem(input: Record<string, unknown>): GsapSessionFileMediaItem {
  if (input.type !== 'session_file') {
    throw new Error('media details item must be a session_file media item');
  }
  const fileId = firstText(input.fileId);
  if (!fileId) {
    throw new Error('SessionFile media item requires fileId');
  }
  return {
    ...input,
    type: 'session_file',
    fileId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
}
