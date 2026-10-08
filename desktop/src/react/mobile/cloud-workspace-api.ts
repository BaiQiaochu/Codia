/** Shared cloud workspace API. Web uses its same-origin session; desktop supplies its authorized server transport. */
export interface CloudWorkspaceRecord { id: string; name: string; created_at: string }
export interface CloudFile { id: string; name: string; current_version: string; version_count: number; size: number; sha256: string; created_at: string }
export interface CloudVersion { id: string; size: number; sha256: string; created_at: string }
export interface CloudRun { id: string; status: string; operation: string; input_version: string; created_at: string; updated_at: string; artifact_file_id?: string | null; error?: string | null; retry_of?: string | null }
export interface CloudEvent { id: number | string; kind: string; payload: unknown; created_at: string }
export interface CloudArtifact { id: string; file_id: string; version_id: string; name: string; size: number }
export interface CloudRunDetail { run: CloudRun; events: CloudEvent[]; artifacts: CloudArtifact[] }
export type CloudOperation = 'document-summary' | 'agent-summary' | 'agent-task';
export interface CloudTaskPlan {
  id: string; title: string; currentVersion: string; workspaceId: string; instruction: string;
  inputVersions: string[]; sourceWorkflowVersion?: string; createdAt: string; updatedAt: string;
}
export interface CloudSchedule {
  id: string; name: string; input_version: string; operation: CloudOperation;
  state: 'enabled' | 'paused' | 'completed'; next_run_at: number; interval_ms: number | null;
  revision: number; last_run_id?: string | null; created_at: string; updated_at: string;
}
export interface CloudTaskSession {
  schemaVersion: 1; runId: string; attempt: number; inputVersion?: string; sourceWorkflowVersion?: string; finalText: string; inputVersions: string[];
  messages: { role: string; text?: string; toolName?: string; toolCallId?: string; isError?: boolean }[];
  artifacts: { id: string; name: string; content: string; sha256: string; size: number }[];
}
export const CLOUD_TASK_INPUT_LIMIT = 128 * 1024;
export const CLOUD_TASK_INPUT_COUNT = 8;
export function cloudUtcDate(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间不可用' : date.toISOString();
}
export interface CloudHealth {
  mode: string; database: string; objectStore: string; executor: string; productionReady: boolean;
  executorAvailable?: boolean;
  executorUnavailableReason?: string | null;
  supportedOperations?: string[];
  uploadLimit?: number;
  uploadSession?: boolean;
  resumableUploadLimit?: number;
  uploadChunkSize?: number;
  documentLimit?: number;
  agentInputLimit?: number;
  runRetry?: boolean;
}
export interface CloudWorkspaceClient {
  json<T>(path: string, init?: RequestInit): Promise<T>;
  contentUrl(versionId: string, download?: boolean): string;
  content(versionId: string, init?: RequestInit): Promise<Response>;
  uploadChunk?(uploadId: string, index: number, bytes: Uint8Array, sha256: string, signal?: AbortSignal): Promise<{ upload: CloudUploadSession }>;
  download?(versionId: string, filename: string): Promise<void>;
}
export function cloudOperationLabel(operation: string): string {
  return operation === 'agent-task' ? '云端 Agent 任务' : operation === 'agent-conversation' ? '云端对话回复' : operation === 'agent-summary' ? 'AI 文档摘要' : operation === 'document-summary' ? '文档检查与摘要' : operation;
}
export function cloudOperationAvailable(health: CloudHealth | null, operation: CloudOperation): boolean {
  if (!health) return false;
  const supported = health.supportedOperations || (health.executor === 'codia-agent' ? ['document-summary', 'agent-summary'] : ['document-summary']);
  return supported.includes(operation) && (!operation.startsWith('agent-') || health.executorAvailable === true);
}

