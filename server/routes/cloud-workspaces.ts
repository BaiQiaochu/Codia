import { Hono } from 'hono';
import { CloudWorkspaceError, type CloudActor } from '../../lib/cloud-workspace/store.ts';
import { CloudWorkspaceService, CLOUD_UPLOAD_LIMIT } from '../../lib/cloud-workspace/service.ts';
import { CLOUD_RESUMABLE_UPLOAD_LIMIT, CLOUD_UPLOAD_CHUNK_SIZE } from '../../lib/cloud-workspace/uploads.ts';
import { CLOUD_DOCUMENT_INPUT_LIMIT, CLOUD_AGENT_INPUT_LIMIT } from '../../lib/cloud-workspace/input-limits.ts';
import { CloudRecordService } from '../../lib/cloud-workspace/records.ts';
import { CloudTaskService, CLOUD_TASK_TOOLS } from '../../lib/cloud-workspace/agent-tasks.ts';
import { principalHasScope } from '../http/capability-guard.ts';
import { authorizeHttpRoute, isLocalOwnerPrincipal } from '../http/route-security.ts';

export function cloudActor(c: any, pathOverride?: string): CloudActor {
  const principal = c.get('authPrincipal');
  const decision = authorizeHttpRoute({ method: c.req.method, path: pathOverride || c.req.path, principal });
  if (principal?.credentialKind === 'legacy_pwa_demo') throw new CloudWorkspaceError('legacy_demo_not_supported', 403);
  if (!principal?.userId || !principal?.studioId) throw new CloudWorkspaceError('authenticated_identity_required', 401);
  if (!decision.allowed) throw new CloudWorkspaceError('insufficient_scope', 403);
  return { userId: principal.userId, studioId: principal.studioId };
}
export function verifyCloudLocalBearer(authService: any, authorization: string | undefined, connectionKind: string): boolean {
  if (!/^Bearer [^\s]+$/i.test(authorization || '')) return false;
  // Authenticate this header independently, without cookie/query fallback.
  return isLocalOwnerPrincipal(authService.authenticateRequestDetailed({ authorization, connectionKind, allowQueryToken: false }).principal);
}
export function cloudOriginAllowed(c: any, allowedOrigins: readonly string[] = []): boolean {
  const origin = c.req.header('origin');
  if (!origin || origin === new URL(c.req.url).origin || allowedOrigins.includes(origin)) return true;
  // Electron file:// has opaque Origin:null. Only its explicit authenticated
  // loopback-owner bearer transport may use this, never a cookie-only session.
  return origin === 'null' && /^Bearer [^\s]+$/i.test(c.req.header('authorization') || '')
    && c.get('cloudLocalBearer') === true && isLocalOwnerPrincipal(c.get('authPrincipal'));
}
export async function cloudJson(c: any, allowedOrigins: readonly string[] = []) {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') || '')) throw new CloudWorkspaceError('json_required', 415);
  if (c.req.header('x-requested-with') !== 'cloud-studio') throw new CloudWorkspaceError('request_header_required', 403);
  if (!cloudOriginAllowed(c, allowedOrigins)) throw new CloudWorkspaceError('origin_mismatch', 403);
  const reader = c.req.raw.body?.getReader();
  let size = 0; const chunks: Uint8Array[] = [];
  if (!reader) throw new CloudWorkspaceError('json_required');
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 3 * 1024 * 1024) { await reader.cancel(); throw new CloudWorkspaceError('request_too_large', 413); }
    chunks.push(value);
  }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; }
  catch { throw new CloudWorkspaceError('invalid_json'); }
}
async function cloudBinary(c: any, allowedOrigins: readonly string[]) {
  if (!/^application\/octet-stream(?:\s*;|$)/i.test(c.req.header('content-type') || '')) throw new CloudWorkspaceError('binary_required',415);
  if (c.req.header('x-requested-with')!=='cloud-studio') throw new CloudWorkspaceError('request_header_required',403);
  if (!cloudOriginAllowed(c,allowedOrigins)) throw new CloudWorkspaceError('origin_mismatch',403);
  const reader=c.req.raw.body?.getReader(), chunks: Uint8Array[]=[]; let size=0;
  if (!reader) throw new CloudWorkspaceError('invalid_chunk_size');
  try {
    while (true) {
      const {done,value}=await reader.read(); if (done) break;
      size+=value.byteLength;
      if (size>CLOUD_UPLOAD_CHUNK_SIZE) { await reader.cancel().catch(()=>{}); throw new CloudWorkspaceError('request_too_large',413); }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { reader.releaseLock(); }
}
function decode(value: unknown) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new CloudWorkspaceError('invalid_base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > CLOUD_UPLOAD_LIMIT) throw new CloudWorkspaceError('file_too_large', 413);
  return bytes;
}
export function createCloudWorkspacesRoute(service: CloudWorkspaceService, allowedOrigins: readonly string[] = []) {
  const route = new Hono();
  const records = new CloudRecordService(service);
  const tasks = new CloudTaskService(service);
  async function requireAgent(c: { get(name: string): unknown }, actor: CloudActor) {
    if (!principalHasScope(c.get('authPrincipal'), 'chat')) throw new CloudWorkspaceError('chat_scope_required', 403);
    const availability = service.agentExecutor && await service.agentExecutor.availability(actor);
    if (!availability?.available) throw new CloudWorkspaceError(availability?.reason || 'model_not_configured', 503);
  }
  async function validateScheduledInput(actor: CloudActor, workspaceId: string, inputVersion: string, operation: string) {
    if (!['document-summary','agent-summary','agent-task'].includes(operation)) throw new CloudWorkspaceError('unsupported_operation');
    const version=await service.store.version(actor,inputVersion);
    if (version.workspace_id!==workspaceId) throw new CloudWorkspaceError('not_found',404);
    const limit=operation==='document-summary' ? CLOUD_DOCUMENT_INPUT_LIMIT : CLOUD_AGENT_INPUT_LIMIT;
    if (Number(version.size)>limit) throw new CloudWorkspaceError(operation==='document-summary' ? 'document_input_too_large' : 'agent_input_too_large',413);
    if (operation === 'agent-task') await tasks.validateVersion(actor, workspaceId, inputVersion);
  }
  route.onError((err, c) => {
    if (err instanceof CloudWorkspaceError) return c.json({ error: err.code }, err.status as any);
    console.error('[cloud-workspace] request failed', err instanceof Error ? err.name : 'unknown');
    return c.json({ error: 'cloud_workspace_unavailable' }, 500);
  });
  route.get('/cloud/health', async (c) => {
    const actor = cloudActor(c);
    const availability = service.agentExecutor ? await service.agentExecutor.availability(actor) : { available: false, reason: 'model_not_configured' };
    const canInvoke = principalHasScope(c.get('authPrincipal' as never), 'chat');
    return c.json({ mode: service.store.kind === 'postgres' ? 'cloud' : 'local', database: service.store.kind, objectStore: service.objects.kind, executor: 'codia-agent', executorAvailable: availability.available && canInvoke, executorUnavailableReason: canInvoke ? (availability.reason || null) : 'chat_scope_required', supportedOperations: ['document-summary','agent-summary','agent-task'], taskTools: CLOUD_TASK_TOOLS, scheduleTimezone: 'UTC', scheduleMissedPolicy: 'coalesce', productionReady: false, uploadLimit: CLOUD_UPLOAD_LIMIT, uploadSession: true, runRetry: true, resumableUploadLimit: CLOUD_RESUMABLE_UPLOAD_LIMIT, uploadChunkSize: CLOUD_UPLOAD_CHUNK_SIZE, documentLimit: CLOUD_DOCUMENT_INPUT_LIMIT, agentInputLimit: CLOUD_AGENT_INPUT_LIMIT });
  });
  route.get('/cloud/workspaces', async (c) => c.json({ workspaces: await service.store.listWorkspaces(cloudActor(c)) }));
  route.post('/cloud/workspaces', async (c) => {
    const actor = cloudActor(c); const body = await cloudJson(c, allowedOrigins);
    return c.json({ workspace: await service.store.createWorkspace(actor, body.name) }, 201);
  });
  route.get('/cloud/workspaces/:id/uploads',async c=>c.json({uploads:await service.listUploads(cloudActor(c),c.req.param('id'))}));
  route.post('/cloud/workspaces/:id/uploads',async c=>{
    const actor=cloudActor(c),body=await cloudJson(c,allowedOrigins);
    return c.json({upload:await service.createUpload(actor,c.req.param('id'),body)},201);
  });
  route.get('/cloud/uploads/:id',async c=>c.json({upload:await service.uploadStatus(cloudActor(c),c.req.param('id'))}));
  route.put('/cloud/uploads/:id/chunks/:index',async c=>{
    const actor=cloudActor(c),rawIndex=c.req.param('index');
    if (!/^(0|[1-9][0-9]*)$/.test(rawIndex)) throw new CloudWorkspaceError('invalid_chunk_index');
    await service.uploadStatus(actor,c.req.param('id'));
    const bytes=await cloudBinary(c,allowedOrigins);
    return c.json({upload:await service.uploadChunk(actor,c.req.param('id'),Number(rawIndex),bytes,c.req.header('x-chunk-sha256') || '')});
  });
  route.post('/cloud/uploads/:id/complete',async c=>{
    const actor=cloudActor(c); await cloudJson(c,allowedOrigins);
    return c.json(await service.completeUpload(actor,c.req.param('id')));
  });
  route.post('/cloud/uploads/:id/cancel',async c=>{
    const actor=cloudActor(c); await cloudJson(c,allowedOrigins);
    return c.json({upload:await service.cancelUpload(actor,c.req.param('id'))});
  });
  route.get('/cloud/workspaces/:id/files', async (c) => c.json({ files: await service.store.listFiles(cloudActor(c), c.req.param('id')) }));
  route.post('/cloud/workspaces/:id/files', async (c) => {
    const actor = cloudActor(c); const body = await cloudJson(c, allowedOrigins);
    return c.json(await service.upload(actor, c.req.param('id'), body.name, decode(body.contentBase64)), 201);
  });
  route.get('/cloud/files/:id/versions', async (c) => c.json({ versions: await service.store.versions(cloudActor(c), c.req.param('id')) }));
  route.get('/cloud/files/:id', async (c) => c.json({ file: await service.store.fileSummary(cloudActor(c), c.req.param('id')) }));
  route.post('/cloud/files/:id/versions', async (c) => {
    const actor = cloudActor(c); const body = await cloudJson(c, allowedOrigins);
    const file = await service.store.file(actor, c.req.param('id'));
    return c.json(await service.upload(actor, file.workspace_id, file.name, decode(body.contentBase64), file.id, body.expectedVersion), 201);
  });
  route.get('/cloud/versions/:id/content', async (c) => {
    const { bytes, version } = await service.read(cloudActor(c), c.req.param('id'));
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    c.header('Cache-Control', 'private, no-store');
    c.header('Content-Length', String(bytes.length));
    c.header('ETag', `"${version.id}"`);
    if (c.req.query('download') === '1') c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(version.name)}`);
    return c.body(new Uint8Array(bytes));
  });
  route.get('/cloud/workspaces/:id/runs', async (c) => c.json({ runs: await service.store.listRuns(cloudActor(c), c.req.param('id')) }));
  route.post('/cloud/workspaces/:id/runs', async (c) => {
    const actor = cloudActor(c); const body = await cloudJson(c, allowedOrigins);
    if (!['document-summary','agent-summary','agent-task'].includes(body.operation)) throw new CloudWorkspaceError('unsupported_operation');
    await validateScheduledInput(actor,c.req.param('id'),body.inputVersion,body.operation);
    if (body.operation !== 'document-summary') await requireAgent(c, actor);
    return c.json({ run: await service.store.createRun(actor, c.req.param('id'), body.inputVersion, body.requestKey, body.operation) }, 202);
  });
  route.get('/cloud/runs/:id', async (c) => c.json(await service.store.run(cloudActor(c), c.req.param('id'))));
  route.get('/cloud/workspaces/:id/records', async c => c.json({ records: await records.list(cloudActor(c),c.req.param('id'),c.req.query('kind')) }));
  route.post('/cloud/workspaces/:id/records', async c => {
    const actor = cloudActor(c), body = await cloudJson(c,allowedOrigins);
    return c.json({ record: await records.create(actor,c.req.param('id'),body.kind,body.title,body.data) },201);
  });
  route.get('/cloud/records/:id', async c => c.json({ record: await records.get(cloudActor(c),c.req.param('id')) }));
  route.put('/cloud/records/:id', async c => {
    const actor = cloudActor(c), body = await cloudJson(c,allowedOrigins);
    return c.json({ record: await records.update(actor,c.req.param('id'),body.expectedVersion,body.data,body.title) });
  });
  route.post('/cloud/records/:id/messages', async c => {
    const actor = cloudActor(c), body = await cloudJson(c,allowedOrigins);
    if (!principalHasScope(c.get('authPrincipal' as never),'chat')) throw new CloudWorkspaceError('chat_scope_required',403);
    const availability = service.agentExecutor && await service.agentExecutor.availability(actor);
    if (!availability?.available) throw new CloudWorkspaceError(availability?.reason || 'model_not_configured',503);
    return c.json(await records.message(actor,c.req.param('id'),body),202);
  });
  route.get('/cloud/workspaces/:id/task-plans', async c => c.json({ plans: await tasks.list(cloudActor(c), c.req.param('id')) }));
  route.post('/cloud/workspaces/:id/task-plans', async c => {
    const actor = cloudActor(c), body = await cloudJson(c, allowedOrigins);
    return c.json({ plan: await tasks.create(actor, c.req.param('id'), body) }, 201);
  });
  route.get('/cloud/runs/:id/task-session', async c => c.json({ session: await tasks.session(cloudActor(c), c.req.param('id')) }));
  route.post('/cloud/runs/:id/retry',async c=>{
    const actor=cloudActor(c),body=await cloudJson(c,allowedOrigins);
    const {run}=await service.store.run(actor,c.req.param('id'));
    if (run.operation==='agent-conversation') throw new CloudWorkspaceError('run_not_retryable',409);
    await validateScheduledInput(actor,run.workspace_id,run.input_version,run.operation);
    if (run.operation!=='document-summary') await requireAgent(c,actor);
    return c.json({run:await service.store.retryRun(actor,c.req.param('id'),body.requestKey)},202);
  });
  route.post('/cloud/runs/:id/cancel', async c => {
    const actor = cloudActor(c); await cloudJson(c, allowedOrigins);
    return c.json({ run: await service.store.cancelRun(actor, c.req.param('id')) });
  });
  route.get('/cloud/workspaces/:id/schedules', async c => c.json({ schedules: await service.store.listSchedules(cloudActor(c), c.req.param('id')) }));
  route.post('/cloud/workspaces/:id/schedules', async c => {
    const actor = cloudActor(c), body = await cloudJson(c, allowedOrigins);
    await validateScheduledInput(actor, c.req.param('id'), body.inputVersion, body.operation);
    if (body.enabled === true && body.operation !== 'document-summary') await requireAgent(c, actor);
    return c.json({ schedule: await service.store.createSchedule(actor, c.req.param('id'), body) }, 201);
  });
  route.put('/cloud/schedules/:id', async c => {
    const actor = cloudActor(c), body = await cloudJson(c, allowedOrigins);
    const schedule = await service.store.schedule(actor, c.req.param('id'));
    if (body.enabled === true) {
      await validateScheduledInput(actor, schedule.workspace_id, schedule.input_version, schedule.operation);
      if (schedule.operation !== 'document-summary') await requireAgent(c, actor);
    }
    return c.json({ schedule: await service.store.setScheduleEnabled(actor, c.req.param('id'), body.expectedRevision, body.enabled) });
  });
  route.get('/cloud/workspaces/:id/events', async (c) => {
    const after = Number(c.req.query('after') || 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new CloudWorkspaceError('invalid_cursor');
    return c.json(await service.store.events(cloudActor(c), c.req.param('id'), after));
  });
  return route;
}
