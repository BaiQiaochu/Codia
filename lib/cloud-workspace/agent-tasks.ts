import crypto from 'node:crypto';
import { CloudWorkspaceError, validName, type CloudActor, type CloudRow } from './store.ts';
import type { CloudWorkspaceService } from './service.ts';

export const CLOUD_TASK_TOOLS = ['list_cloud_files', 'read_cloud_file', 'create_artifact'] as const;
export const CLOUD_TASK_INPUT_LIMIT = 128 * 1024;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const digest = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
export interface CloudTaskPlan {
  schemaVersion: 1; type: 'cloud-agent-task'; title: string; instruction: string;
  inputVersions: string[]; sourceWorkflowVersion?: string; createdAt: string;
}
export interface CloudTaskInput extends CloudTaskPlan {
  files: { versionId: string; name: string; text: string; sha256: string }[];
}
export interface CloudTaskSession {
  schemaVersion: 1; runId: string; attempt: number; inputVersion: string; sourceWorkflowVersion?: string; finalText: string; inputVersions: string[];
  messages: { role: string; text: string; toolName?: string; toolCallId?: string; isError?: boolean }[];
  artifacts: { id: string; name: string; content: string; size: number; sha256: string }[];
}
export function parseTaskPlan(bytes: Buffer): CloudTaskPlan {
  let value: CloudTaskPlan;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new CloudWorkspaceError('invalid_task_plan'); }
  if (value?.schemaVersion !== 1 || value.type !== 'cloud-agent-task' || typeof value.instruction !== 'string' || !value.instruction.trim() || value.instruction.length > 16000
    || !Array.isArray(value.inputVersions) || value.inputVersions.length > 8 || value.inputVersions.some(v => !uuid(v)) || new Set(value.inputVersions).size !== value.inputVersions.length
    || (value.sourceWorkflowVersion !== undefined && !uuid(value.sourceWorkflowVersion))) throw new CloudWorkspaceError('invalid_task_plan');
  let title: string;
  try { title = validName(value.title); if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw new Error(); } catch { throw new CloudWorkspaceError('invalid_task_plan'); }
  return { schemaVersion: 1, type: 'cloud-agent-task', title, instruction: value.instruction, inputVersions: value.inputVersions,
    ...(value.sourceWorkflowVersion ? { sourceWorkflowVersion: value.sourceWorkflowVersion } : {}), createdAt: value.createdAt };
}
function planSummary(file: CloudRow, plan: CloudTaskPlan) {
  return { id: file.id, title: plan.title, currentVersion: file.current_version, workspaceId: file.workspace_id, instruction: plan.instruction,
    inputVersions: plan.inputVersions, ...(plan.sourceWorkflowVersion ? { sourceWorkflowVersion: plan.sourceWorkflowVersion } : {}), createdAt: plan.createdAt, updatedAt: plan.createdAt };
}
function fingerprint(plan: CloudTaskPlan) { return JSON.stringify([plan.title, plan.instruction, plan.inputVersions, plan.sourceWorkflowVersion ?? null]); }

/** Explicit opt-in conversion: only the saved instruction and selected immutable versions gain authority.
 * Legacy schedule status, arbitrary steps, scripts, paths and embedded tool settings are never executed. */