export const CLOUD_API = '/api/cloud';
export const CLOUD_UPLOAD_LIMIT = 2 * 1024 * 1024;
export const CLOUD_RESUMABLE_UPLOAD_LIMIT = 32 * 1024 * 1024;
export const CLOUD_UPLOAD_CHUNK_SIZE = 1024 * 1024;
export interface CloudUploadSession {
  id: string; workspace_id: string; name: string; size: number; sha256: string;
  state: 'uploading' | 'completing' | 'completed' | 'cancelled' | 'expired';
  chunk_size: number; received_chunks: number[]; received_bytes: number; expires_at: number | string; revision: number;
  file_id?: string | null; expected_version?: string | null; version_id?: string | null;
}
export interface CloudUploadResult { upload: CloudUploadSession; file?: CloudFile; version?: CloudVersion }
export function cloudUploadAvailable(health: CloudHealth | null, client: CloudWorkspaceClient): boolean {
  return health?.uploadSession === true && typeof client.uploadChunk === 'function';
}

export class CloudApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = 'CloudApiError'; this.status = status; }
}

type CloudTransport = (path: string, init: RequestInit) => Promise<Response>;
const webTransport: CloudTransport = (path, init) => fetch(path, { ...init, credentials: 'same-origin' });

async function requestJson<T>(transport: CloudTransport, path: string, init: RequestInit = {}, raw = false): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.method && init.method !== 'GET') {
    headers.set('Content-Type', raw ? 'application/octet-stream' : 'application/json');
    headers.set('X-Requested-With', 'cloud-studio');
  }
  const response = await transport(`${CLOUD_API}${path}`, { ...init, headers });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const serverMessage = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : '';
    const friendlyErrors: Record<string, string> = {
      executor_unavailable: 'AI 执行器暂不可用。请先在设置中配置模型，再刷新。',
      conversation_busy: '上一条消息仍在处理中，请等待回复后再发送。',
      chat_scope_required: '当前账号没有发送 AI 对话消息的权限。',
      invalid_record_data: '记录内容必须是有效的 JSON 对象。',
      invalid_message: '消息不能为空或过长，请修改后重试。',
      model_not_configured: '尚未配置 AI 模型。文件保存与文档检查仍可使用。',
      invalid_name: '名称不能为空，也不能包含斜线或控制字符。',
      not_found: '内容不存在，或当前账号没有访问权限。',
      insufficient_scope: '当前账号没有执行这项操作的权限。',
      cloud_workspace_unavailable: '工作空间服务暂时不可用，请稍后重试。',
      name_exists: '这个文件名已存在，请刷新文件列表后保存新版本。',
      file_name_exists: '这个文件名已存在，请刷新文件列表后保存新版本。',
      file_exists: '这个文件名已存在，请刷新文件列表后保存新版本。',
      invalid_task_plan: '任务计划无效，请检查指令与固定输入版本。',
      invalid_workflow: '所选版本不是有效的已保存工作流。',
      unsupported_document: '此文件不是有效的 UTF-8 文本，无法执行任务。',
      invalid_schedule_time: '首次运行时间无效，请选择 1970 年以后的有效时间。',
      invalid_schedule_interval: '运行间隔须介于 1 分钟与 366 天之间。',
      invalid_instruction: '任务指令不能为空或过长，请修改后重试。',
      invalid_task_inputs: '请选择当前工作空间中的有效文本版本，最多 8 份、合计 128 KiB。',
      invalid_schedule: '定时设置无效，请检查首次运行时间和运行间隔。',
      run_not_complete: '任务尚未完成，请稍后读取结果。',
      cancelled: '任务已取消。',
      upload_completion_busy: '服务端正在完成其他上传，请稍后继续此上传。已收到的分块会保留。',
      upload_expired: '上传会话已过期，请重新开始上传。',
      upload_cancelled: '此上传已取消，请重新开始上传。',
      upload_quota_exceeded: '未完成上传已达到服务端配额，请先完成或取消已有上传。',
      upload_retention_quota_exceeded: '最近 24 小时的上传保留配额已用完，请稍后再试。取消已有上传不会立即释放此配额。',
      upload_not_pending: '此上传已结束，请刷新上传列表查看状态。',
      upload_hash_mismatch: '文件校验失败，请重新选择原始文件。',
      chunk_hash_mismatch: '分块校验失败，请重试此上传。',
      run_not_retryable: '只有失败或已取消的非对话任务可以重新运行。',
    };
    const message = response.status === 401 ? '登录已失效，请刷新页面后重新登录。'
      : response.status === 409 ? (path.includes('/uploads') ? (friendlyErrors[serverMessage] || '上传状态或文件版本已变化。请刷新上传列表，核对后继续。') : path.endsWith('/retry') ? '当前运行无法重试，请刷新并核对运行状态。' : path.endsWith('/task-session') ? '任务会话尚不可读取，请稍后重试。' : path.includes('/schedules') ? '定时任务已被其他操作修改。请刷新列表，核对最新状态后再操作。' : path.includes('/task-plans') || path.endsWith('/runs') ? '请求与已保存的任务不一致，请刷新并核对固定版本。你的草稿仍保留。' : path.endsWith('/cancel') ? '任务状态已变化，请刷新运行记录后查看。' : path.startsWith('/records/') ? '记录已出现新版本，请重新读取后再保存。你的未保存内容仍保留在编辑器中。' : '文件已出现新版本，请重新选择最新版本后上传。')
        : response.status === 413 ? (path.includes('/uploads') ? '文件或分块超出上传限制，文件最大 32 MiB、单块最大 1 MiB。' : path.includes('/task-plans') ? '任务输入过大，请限制为最多 8 份文本、合计 128 KiB。' : path.includes('/records') ? '记录过大，请将结构化数据缩减到 120 KiB 以内。' : '文件过大，请选择不超过 2 MiB 的文件。')
          : friendlyErrors[serverMessage] || serverMessage || `请求未完成（${response.status}），请稍后重试。`;
    throw new CloudApiError(message, response.status);
  }
  if (!body) throw new CloudApiError('服务器未返回有效数据，请确认云工作空间服务已启用。', response.status);
  return body as T;
}

