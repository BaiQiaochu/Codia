import crypto from 'node:crypto';
import { CloudWorkspaceError, validName, type CloudActor, type CloudRow } from './store.ts';
import type { CloudWorkspaceService } from './service.ts';
export const CLOUD_RECORD_KINDS = ['conversation','workflow','business'] as const;
export type CloudRecordKind = typeof CLOUD_RECORD_KINDS[number];
export type CloudMessage = { id: string; role: 'user' | 'assistant'; text: string; createdAt: string; runId?: string };
type RecordEnvelope = { schemaVersion: 1; id: string; kind: CloudRecordKind; title: string; data: Record<string, any>; createdAt: string; updatedAt: string };
export type CloudRecord = RecordEnvelope & { currentVersion: string; workspaceId: string; pendingRuns?: CloudRow[] };
const isRecordName = (name: string) => /^record-(conversation|workflow|business)-[A-Za-z0-9-]+\.json$/.test(name);
function dataObject(data: unknown, limit = 120 * 1024): asserts data is Record<string, any> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CloudWorkspaceError('invalid_record_data');
  if (Buffer.byteLength(JSON.stringify(data)) > limit) throw new CloudWorkspaceError('record_too_large', 413);
}
function kindValue(kind: unknown): asserts kind is CloudRecordKind {
  if (!CLOUD_RECORD_KINDS.includes(kind as CloudRecordKind)) throw new CloudWorkspaceError('invalid_record_kind');
}
function messagesFromData(data: Record<string, any>): CloudMessage[] {
  if (Array.isArray(data.messages)) return data.messages.filter((m: any) => m && ['user','assistant'].includes(m.role) && typeof m.text === 'string' && typeof m.id === 'string');
  // Legacy SDK snapshots keep their original tree in data.content. Read only text message entries.
  const source = Array.isArray(data.content) ? data.content : Array.isArray(data.content?.messages) ? data.content.messages : [];
  return source.flatMap((entry: any, i: number) => {
    const m = entry?.message || entry;
    if (!m || !['user','assistant'].includes(m.role)) return [];
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n') : typeof m.text === 'string' ? m.text : '';
    return text ? [{ id: entry.id || `legacy-${i}`, role: m.role, text, createdAt: typeof m.timestamp === 'number' ? new Date(m.timestamp).toISOString() : entry.timestamp || '' }] : [];
  });
}
/** Versioned domain records share the same authenticated authority and immutable object boundary as files. */
export class CloudRecordService {
  private service: CloudWorkspaceService;
  constructor(service: CloudWorkspaceService) { this.service = service; }
  private decode(bytes: Buffer): RecordEnvelope {
    try {
      const value = JSON.parse(bytes.toString('utf8')); kindValue(value.kind); dataObject(value.data, 2 * 1024 * 1024);
      if (value.schemaVersion !== 1 || typeof value.title !== 'string') throw new Error();
      return value;
    } catch { throw new CloudWorkspaceError('invalid_record', 409); }
  }
  private async raw(actor: CloudActor, recordId: string): Promise<CloudRecord> {
    const file = await this.service.store.file(actor, recordId);
    if (!isRecordName(file.name)) throw new CloudWorkspaceError('not_found',404);
    const read = await this.service.read(actor, file.current_version);
    return { ...this.decode(read.bytes), id: file.id, currentVersion: read.version.id, workspaceId: file.workspace_id };
  }
  async list(actor: CloudActor, workspaceId: string, kind?: string) {
    if (kind !== undefined) kindValue(kind);
    const files = await this.service.store.listFiles(actor, workspaceId);
    const records: Omit<CloudRecord,'data'>[] = [];
    for (const file of files) {
      if (!isRecordName(file.name)) continue;
      let record: CloudRecord;
      try { record = await this.raw(actor, file.id); } catch (error) { if (error instanceof CloudWorkspaceError && error.code === 'invalid_record') continue; throw error; }
      if (kind && record.kind !== kind) continue;
      const { data: _data, ...summary } = record; records.push(summary);
    }
    return records;
  }
  async create(actor: CloudActor, workspaceId: string, kind: unknown, title: unknown, data: unknown) {
    kindValue(kind); dataObject(data);
    const id = crypto.randomUUID(), timestamp = new Date().toISOString();
    const envelope: RecordEnvelope = { schemaVersion: 1, id, kind, title: validName(title), data, createdAt: timestamp, updatedAt: timestamp };
    const result = await this.service.upload(actor, workspaceId, `record-${kind}-${id}.json`, Buffer.from(JSON.stringify(envelope)));
    return this.get(actor, result.file.id);
  }
  async update(actor: CloudActor, recordId: string, expectedVersion: string, data: unknown, title?: unknown) {
    dataObject(data);
    const current = await this.raw(actor, recordId);
    if (current.currentVersion !== expectedVersion) throw new CloudWorkspaceError('version_conflict',409);
    const file = await this.service.store.file(actor, recordId);
    const envelope: RecordEnvelope = { schemaVersion: 1, id: current.id, kind: current.kind, title: title === undefined ? current.title : validName(title), data, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
    await this.service.upload(actor,current.workspaceId,file.name,Buffer.from(JSON.stringify(envelope)),recordId,expectedVersion);
    return this.get(actor,recordId);
  }
  async get(actor: CloudActor, recordId: string): Promise<CloudRecord> {
    const record = await this.raw(actor,recordId);
    if (record.kind !== 'conversation') return record;
    const messages = messagesFromData(record.data);
    const ids = new Set(messages.map(message => message.id));
    const pendingRuns: CloudRow[] = [];
    const runs = await this.service.store.listRuns(actor,record.workspaceId);
    for (const run of runs.filter(run => run.operation === 'agent-conversation').reverse()) {
      const input = await this.service.store.version(actor,run.input_version);
      if (input.file_id !== recordId) continue;
      const snapshot = this.decode((await this.service.read(actor,run.input_version)).bytes);
      const lastUser = messagesFromData(snapshot.data).filter(m => m.role === 'user').at(-1);
      if (!lastUser || !messages.some(m => m.id === lastUser.id && m.text === lastUser.text)) continue;
      if (run.status !== 'succeeded') { pendingRuns.push(run); continue; }
      const assistantId = `run-${run.id}`;
      if (ids.has(assistantId)) continue;
      const detail = await this.service.store.run(actor,run.id);
      const artifact = detail.artifacts[0];
      if (!artifact) continue;
      const output = await this.service.read(actor,artifact.version_id);
      const after = messages.findIndex(m => m.id === lastUser.id);
      messages.splice(after + 1,0,{ id: assistantId, role:'assistant', text:output.bytes.toString('utf8'), createdAt:run.updated_at, runId:run.id });
      ids.add(assistantId);
    }
    return { ...record, data: { ...record.data, messages }, pendingRuns };
  }
  async message(actor: CloudActor, recordId: string, input: {text:unknown; expectedVersion:unknown; requestKey:unknown}) {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000) throw new CloudWorkspaceError('invalid_message');
    if (typeof input.requestKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestKey)) throw new CloudWorkspaceError('invalid_request_key');
    const record = await this.get(actor,recordId);
    if (record.kind !== 'conversation') throw new CloudWorkspaceError('not_a_conversation');
    const messageId = `message-${input.requestKey}`;
    const requestKey = `conversation-${crypto.createHash('sha256').update(`${recordId}:${input.requestKey}`).digest('hex')}`;
    const existing = messagesFromData(record.data).find(message => message.id === messageId);
    if (existing) {
      if (existing.text !== input.text) throw new CloudWorkspaceError('idempotency_conflict',409);
      const versions = await this.service.store.versions(actor,recordId);
      for (const version of versions) {
        const snapshot = this.decode((await this.service.read(actor,version.id)).bytes);
        if (messagesFromData(snapshot.data).at(-1)?.id === messageId) {
          const run = await this.service.store.createRun(actor,record.workspaceId,version.id,requestKey,'agent-conversation');
          return { record: await this.get(actor,recordId), run };
        }
      }
      throw new CloudWorkspaceError('conversation_retry_conflict',409);
    }
    if (record.currentVersion !== input.expectedVersion) throw new CloudWorkspaceError('version_conflict',409);
    if (record.pendingRuns?.some(run => run.status === 'queued' || run.status === 'running')) throw new CloudWorkspaceError('conversation_busy',409);
    const message: CloudMessage = { id:messageId, role:'user', text:input.text, createdAt:new Date().toISOString() };
    const file = await this.service.store.file(actor,recordId);
    const envelope: RecordEnvelope = { schemaVersion:1,id:record.id,kind:record.kind,title:record.title,createdAt:record.createdAt,updatedAt:new Date().toISOString(),data:{ ...record.data,messages:[...messagesFromData(record.data),message] } };
    dataObject(envelope.data);
    // The ready version, message pointer, run and outbox entry share one DB transaction.
    // Object bytes are staged first and remain invisible if this transaction fails.
    const result = await this.service.upload(actor,record.workspaceId,file.name,Buffer.from(JSON.stringify(envelope)),recordId,record.currentVersion,{requestKey:requestKey,operation:'agent-conversation'});
    return { record: await this.get(actor,recordId), run:result.run };
  }
}