export class CloudTaskService {
  constructor(private service: CloudWorkspaceService) {}
  async list(actor: CloudActor, workspaceId: string) {
    const files = await this.service.store.listFiles(actor, workspaceId);
    const plans = [];
    for (const file of files.filter(file => /^task-plan-[a-f0-9]{64}\.json$/.test(file.name))) {
      try { plans.push(planSummary(file, parseTaskPlan((await this.service.read(actor, file.current_version)).bytes))); }
      catch (error) { if (error instanceof CloudWorkspaceError && error.code === 'invalid_task_plan') continue; throw error; }
    }
    return plans;
  }
  async create(actor: CloudActor, workspaceId: string, input: Record<string, unknown>) {
    await this.service.store.workspace(actor, workspaceId);
    if (typeof input.requestKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestKey)) throw new CloudWorkspaceError('invalid_request_key');
    let instruction = input.instruction;
    if (input.sourceWorkflowVersion !== undefined) {
      if (!uuid(input.sourceWorkflowVersion)) throw new CloudWorkspaceError('invalid_task_plan');
      const source = await this.service.read(actor, input.sourceWorkflowVersion);
      if (source.version.workspace_id !== workspaceId) throw new CloudWorkspaceError('not_found', 404);
      let record: { schemaVersion?: unknown; kind?: unknown; data?: { instruction?: unknown } };
      try { record = JSON.parse(source.bytes.toString('utf8')); } catch { throw new CloudWorkspaceError('invalid_workflow'); }
      if (record?.schemaVersion !== 1 || record.kind !== 'workflow') throw new CloudWorkspaceError('invalid_workflow');
      if (instruction === undefined) instruction = record.data?.instruction;
    }
    const candidate = { schemaVersion: 1, type: 'cloud-agent-task', title: validName(input.title), instruction,
      inputVersions: input.inputVersions ?? [], ...(input.sourceWorkflowVersion ? { sourceWorkflowVersion: input.sourceWorkflowVersion } : {}), createdAt: new Date().toISOString() };
    const plan = parseTaskPlan(Buffer.from(JSON.stringify(candidate)));
    // Authorize and bound every selected version before creating any object or metadata.
    await this.prepare(actor, workspaceId, plan);
    const name = `task-plan-${digest(`${workspaceId}:${input.requestKey}`)}.json`;
    const existing = (await this.service.store.listFiles(actor, workspaceId)).find(file => file.name === name);
    if (existing) {
      const previous = parseTaskPlan((await this.service.read(actor, existing.current_version)).bytes);
      if (fingerprint(plan) !== fingerprint(previous)) throw new CloudWorkspaceError('idempotency_conflict', 409);
      return planSummary(existing, previous);
    }
    try {
      const saved = await this.service.upload(actor, workspaceId, name, Buffer.from(JSON.stringify(plan)));
      return planSummary(saved.file, plan);
    } catch (error) {
      if (error instanceof CloudWorkspaceError && error.code === 'file_name_exists') throw new CloudWorkspaceError('task_plan_pending', 409);
      throw error;
    }
  }
  async prepare(actor: CloudActor, workspaceId: string, plan: CloudTaskPlan): Promise<CloudTaskInput> {
    await this.service.store.workspace(actor, workspaceId);
    if (plan.sourceWorkflowVersion) {
      const source = await this.service.read(actor, plan.sourceWorkflowVersion);
      if (source.version.workspace_id !== workspaceId) throw new CloudWorkspaceError('not_found', 404);
      let workflow: { schemaVersion?: unknown; kind?: unknown };
      try { workflow = JSON.parse(source.bytes.toString('utf8')); } catch { throw new CloudWorkspaceError('invalid_workflow'); }
      if (workflow?.schemaVersion !== 1 || workflow.kind !== 'workflow') throw new CloudWorkspaceError('invalid_workflow');
    }
    let size = Buffer.byteLength(plan.instruction);
    const files: CloudTaskInput['files'] = [];
    for (const versionId of plan.inputVersions) {
      const { bytes, version } = await this.service.read(actor, versionId);
      if (version.workspace_id !== workspaceId) throw new CloudWorkspaceError('not_found', 404);
      size += bytes.length;
      if (size > CLOUD_TASK_INPUT_LIMIT) throw new CloudWorkspaceError('agent_input_too_large', 413);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.includes('\0')) throw new Error(); }
      catch { throw new CloudWorkspaceError('unsupported_document'); }
      files.push({ versionId, name: version.name, text, sha256: version.sha256 });
    }
    return { ...plan, files };
  }
  async validateVersion(actor: CloudActor, workspaceId: string, versionId: string) {
    const source = await this.service.read(actor, versionId);
    if (source.version.workspace_id !== workspaceId || !/^task-plan-[a-f0-9]{64}\.json$/.test(source.version.name)) throw new CloudWorkspaceError('invalid_task_plan');
    const plan = parseTaskPlan(source.bytes);
    await this.prepare(actor, workspaceId, plan);
    return plan;
  }
  async session(actor: CloudActor, runId: string) {
    const detail = await this.service.store.run(actor, runId);
    if (detail.run.operation !== 'agent-task') throw new CloudWorkspaceError('not_a_tool_task');
    if (detail.run.status !== 'succeeded' || !detail.artifacts[0]) throw new CloudWorkspaceError('task_not_complete', 409);
    return validateTaskSession((await this.service.read(actor, detail.artifacts[0].version_id)).bytes, detail.run);
  }
}