export function createCloudWorkspaceClient(transport: CloudTransport = webTransport): CloudWorkspaceClient {
  return {
    json: <T>(path: string, init: RequestInit = {}) => requestJson<T>(transport, path, init),
    uploadChunk: (uploadId, index, bytes, sha256, signal) => requestJson(transport, `/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`, {
      method: 'PUT', body: bytes as BodyInit, signal, headers: { 'X-Chunk-SHA256': sha256 },
    }, true),
    contentUrl: cloudContentUrl,
    content: (versionId, init = {}) => transport(cloudContentUrl(versionId), init),
  };
}
export const webCloudWorkspaceClient = createCloudWorkspaceClient();
export function cloudJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  return webCloudWorkspaceClient.json<T>(path, init);
}

export function cloudContentUrl(versionId: string, download = false): string {
  return `${CLOUD_API}/versions/${encodeURIComponent(versionId)}/content${download ? '?download=1' : ''}`;
}

export async function fileContentBase64(file: File): Promise<string> {
  if (file.size > CLOUD_UPLOAD_LIMIT) throw new Error('请选择不超过 2 MiB 的文件。');
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

export type CloudContentInspection = { kind: 'text'; text: string } | { kind: 'binary' | 'empty' | 'too-large' };

/** Inspect bounded bytes, never HTML-render or trust a file extension/content-type. */
export async function inspectCloudContent(response: Response, maxBytes = CLOUD_UPLOAD_LIMIT): Promise<CloudContentInspection> {
  if (!response.ok) throw new CloudApiError(`无法读取文件（${response.status}），请刷新后重试。`, response.status);
  const advertised = Number(response.headers.get('Content-Length'));
  if (advertised > maxBytes) { await response.body?.cancel(); return { kind: 'too-large' }; }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) { await reader.cancel(); return { kind: 'too-large' }; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) return { kind: 'too-large' };
    length = bytes.length; chunks.push(bytes);
  }
  if (!length) return { kind: 'empty' };
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const prefix = String.fromCharCode(...bytes.subarray(0, 16));
  // Some document/image/container formats may contain entirely valid UTF-8 bytes.
  if (bytes.includes(0) || /^(%PDF-|GIF8[79]a|RIFF|ID3)/.test(prefix) || (prefix.startsWith('PK') && bytes[2] === 3 && bytes[3] === 4) || prefix.slice(4, 8) === 'ftyp') return { kind: 'binary' };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\x01-\x08\x0e-\x1f]/.test(text)) return { kind: 'binary' }; // eslint-disable-line no-control-regex -- binary-content detection
    return { kind: 'text', text };
  } catch { return { kind: 'binary' }; }
}

