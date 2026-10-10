export type MaybePromise<T> = T | Promise<T>;

export type JsonSchema = Record<string, unknown>;

export const CODIA_BUS_SKIP = Symbol.for('codia.event-bus.skip');

export interface CodiaToolResult {
  content?: Array<Record<string, unknown>>;
  details?: Record<string, unknown>;
}

export interface CodiaSessionRef {
  sessionId: string;
  sessionPath?: string | null;
  legacySessionPath?: string | null;
}

export type CodiaSessionTarget = string | CodiaSessionRef | {
  sessionId?: string | null;
  sessionPath?: string | null;
  path?: string | null;
  legacySessionPath?: string | null;
};

export interface CodiaSessionFile {
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
  resource?: CodiaResourceEnvelope;
  [key: string]: unknown;
}

export interface CodiaResourceEnvelope {
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

export type CodiaResourceRef =
  | { kind: 'local-file'; path: string }
  | { kind: 'mount'; mountId: string; path: string }
  | { kind: 'session-file'; fileId: string; sessionId?: string; sessionPath?: string }
  | { kind: 'resource'; resourceId: string }
  | { kind: 'url'; url: string };

export interface CodiaResourceVersion {
  mtimeMs?: number;
  size?: number | null;
  sha256?: string;
  etag?: string;
  sequence?: number;
}

export type CodiaResourceDescriptor = CodiaResourceRef & {
  provider?: string;
  filePath?: string;
  displayName?: string;
};

export interface CodiaResourceStat {
  resourceKey: string;
  resource: CodiaResourceDescriptor;
  exists: boolean;
  isDirectory: boolean;
  version?: CodiaResourceVersion;
  filePath?: string;
}

export interface CodiaResourceReadResult {
  resourceKey: string;
  resource: CodiaResourceDescriptor;
  content: Uint8Array;
  version?: CodiaResourceVersion;
  filePath?: string;
}

export interface CodiaResourceMutationResult {
  changeType: 'created' | 'modified';
  resourceKey: string;
  resource: CodiaResourceDescriptor;
  version?: CodiaResourceVersion;
  filePath?: string;
}

export interface CodiaResourceWriteConflictResult {
  ok: false;
  conflict: true;
  resourceKey: string;
  resource: CodiaResourceDescriptor;
  version?: CodiaResourceVersion;
  filePath?: string;
}

export type CodiaResourceWriteExpectedVersionResult =
  | CodiaResourceMutationResult
  | CodiaResourceWriteConflictResult;

export interface CodiaResourceMoveResult {
  oldResourceKey: string;
  newResourceKey: string;
  oldResource: CodiaResourceDescriptor;
  newResource: CodiaResourceDescriptor;
  oldFilePath?: string;
  newFilePath?: string;
}

export interface CodiaResourceTrashOptions {
  namespace?: string;
  metadata?: Record<string, unknown>;
}

export interface CodiaResourceTrashResult {
  resourceKey: string;
  resource: CodiaResourceDescriptor;
  trashId: string;
  trashPath?: string;
  payloadPath?: string;
  filePath?: string;
}

export interface CodiaResourceEdit {
  oldText: string;
  newText: string;
}

export interface CodiaResourceListItem {
  name: string;
  isDirectory: boolean;
  size: number | null;
  mtimeMs: number;
}

export interface CodiaResourceListResult {
  resourceKey: string;
  resource: CodiaResourceDescriptor;
  items: CodiaResourceListItem[];
}

export interface CodiaResourceSearchOptions {
  query?: string;
  [key: string]: unknown;
}

export interface CodiaResourceSearchMatch {
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

export interface CodiaResourceSearchResult {
  resourceKey: string;
  resource: CodiaResourceDescriptor;
  matches: CodiaResourceSearchMatch[];
}

export interface CodiaResourceMaterializeResult {
  resourceKey: string;
  resource: CodiaResourceDescriptor;
  filePath: string;
  version?: CodiaResourceVersion;
}

export interface CodiaResourceWatchTarget {
  ref?: CodiaResourceRef;
  filePath: string;
  isDirectory?: boolean;
  resourceKey: string;
  resource: CodiaResourceDescriptor;
}

export interface CodiaPluginResourceMutationOptions {
  emit?: boolean;
}

export interface CodiaPluginResources {
  stat(ref: CodiaResourceRef | Record<string, unknown>): Promise<CodiaResourceStat>;
  read(ref: CodiaResourceRef | Record<string, unknown>): Promise<CodiaResourceReadResult>;
  list(ref: CodiaResourceRef | Record<string, unknown>): Promise<CodiaResourceListResult>;
  search(ref: CodiaResourceRef | Record<string, unknown>, options?: CodiaResourceSearchOptions): Promise<CodiaResourceSearchResult>;
  materialize(ref: CodiaResourceRef | Record<string, unknown>): Promise<CodiaResourceMaterializeResult>;
  write(ref: CodiaResourceRef | Record<string, unknown>, content: string | Uint8Array | ArrayBuffer, options?: CodiaPluginResourceMutationOptions): Promise<CodiaResourceMutationResult>;
  writeExpectedVersion(ref: CodiaResourceRef | Record<string, unknown>, content: string | Uint8Array | ArrayBuffer, expectedVersion: CodiaResourceVersion, options?: CodiaPluginResourceMutationOptions): Promise<CodiaResourceWriteExpectedVersionResult>;
  edit(ref: CodiaResourceRef | Record<string, unknown>, edits: CodiaResourceEdit[], options?: CodiaPluginResourceMutationOptions): Promise<CodiaResourceMutationResult>;
  mkdir(ref: CodiaResourceRef | Record<string, unknown>, options?: CodiaPluginResourceMutationOptions): Promise<CodiaResourceMutationResult>;
  delete(ref: CodiaResourceRef | Record<string, unknown>, options?: CodiaPluginResourceMutationOptions): Promise<CodiaResourceMutationResult>;
  copy(from: CodiaResourceRef | Record<string, unknown>, to: CodiaResourceRef | Record<string, unknown>, options?: CodiaPluginResourceMutationOptions): Promise<CodiaResourceMutationResult>;
  rename(from: CodiaResourceRef | Record<string, unknown>, to: CodiaResourceRef | Record<string, unknown>, options?: CodiaPluginResourceMutationOptions): Promise<CodiaResourceMoveResult>;
  move(from: CodiaResourceRef | Record<string, unknown>, to: CodiaResourceRef | Record<string, unknown>, options?: CodiaPluginResourceMutationOptions): Promise<CodiaResourceMoveResult>;
  trash(ref: CodiaResourceRef | Record<string, unknown>, trashOptions?: CodiaResourceTrashOptions, options?: CodiaPluginResourceMutationOptions): Promise<CodiaResourceTrashResult>;
  resolveWatchTarget?(ref: CodiaResourceRef | Record<string, unknown>): CodiaResourceWatchTarget;
}

export interface CodiaExecutionBoundary {
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

export interface CodiaPluginNetworkFetchInit extends RequestInit {
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxResponseBytes?: number;
}

export interface CodiaPluginNetwork {
  fetch(input: string | URL | Request, init?: CodiaPluginNetworkFetchInit): Promise<Response>;
}

export interface CodiaSessionFileMediaItem {
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

export interface CodiaStagedSessionFile {
  file?: CodiaSessionFile | null;
  sessionFile?: CodiaSessionFile | null;
  mediaItem: CodiaSessionFileMediaItem;
}

export interface CodiaMediaDetails {
  media: {
    items: CodiaSessionFileMediaItem[];
  };
}

export interface CodiaToolContext {
  serverId: string;
  serverNodeId?: string;
  userId: string;
  studioId: string;
  connectionKind?: 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud' | string;
  credentialKind?: 'none' | 'loopback_token' | 'device_credential' | 'user_session' | string;
  platformAccountId?: string | null;
  officialServiceKind?: 'relay' | 'cloud_studio' | 'inference' | 'billing' | string | null;
  executionBoundary?: CodiaExecutionBoundary;
  pluginId: string;
  pluginDir: string;
  dataDir: string;
  capabilities?: string[];
  sensitiveCapabilities?: string[];
  sessionId?: string | null;
  sessionRef?: CodiaSessionRef | null;
  /** @deprecated Use sessionId/sessionRef. Kept for legacy plugins. */
  sessionPath?: string | null;
  bus: CodiaEventBus;
  network: CodiaPluginNetwork;
  resources: CodiaPluginResources;
  config: CodiaPluginConfigStore;
  log: CodiaPluginLogger;
  registerSessionFile?: (input: Record<string, unknown>) => CodiaSessionFile;
  stageFile?: (input: Record<string, unknown>) => CodiaStagedSessionFile;
  [key: string]: unknown;
}

export type CodiaToolSessionPermissionKind =
  | 'read'
  | 'read_only'
  | 'plugin_output'
  | 'session_file_output'
  | 'workspace_write'
  | 'external_side_effect'
  | 'review'
  | string;

export interface CodiaToolSessionPermission<Input = unknown> {
  readOnly?: boolean;
  kind?: CodiaToolSessionPermissionKind;
  auto?: 'allow' | 'review';
  description?: string;
  sideEffect?: Record<string, unknown>;
  describeSideEffect?: (input: Input) => Record<string, unknown> | null | undefined;
}

export interface CodiaToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  parameters?: JsonSchema;
  promptSnippet?: string;
  promptGuidelines?: string;
  sessionPermission?: CodiaToolSessionPermission<Input>;
  metadata?: Record<string, unknown>;
  invocationStyle?: 'sdk_tool' | 'pi_tool';
  execute(input: Input, ctx: CodiaToolContext): MaybePromise<Output>;
}

export type CodiaSlashPermission = 'anyone' | 'owner' | 'admin';
export type CodiaSlashScope = 'session' | 'global';

export interface CodiaCommandContext {
  [key: string]: unknown;
}

export interface CodiaCommandResult {
  reply?: string;
  silent?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface CodiaCommandDefinition<Context = CodiaCommandContext> {
  name: string;
  aliases?: string[];
  description?: string;
  scope?: CodiaSlashScope;
  permission?: CodiaSlashPermission;
  usage?: string;
  handler?: (ctx: Context) => MaybePromise<CodiaCommandResult | void>;
  execute?: (ctx: Context) => MaybePromise<unknown>;
}

export type CodiaProviderRuntimeKind = 'http' | 'oauth-http' | 'local-cli' | 'browser-cli' | 'plugin';
export type CodiaMediaCapabilityName = 'imageGeneration' | 'videoGeneration' | 'speechGeneration' | string;
export type CodiaMediaOutputKind = 'file_glob' | 'json_stdout' | 'url_stdout';
export type CodiaCliBindingSource = 'prompt' | 'modelId' | 'inputFile' | 'outputDir' | 'size' | 'duration';

export type CodiaCliArgBinding =
  | { literal: string }
  | { option: string; from: CodiaCliBindingSource };

export interface CodiaCliOutputContract {
  kind: CodiaMediaOutputKind;
  directory?: CodiaCliBindingSource | string;
  pattern?: string;
  [key: string]: unknown;
}

export interface CodiaCliCommandSpec {
  executable: string;
  args: CodiaCliArgBinding[];
  timeoutMs: number;
  output: CodiaCliOutputContract;
}

export interface CodiaProviderRuntime {
  kind: CodiaProviderRuntimeKind;
  protocolId?: string;
  command?: CodiaCliCommandSpec;
  [key: string]: unknown;
}

export interface CodiaProviderChatCapability {
  projection?: 'models-json' | 'sdk-auth-alias' | 'none' | string;
  runtimeProviderId?: string;
  displayProviderId?: string;
  allowListSource?: string;
  [key: string]: unknown;
}

export interface CodiaMediaReferenceImageLimits {
  min?: number;
  max?: number;
  [key: string]: unknown;
}

export interface CodiaMediaInputLimits {
  referenceImages?: CodiaMediaReferenceImageLimits;
  [key: string]: unknown;
}

export interface CodiaProviderMediaMode {
  id: string;
  label?: string;
  parameterSchema?: JsonSchema;
  defaults?: Record<string, unknown>;
  inputLimits?: CodiaMediaInputLimits;
  pricing?: Record<string, unknown>;
  agentHints?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodiaProviderMediaModel {
  id: string;
  displayName?: string;
  protocolId: string;
  inputs?: string[];
  outputs?: string[];
  supportsEdit?: boolean;
  aliases?: string[];
  credentialLaneId?: string;
  modes?: CodiaProviderMediaMode[];
  parameterSchema?: JsonSchema;
  defaults?: Record<string, unknown>;
  inputLimits?: CodiaMediaInputLimits;
  [key: string]: unknown;
}

export interface CodiaProviderCredentialLane {
  id: string;
  kind?: string;
  label?: string;
  [key: string]: unknown;
}

export interface CodiaProviderMediaCapability {
  defaultModelId?: string;
  models: CodiaProviderMediaModel[];
  credentialLanes?: CodiaProviderCredentialLane[];
  [key: string]: unknown;
}

export interface CodiaProviderCapabilities {
  chat?: CodiaProviderChatCapability;
  media?: Partial<Record<CodiaMediaCapabilityName, CodiaProviderMediaCapability>>;
  [key: string]: unknown;
}

export interface CodiaProviderSource {
  kind: 'builtin' | 'plugin' | 'user' | string;
  pluginId?: string;
  [key: string]: unknown;
}

export interface CodiaProviderDefinition {
  id: string;
  displayName?: string;
  name?: string;
  authType?: 'api-key' | 'oauth' | 'none' | string;
  authJsonKey?: string;
  defaultBaseUrl?: string;
  defaultApi?: string;
  api?: string;
  models?: unknown[];
  runtime?: CodiaProviderRuntime;
  capabilities?: CodiaProviderCapabilities;
  source?: CodiaProviderSource;
  [key: string]: unknown;
}

export type CodiaExtensionFactory<Pi = unknown> = (pi: Pi) => MaybePromise<void>;

export interface CodiaPluginConfigStore {
  get<T = unknown>(key: string, options?: CodiaPluginConfigScopeOptions): MaybePromise<T | undefined>;
  getAll?(options?: CodiaPluginConfigScopeOptions & { redacted?: boolean }): MaybePromise<Record<string, unknown>>;
  set<T = unknown>(key: string, value: T, options?: CodiaPluginConfigScopeOptions): MaybePromise<void>;
  setMany?(values: Record<string, unknown>, options?: CodiaPluginConfigScopeOptions): MaybePromise<Record<string, unknown>>;
  getSchema?(): JsonSchema;
}

export interface CodiaPluginConfigScopeOptions {
  scope?: 'global' | 'per-agent' | 'per-session';
  agentId?: string;
  sessionId?: string;
  /** @deprecated Use sessionId. Kept for legacy config scopes. */
  sessionPath?: string;
}

export interface CodiaSessionTurnContext {
  system?: string | Array<string | { text: string; label?: string }>;
  beforeUser?: string | Array<string | { text: string; label?: string }>;
  afterUser?: string | Array<string | { text: string; label?: string }>;
  metadata?: Record<string, unknown>;
}

export interface CodiaSessionCreateInput {
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

export interface CodiaSessionSendInput {
  text: string;
  context?: CodiaSessionTurnContext | null;
  images?: unknown[];
  videos?: unknown[];
  audios?: unknown[];
  imageAttachmentPaths?: string[];
  videoAttachmentPaths?: string[];
  audioAttachmentPaths?: string[];
  [key: string]: unknown;
}

export interface CodiaSessionListFilter {
  agentId?: string;
  ownerPluginId?: string;
  includePluginPrivate?: boolean;
}

export interface CodiaSessionUpdateInput {
  title?: string;
  pinned?: boolean;
  projectId?: string | null;
  thinkingLevel?: string;
  permissionMode?: string;
  ownerPluginId?: string | null;
  kind?: string | null;
  visibility?: 'public' | 'plugin_private' | 'private' | string;
}

export interface CodiaAgentCreateInput {
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

export interface CodiaAgentUpdateInput {
  name?: string;
  yuan?: string;
  ownerPluginId?: string | null;
  visibility?: 'public' | 'plugin_private' | 'private' | string;
  kind?: string | null;
  memoryPolicy?: { enabled?: boolean };
  toolPolicy?: { disabled?: string[] };
  config?: Record<string, unknown>;
}

export interface CodiaModelSampleInput {
  systemPrompt?: string;
  messages: Array<{ role: string; content: unknown }>;
  sessionId?: string;
  sessionRef?: CodiaSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  agentId?: string;
  temperature?: number;
  maxTokens?: number;
  operation?: string;
}

export interface CodiaMediaProviderFilter {
  capability?: string;
}

export interface CodiaMediaModelRef {
  providerId?: string;
  provider?: string;
  modelId?: string;
  model?: string;
  capability?: string;
  credentialLaneId?: string;
}

export type CodiaSessionFileReference =
  | { kind: 'session_file'; fileId: string }
  | { type: 'session_file'; fileId: string };

export type CodiaGenerateImageReference = CodiaSessionFileReference;

export interface CodiaMediaDelivery {
  mode?: 'session' | 'response' | string;
  ttlMs?: number;
  [key: string]: unknown;
}

export interface CodiaGenerateImageInput {
  sessionId?: string;
  sessionRef?: CodiaSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  prompt: string;
  count?: number;
  image?: string | CodiaGenerateImageReference | CodiaGenerateImageReference[];
  referenceImages?: CodiaGenerateImageReference[];
  ratio?: string;
  resolution?: string;
  quality?: string;
  mode?: string;
  options?: Record<string, unknown>;
  model?: string;
  provider?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  delivery?: CodiaMediaDelivery;
  deliveryMode?: string;
  deliveryTarget?: unknown;
}

export interface CodiaGenerateVideoInput {
  sessionId?: string;
  sessionRef?: CodiaSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  prompt: string;
  image?: CodiaGenerateImageReference | CodiaGenerateImageReference[] | string;
  referenceImages?: CodiaGenerateImageReference[];
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
  delivery?: CodiaMediaDelivery;
  deliveryMode?: string;
  deliveryTarget?: unknown;
  [key: string]: unknown;
}

export interface CodiaGenerateMediaInput {
  kind?: 'image' | 'video' | 'audio' | 'image_generation' | 'video_generation' | 'speech_recognition' | 'asr' | 'transcription' | string;
  type?: string;
  mediaKind?: string;
  sessionId?: string;
  sessionRef?: CodiaSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  fileId?: string;
  prompt?: string;
  image?: string | CodiaGenerateImageReference | CodiaGenerateImageReference[];
  referenceImages?: CodiaGenerateImageReference[];
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
  delivery?: CodiaMediaDelivery;
  deliveryMode?: string;
  [key: string]: unknown;
}

export interface CodiaTranscribeAudioInput {
  sessionId?: string;
  sessionRef?: CodiaSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  fileId: string;
  language?: string;
  providerId?: string;
  provider?: string;
  modelId?: string;
  model?: string;
}

export interface CodiaTranscribeAudioResult {
  ok: true;
  transcription: unknown;
  taskId?: string;
  stream?: unknown;
}

export interface CodiaEventBus {
  emit(event: unknown, sessionPath?: string | null): unknown;
  emit(type: string, payload?: unknown): unknown;
  subscribe(callback: (event: unknown, sessionPath?: string | null) => void, filter?: CodiaBusSubscriptionFilter): () => void;
  subscribe(type: string, handler: (payload: unknown) => void): () => void;
  request<T = unknown>(type: string, payload?: unknown, options?: Record<string, unknown>): Promise<T>;
  hasHandler?(type: string): boolean;
  handle?(type: string, handler: (payload: unknown) => MaybePromise<unknown>): () => void;
  listCapabilities?(): CodiaEventBusCapability[];
  getCapability?(type: string): CodiaEventBusCapability | null;
}

export interface CodiaBusSubscriptionFilter {
  types?: string[] | Set<string>;
  sessionPath?: string;
  [key: string]: unknown;
}

export interface CodiaEventBusCapability {
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

export interface CodiaNormalizedUsage {
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

export type CodiaUsageAttribution =
  | { kind: 'session'; agentId: string | null; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'phone_conversation'; agentId: string; conversationId: string; conversationType: 'channel' | 'dm'; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'memory'; agentId: string | null }
  | { kind: 'automation'; jobId?: string | null; runId?: string | null; agentId?: string | null }
  | { kind: 'plugin'; pluginId: string; agentId?: string | null; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'utility'; agentId?: string | null; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'unknown' };

export interface CodiaUsageSource {
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

export interface CodiaUsageLedgerEntry {
  schemaVersion: 1;
  requestId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'aborted' | 'usage_missing';
  source: CodiaUsageSource;
  attribution: CodiaUsageAttribution;
  model: {
    provider: string | null;
    modelId: string | null;
    api: string | null;
  };
  usage: CodiaNormalizedUsage | null;
  rawUsageShape: string | null;
  error: {
    name: string | null;
    message: string | null;
  } | null;
}

export interface CodiaUsageListFilter {
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

export interface CodiaUsageListResult {
  entries: CodiaUsageLedgerEntry[];
  nextCursor: string | null;
}

export interface CodiaUsageEventMeta {
  sessionId?: string | null;
  sessionPath?: string | null;
  sessionRef?: CodiaSessionRef | null;
}

export interface CodiaPluginLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface CodiaBusHandlerContext {
  serverId: string;
  serverNodeId?: string;
  userId: string;
  studioId: string;
  connectionKind?: 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud' | string;
  credentialKind?: 'none' | 'loopback_token' | 'device_credential' | 'user_session' | string;
  platformAccountId?: string | null;
  officialServiceKind?: 'relay' | 'cloud_studio' | 'inference' | 'billing' | string | null;
  executionBoundary?: CodiaExecutionBoundary;
  pluginId: string;
  sessionId?: string | null;
  sessionRef?: CodiaSessionRef | null;
  /** @deprecated Use sessionId/sessionRef. Kept for legacy plugins. */
  sessionPath?: string | null;
  bus: CodiaEventBus;
  network: CodiaPluginNetwork;
  resources?: CodiaPluginResources;
  config?: CodiaPluginConfigStore;
  log?: CodiaPluginLogger;
  [key: string]: unknown;
}

export interface CodiaBusHandlerDefinition<
  Payload = unknown,
  Result = unknown,
  Context extends CodiaBusHandlerContext = CodiaBusHandlerContext,
> {
  type: string;
  handle(payload: Payload, ctx: Context): MaybePromise<Result>;
}

export interface CodiaPluginContext {
  serverId: string;
  serverNodeId?: string;
  userId: string;
  studioId: string;
  connectionKind?: 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud' | string;
  credentialKind?: 'none' | 'loopback_token' | 'device_credential' | 'user_session' | string;
  platformAccountId?: string | null;
  officialServiceKind?: 'relay' | 'cloud_studio' | 'inference' | 'billing' | string | null;
  executionBoundary?: CodiaExecutionBoundary;
  pluginId: string;
  pluginDir: string;
  dataDir: string;
  capabilities?: string[];
  sensitiveCapabilities?: string[];
  sessionId?: string | null;
  sessionRef?: CodiaSessionRef | null;
  /** @deprecated Use sessionId/sessionRef. Kept for legacy plugins. */
  sessionPath?: string | null;
  bus: CodiaEventBus;
  network: CodiaPluginNetwork;
  resources: CodiaPluginResources;
  config: CodiaPluginConfigStore;
  log: CodiaPluginLogger;
  registerTool?: (tool: CodiaToolDefinition) => () => void;
  registerSessionFile?: (input: Record<string, unknown>) => CodiaSessionFile;
  stageFile?: (input: Record<string, unknown>) => CodiaStagedSessionFile;
  [key: string]: unknown;
}

export type CodiaPluginDisposable = () => void;

export interface CodiaPluginLifecycleHelpers {
  register(disposable: CodiaPluginDisposable): void;
}

export interface CodiaPluginLifecycle {
  onload?(ctx: CodiaPluginContext, helpers: CodiaPluginLifecycleHelpers): MaybePromise<void>;
  onunload?(ctx: CodiaPluginContext): MaybePromise<void>;
}

export interface CodiaPluginInstance {
  ctx: CodiaPluginContext;
  register: (disposable: CodiaPluginDisposable) => void;
  onload?(): MaybePromise<void>;
  onunload?(): MaybePromise<void>;
}

export type CodiaTaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'aborted';

export interface CodiaTaskProgress {
  current?: number;
  total?: number;
  percent?: number;
  message?: string;
}

export interface CodiaTaskRecord {
  taskId: string;
  type: string;
  parentSessionPath?: string | null;
  pluginId?: string | null;
  agentId?: string | null;
  meta?: Record<string, unknown>;
  progress?: CodiaTaskProgress | null;
  status: CodiaTaskStatus;
  aborted?: boolean;
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
}

export interface CodiaTaskSchedule {
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

export interface CodiaTaskRegisterInput {
  taskId: string;
  type: string;
  parentSessionPath?: string | null;
  pluginId?: string | null;
  agentId?: string | null;
  meta?: Record<string, unknown>;
  persist?: boolean;
}

export interface CodiaTaskUpdateInput {
  taskId: string;
  status?: CodiaTaskStatus;
  progress?: CodiaTaskProgress | null;
  meta?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  parentSessionPath?: string | null;
  pluginId?: string | null;
  agentId?: string | null;
}

export interface CodiaTaskScheduleInput {
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
  definition: CodiaToolDefinition<Input, Output>,
): CodiaToolDefinition<Input, Output> & { parameters: JsonSchema } {
  return {
    ...definition,
    parameters: definition.parameters ?? EMPTY_PARAMETERS,
  };
}

export function defineCommand<Context = CodiaCommandContext>(
  definition: CodiaCommandDefinition<Context>,
): CodiaCommandDefinition<Context> {
  return { ...definition };
}

export function defineProvider<T extends CodiaProviderDefinition>(definition: T): T {
  return definition;
}

export function defineBusHandler<
  Payload = unknown,
  Result = unknown,
  Context extends CodiaBusHandlerContext = CodiaBusHandlerContext,
>(
  definition: CodiaBusHandlerDefinition<Payload, Result, Context>,
): CodiaBusHandlerDefinition<Payload, Result, Context> {
  return { ...definition };
}

export function requestBus<Result = unknown, Payload = unknown>(
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
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
  context: CodiaSessionTurnContext | null | undefined,
): CodiaSessionTurnContext | null | undefined {
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

function normalizeSessionTarget(target: CodiaSessionTarget): Record<string, unknown> {
  if (typeof target === 'string') return { sessionPath: target };
  if (!target || typeof target !== 'object') return { sessionPath: target as unknown };

  const sessionId = textOrNull((target as any).sessionId);
  const sessionPath = textOrNull((target as any).sessionPath) || textOrNull((target as any).path);
  const legacySessionPath = textOrNull((target as any).legacySessionPath);
  if (!sessionId) {
    return sessionPath ? { sessionPath } : {};
  }

  const sessionRef: CodiaSessionRef = {
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

function sessionRefFromTarget(target: CodiaSessionTarget): CodiaSessionRef | null {
  const payload = normalizeSessionTarget(target);
  return (payload.sessionRef as CodiaSessionRef | undefined) || null;
}

export function createSession(
  ctx: { pluginId?: string | null; bus?: Pick<CodiaEventBus, 'request'> | null },
  input: CodiaSessionCreateInput = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:create', withOwnerPlugin(ctx, { ...input }), options);
}

export function getSession(
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
  target: CodiaSessionTarget,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:get', normalizeSessionTarget(target), options);
}

export function listSessions(
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
  filter: CodiaSessionListFilter = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:list', filter, options);
}

export function updateSession(
  ctx: { pluginId?: string | null; bus?: Pick<CodiaEventBus, 'request'> | null },
  target: CodiaSessionTarget,
  patch: CodiaSessionUpdateInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:update', {
    ...normalizeSessionTarget(target),
    ...withOwnerPlugin(ctx, { ...patch }),
  }, options);
}

export function sendSessionMessage(
  ctx: { pluginId?: string | null; bus?: Pick<CodiaEventBus, 'request'> | null },
  target: CodiaSessionTarget,
  input: CodiaSessionSendInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:send', {
    ...normalizeSessionTarget(target),
    ...input,
    context: withContextMetadata(ctx, input.context),
  }, options);
}

export function subscribeSessionEvents(
  ctx: { bus?: Pick<CodiaEventBus, 'subscribe'> | null },
  target: CodiaSessionTarget,
  handler: (event: unknown, meta: { sessionId: string | null; sessionPath: string | null; sessionRef: CodiaSessionRef | null }) => void,
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
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
  filter: { ownerPluginId?: string; includePluginPrivate?: boolean } = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:list', filter, options);
}

export function getAgentProfile(
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
  agentId: string,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:profile', { agentId }, options);
}

export function createAgent(
  ctx: { pluginId?: string | null; bus?: Pick<CodiaEventBus, 'request'> | null },
  input: CodiaAgentCreateInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:create', withOwnerPlugin(ctx, { ...input }), options);
}

export function updateAgent(
  ctx: { pluginId?: string | null; bus?: Pick<CodiaEventBus, 'request'> | null },
  agentId: string,
  patch: CodiaAgentUpdateInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:update', { agentId, ...withOwnerPlugin(ctx, { ...patch }) }, options);
}

export function sampleText(
  ctx: { pluginId?: string | null; bus?: Pick<CodiaEventBus, 'request'> | null },
  input: CodiaModelSampleInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'model:sample-text', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function listMediaProviders(
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
  filter: CodiaMediaProviderFilter = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'provider:media-providers', filter, options);
}

export function resolveMediaModel(
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
  ref: CodiaMediaModelRef,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'provider:resolve-media-model', ref, options);
}

export function generateImage(
  ctx: { pluginId?: string | null; bus?: Pick<CodiaEventBus, 'request'> | null },
  input: CodiaGenerateImageInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'media:generate-image', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function generateVideo(
  ctx: { pluginId?: string | null; bus?: Pick<CodiaEventBus, 'request'> | null },
  input: CodiaGenerateVideoInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'media:generate-video', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function generateMedia(
  ctx: { pluginId?: string | null; bus?: Pick<CodiaEventBus, 'request'> | null },
  input: CodiaGenerateMediaInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'media:generate', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function transcribeAudio(
  ctx: { pluginId?: string | null; bus?: Pick<CodiaEventBus, 'request'> | null },
  input: CodiaTranscribeAudioInput,
  options?: Record<string, unknown>,
): Promise<CodiaTranscribeAudioResult> {
  return requestBus(ctx, 'media:transcribe-audio', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options).then(normalizeTranscribeAudioResult);
}

function normalizeTranscribeAudioResult(result: unknown): CodiaTranscribeAudioResult {
  if (result && typeof result === 'object' && (result as any).ok === true
    && Object.prototype.hasOwnProperty.call(result, 'transcription')) {
    return result as CodiaTranscribeAudioResult;
  }
  return { ok: true, transcription: result };
}

export function listUsageEntries(
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
  filter: CodiaUsageListFilter = {},
  options?: Record<string, unknown>,
): Promise<CodiaUsageListResult> {
  return requestBus<CodiaUsageListResult, CodiaUsageListFilter>(ctx, 'usage:list', filter, options);
}

export function subscribeUsageEvents(
  ctx: { bus?: { subscribe?: (handler: (event: unknown, sessionPath?: string | null) => void, filter?: Record<string, unknown>) => () => void } | null },
  handler: (entry: CodiaUsageLedgerEntry, meta: CodiaUsageEventMeta) => void,
): () => void {
  if (!ctx.bus || typeof ctx.bus.subscribe !== 'function') {
    throw new Error('plugin bus subscribe unavailable');
  }
  return ctx.bus.subscribe((event, sessionPath) => {
    if (!event || typeof event !== 'object') return;
    const typed = event as { type?: unknown; entry?: unknown };
    if (typed.type !== 'llm_usage') return;
    const entry = typed.entry as CodiaUsageLedgerEntry;
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
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
  input: CodiaTaskRegisterInput,
): Promise<{ ok: true }> {
  return requestBus(ctx, 'task:register', input);
}

export function updateTask(
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
  input: CodiaTaskUpdateInput,
): Promise<{ ok: true; task: CodiaTaskRecord }> {
  return requestBus(ctx, 'task:update', input);
}

export function completeTask(
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
  taskId: string,
  result?: unknown,
): Promise<{ ok: true; task: CodiaTaskRecord }> {
  return requestBus(ctx, 'task:complete', { taskId, result });
}

export function failTask(
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
  taskId: string,
  error: unknown,
): Promise<{ ok: true; task: CodiaTaskRecord }> {
  return requestBus(ctx, 'task:fail', { taskId, error });
}

export function cancelTask(
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
  taskId: string,
  reason?: string,
): Promise<{ result: string; canceled: boolean }> {
  return requestBus(ctx, 'task:cancel', { taskId, reason });
}

export function scheduleTask(
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
  input: CodiaTaskScheduleInput,
): Promise<{ ok: true; schedule: CodiaTaskSchedule }> {
  return requestBus(ctx, 'task:schedule', input);
}

export function unscheduleTask(
  ctx: { bus?: Pick<CodiaEventBus, 'request'> | null },
  scheduleId: string,
): Promise<{ ok: true; removed: boolean }> {
  return requestBus(ctx, 'task:unschedule', { scheduleId });
}

export function sessionFileToMediaItem(file: CodiaSessionFile): CodiaSessionFileMediaItem {
  const fileId = firstText(file.fileId, file.id);
  if (!fileId) {
    throw new Error('SessionFile media item requires id or fileId');
  }

  const item: CodiaSessionFileMediaItem = {
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

type CodiaMediaInput = CodiaSessionFile | CodiaSessionFileMediaItem | CodiaStagedSessionFile;

export function createMediaDetails(items: CodiaMediaInput[]): CodiaMediaDetails {
  return {
    media: {
      items: items.map(normalizeMediaItem),
    },
  };
}

export function defineExtension<Pi = unknown>(factory: CodiaExtensionFactory<Pi>): CodiaExtensionFactory<Pi> {
  return factory;
}

export function definePlugin(lifecycle: CodiaPluginLifecycle): new () => CodiaPluginInstance {
  return class DefinedCodiaPlugin implements CodiaPluginInstance {
    ctx!: CodiaPluginContext;
    register!: (disposable: CodiaPluginDisposable) => void;

    async onload(): Promise<void> {
      await lifecycle.onload?.(this.ctx, { register: this.register });
    }

    async onunload(): Promise<void> {
      await lifecycle.onunload?.(this.ctx);
    }
  };
}

function normalizeMediaItem(input: CodiaMediaInput): CodiaSessionFileMediaItem {
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

function normalizeSessionFileMediaItem(input: Record<string, unknown>): CodiaSessionFileMediaItem {
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