/** Never trust child output to choose filesystem keys, authority, tool capabilities or unbounded content. */
export function validateTaskSession(bytes: Buffer, run: CloudRow): CloudTaskSession {
  if (bytes.length > 1536 * 1024) throw new CloudWorkspaceError('task_output_invalid');
  let session: CloudTaskSession;
  try { session = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new CloudWorkspaceError('task_output_invalid'); }
  if (session?.schemaVersion !== 1 || session.runId !== run.id || session.attempt !== run.attempt || session.inputVersion !== run.input_version || typeof session.finalText !== 'string' || !session.finalText.trim() || Buffer.byteLength(session.finalText) > 256 * 1024
    || !Array.isArray(session.messages) || session.messages.length > 96 || !Array.isArray(session.artifacts) || session.artifacts.length > 8
    || !Array.isArray(session.inputVersions) || session.inputVersions.length > 8 || session.inputVersions.some(v => !uuid(v))) throw new CloudWorkspaceError('task_output_invalid');
  const rootKeys = ['schemaVersion','runId','attempt','inputVersion','sourceWorkflowVersion','finalText','inputVersions','messages','artifacts'];
  if (Object.keys(session).some(key => !rootKeys.includes(key)) || (session.sourceWorkflowVersion !== undefined && !uuid(session.sourceWorkflowVersion))) throw new CloudWorkspaceError('task_output_invalid');
  const artifacts = new Set<string>(), names = new Set<string>(); let total = 0;
  for (const item of session.artifacts) {
    if (!item || Object.keys(item).some(key => !['id','name','content','size','sha256'].includes(key)) || typeof item.id !== 'string' || !/^artifact-[1-8]$/.test(item.id) || artifacts.has(item.id) || typeof item.content !== 'string') throw new CloudWorkspaceError('task_output_invalid');
    try { validName(item.name); } catch { throw new CloudWorkspaceError('task_output_invalid'); }
    if (names.has(item.name) || Buffer.byteLength(item.content) > 64 * 1024 || item.size !== Buffer.byteLength(item.content) || item.sha256 !== digest(item.content)) throw new CloudWorkspaceError('task_output_invalid');
    total += item.size; artifacts.add(item.id); names.add(item.name);
  }
  if (total > 256 * 1024) throw new CloudWorkspaceError('task_output_invalid');
  for (const item of session.messages) {
    if (!item || Object.keys(item).some(key => !['role','text','toolName','toolCallId','isError'].includes(key)) || (item.isError !== undefined && typeof item.isError !== 'boolean') || !['user','assistant','toolCall','toolResult'].includes(item.role) || typeof item.text !== 'string' || Buffer.byteLength(item.text) > 128 * 1024
      || (item.toolName !== undefined && !(CLOUD_TASK_TOOLS as readonly string[]).includes(item.toolName))
      || (item.toolCallId !== undefined && (typeof item.toolCallId !== 'string' || item.toolCallId.length > 160))) throw new CloudWorkspaceError('task_output_invalid');
  }
  return session;
}