export function isActiveCloudRun(status: string): boolean { return status === 'queued' || status === 'running' || status === 'pending'; }
export function cloudStatusLabel(status: string): string {
  return ({ queued: '等待执行', pending: '等待执行', running: '处理中', succeeded: '已完成', completed: '已完成', failed: '失败', cancelled: '已取消' } as Record<string, string>)[status] || status;
}

/** The browser retains bytes only in memory and reads at most 32 MiB for SHA-256. */
export async function readCloudUploadFile(file: File, limit = CLOUD_RESUMABLE_UPLOAD_LIMIT, signal?: AbortSignal): Promise<{ bytes: Uint8Array; sha256: string }> {
  if (file.size > Math.min(limit, CLOUD_RESUMABLE_UPLOAD_LIMIT)) throw new Error('文件超过当前上传限制，最大 32 MiB。');
  signal?.throwIfAborted();
  const buffer = await file.arrayBuffer();
  signal?.throwIfAborted();
  if (buffer.byteLength !== file.size || buffer.byteLength > CLOUD_RESUMABLE_UPLOAD_LIMIT) throw new Error('文件大小已变化，请重新选择原始文件。');
  const bytes = new Uint8Array(buffer);
  const sha256 = await cloudBytesSha256(bytes);
  signal?.throwIfAborted();
  return { bytes, sha256 };
}
export async function cloudBytesSha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器无法安全校验文件，请使用 HTTPS 或受支持的桌面连接。');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), value => value.toString(16).padStart(2, '0')).join('');
}

/** Reconcile with the server before every attempt; never guess whether a lost reply committed. */
export async function continueCloudUpload(client: CloudWorkspaceClient, upload: CloudUploadSession, bytes: Uint8Array, signal: AbortSignal, progress: (upload: CloudUploadSession) => void): Promise<CloudUploadResult> {
  if (!client.uploadChunk) throw new Error('当前服务连接不支持分块上传。');
  const path = `/uploads/${encodeURIComponent(upload.id)}`;
  let current = (await client.json<{ upload: CloudUploadSession }>(path, { signal })).upload;
  signal.throwIfAborted();
  if (current.workspace_id !== upload.workspace_id || current.size !== bytes.length || current.sha256 !== upload.sha256 || current.chunk_size !== CLOUD_UPLOAD_CHUNK_SIZE) throw new Error('上传会话与选定文件不一致，请重新读取上传列表。');
  progress(current);
  if (current.state === 'completed') return { upload: current };
  if (current.state !== 'uploading' && current.state !== 'completing') throw new Error('上传已取消或过期，请重新开始上传。');
  const count = Math.ceil(bytes.length / current.chunk_size);
  for (let index = 0; index < count; index += 1) {
    signal.throwIfAborted();
    if (current.received_chunks.includes(index)) continue;
    const chunk = bytes.slice(index * current.chunk_size, Math.min((index + 1) * current.chunk_size, bytes.length));
    const sha256 = await cloudBytesSha256(chunk);
    signal.throwIfAborted();
    current = (await client.uploadChunk(current.id, index, chunk, sha256, signal)).upload;
    signal.throwIfAborted();
    progress(current);
  }
  signal.throwIfAborted();
  try {
    const result = await client.json<CloudUploadResult>(`${path}/complete`, { method: 'POST', body: '{}', signal });
    signal.throwIfAborted();
    progress(result.upload);
    return result;
  } catch (error) {
    signal.throwIfAborted();
    // A timeout may have hidden a successful completion. Read this same session,
    // never create another session or a second version on an uncertain response.
    current = (await client.json<{ upload: CloudUploadSession }>(path, { signal })).upload;
    signal.throwIfAborted();
    progress(current);
    if (current.state === 'completed') return { upload: current };
    throw error;
  }
}
