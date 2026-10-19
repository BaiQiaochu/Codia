import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
vi.mock('../core/llm-client.ts', () => ({ callText: vi.fn() }));
import { callText } from '../core/llm-client.ts';
import { FactStore } from '../lib/memory/fact-store.ts';
import { SessionSummaryManager } from '../lib/memory/session-summary.ts';
import { processDirtySessions } from '../lib/memory/deep-memory.ts';
import { compileToday, compileWeek, compileLongterm, compileFacts, compileEditableFacts } from '../lib/memory/compile.ts';
import { clearCompiledMemoryArtifacts, writeCompiledResetMarker, isCompiledMemoryEligible } from '../lib/memory/compiled-memory-state.ts';
import { cacheSnapshotObservationPath, writeCacheSnapshotObservation, readCacheSnapshotObservation } from '../lib/memory/cache-snapshot-observation.ts';
import { scrubMemorySecrets } from '../lib/memory/memory-lifecycle.ts';
const model = { model:'m',api:'openai-completions',api_key:'x',base_url:'http://invalid' };
let root:string, memory:string, store:FactStore, manager:SessionSummaryManager;
beforeEach(() => {
  root=fs.mkdtempSync(path.join(os.tmpdir(),'memory-lifecycle-')); memory=path.join(root,'memory'); fs.mkdirSync(memory);
  store=new FactStore(path.join(memory,'facts.db')); manager=new SessionSummaryManager(path.join(memory,'summaries')); vi.mocked(callText).mockReset();
});
afterEach(() => { store?.close(); fs.rmSync(root,{recursive:true,force:true}); });
function summary(text='### Key Facts\nThe user likes tea\n\n### Events\nDiscussed tea') {
  const now=new Date().toISOString(); const data={session_id:'s1',summary:text,snapshot:'',created_at:now,updated_at:now,sourceRefs:[{kind:'message',messageId:'m1',author:'user'}]};
  manager.saveSummary('s1',data); return data;
}

describe('trusted memory lifecycle', () => {
  it('persists provenance, scope, revision and excludes conflicts/candidates/expired/future facts before limit', () => {
    const now='2026-10-19T12:00:00.000Z';
    for (let i=0;i<30;i++) store.add({fact:`alpha token ${i}`,tags:['token'],projectId:'alpha',observedAt:'2026-10-01'});
    store.add({fact:'global token',tags:['token'],observedAt:'2026-10-01'});
    const {id}=store.add({fact:'beta token',tags:['token'],projectId:'beta',sourceRefs:[{kind:'message',messageId:'m1',runId:'run1',revision:'r1'}],observedAt:'2026-10-01'});
    for (const entry of [{fact:'expired token',expiresAt:now},{fact:'future token',observedAt:'2027-01-01'},{fact:'conflict token',status:'conflict'},{fact:'candidate token',status:'candidate'}]) store.add({tags:['token'],observedAt:'2026-10-01',...entry});
    expect(store.searchByTags(['token'],null,2,{projectId:'beta',now}).map(f=>f.fact).sort()).toEqual(['beta token','global token']);
    expect(store.searchFullText('token',2,{projectId:'beta',now})).toHaveLength(2);
    expect(store.searchFullText('token',20,{now}).map(f=>f.fact)).toEqual(['global token']);
    expect(store.getById(id)).toMatchObject({scope:'project',projectId:'beta',revision:1,sourceRefs:[{messageId:'m1',runId:'run1',revision:'r1'}]});
  });
  it('filters channel rows before LIMIT including migrated channel-* source IDs', () => {
    for(let i=0;i<30;i++) store.add({fact:`pizza elsewhere ${i}`,tags:['pizza'],session_id:'channel-beta'});
    store.add({fact:'pizza here',tags:['pizza'],session_id:'channel-alpha'});
    expect(store.searchByTags(['pizza'],null,1,{channelId:'alpha'}).map(f=>f.fact)).toEqual(['pizza here']);
    expect(store.searchFullText('pizza',1,{channelId:'alpha'}).map(f=>f.fact)).toEqual(['pizza here']);
  });
  it('correction invalidates all summaries/editable artifacts and rejects stale editor revision', () => {
    summary();
    for(const name of ['memory.md','today.md','week.md','longterm.md','facts.md','editable-facts.md','editable-facts-state.json']) fs.writeFileSync(path.join(memory,name),'old');
    const {id}=store.add({fact:'old preference',session_id:'s1'}); const first=store.getById(id);
    const changed=store.update(id,{fact:'new preference'},first.revision).memory;
    expect(changed.revision).toBe(2); expect(store.update(id,{fact:'stale'},first.revision).error).toBe('conflict');
    expect(manager.getSummary('s1')).toBeNull(); expect(fs.readFileSync(path.join(memory,'editable-facts.md'),'utf8')).toBe('');
    expect(fs.existsSync(path.join(memory,'editable-facts-state.json'))).toBe(false);
    expect(store.add({fact:'old preference',session_id:'s1'})).toMatchObject({skipped:true,reason:'revoked'});
    expect(store.searchFullText('new preference')).toHaveLength(1);
  });
  it('restoring a DB-only backup replays scoped tombstones without deleting identical text in another project', async () => {
    const a=store.add({fact:'same text',projectId:'a'}); store.add({fact:'same text',projectId:'b'});
    const backup=path.join(root,'backup.db'); await (store as any).db.backup(backup);
    const exported=store.exportAll(); store.delete(a.id); store.close();
    fs.copyFileSync(backup,path.join(memory,'facts.db')); store=new FactStore(path.join(memory,'facts.db'));
    expect(store.getAll().map(f=>f.projectId)).toEqual(['b']);
    store.importAll(exported); expect(store.getAll().map(f=>f.projectId)).toEqual(['b']);
    expect(fs.readFileSync(path.join(memory,'lifecycle.json'),'utf8')).not.toContain('same text');
  });
  it('forgetting and compiled-only clearing both remove reflection previews while leaving source documents alone', () => {
    fs.writeFileSync(path.join(root,'diary.md'),'user document');
    writeCacheSnapshotObservation(root,{summaryPreview:'old summary',memoryMdPreview:'old memory',status:'success'});
    const {id}=store.add({fact:'old memory'});store.delete(id);
    expect(readCacheSnapshotObservation(root)).toBeNull();
    writeCacheSnapshotObservation(root,{summaryPreview:'later summary',memoryMdPreview:'later memory',status:'success'});
    writeCompiledResetMarker(memory);clearCompiledMemoryArtifacts(memory);
    expect(fs.existsSync(cacheSnapshotObservationPath(root))).toBe(false);
    expect(fs.readFileSync(path.join(root,'diary.md'),'utf8')).toBe('user document');
  });
  it('clear blocks old exports and old summary cache after restart', () => {
    summary(); store.add({fact:'forgotten',session_id:'s1'}); const old=store.exportAll(); store.clearAll();
    store.close(); store=new FactStore(path.join(memory,'facts.db')); expect(store.importAll(old)).toBe(0);
    expect(store.getAll()).toEqual([]); expect(manager.getAllSummaries()).toEqual([]);
  });
  it('scrubs credential values and private key bodies from facts, tags and provenance', () => {
    const secret='sk-proj-abcdefgh1234567890123456'; const {id}=store.add({fact:`api_key=${secret}`,tags:[`password=hunter2`],sourceRefs:[{kind:'message',messageId:'m1',excerpt:'verification code: 123456'}]});
    const encoded=JSON.stringify(store.getById(id)); expect(encoded).not.toContain(secret);expect(encoded).not.toContain('hunter2'); expect(encoded).not.toContain('123456');
    expect(scrubMemorySecrets('-----BEGIN PRIVATE KEY-----\nSECRETKEYBODY\n-----END PRIVATE KEY-----')).not.toContain('SECRETKEYBODY');
    const privateKey = store.add({fact:'-----BEGIN PRIVATE KEY-----\nSECRETKEYBODY\n-----END PRIVATE KEY-----'});
    expect(store.getById(privateKey.id).fact).not.toContain('SECRETKEYBODY');
    expect(scrubMemorySecrets('OTP:482913')).not.toContain('482913');
  });
  it('compiled canonical facts exclude project facts, candidates and expire at the earliest validity boundary', async () => {
    store.add({fact:'global tea',expiresAt:'2099-01-01'});store.add({fact:'project secret',projectId:'alpha'});store.add({fact:'channel secret',session_id:'channel-alpha'});store.add({fact:'candidate tea',status:'candidate'});
    await compileFacts(manager,path.join(memory,'facts.md'),model,{factStore:store});
    const text=fs.readFileSync(path.join(memory,'facts.md'),'utf8');expect(text).toContain('global tea'); expect(text).not.toContain('project secret');expect(text).not.toContain('channel secret');expect(text).not.toContain('candidate tea');
    expect(isCompiledMemoryEligible(memory,'2099-01-02T00:00:00.000Z')).toBe(false);
  });
});

describe('persistent extraction receipts', () => {
  it('invalid JSON fails truthfully, persists across restart, quarantines, and requires an explicit retry', async () => {
    summary(); vi.mocked(callText).mockResolvedValue('not json');
    let result=await processDirtySessions(manager,store,model,{now:'2026-10-19T12:00:00Z'});
    expect(result).toMatchObject({processed:0,succeeded:0,failed:1,factsAdded:0});expect(manager.getDirtySessions()).toHaveLength(1);
    store.close(); store=new FactStore(path.join(memory,'facts.db'));
    expect(store.getExtractionJobs()[0]).toMatchObject({status:'failed',attempts:1});
    await processDirtySessions(manager,store,model,{now:'2026-10-19T12:02:00Z'});
    result=await processDirtySessions(manager,store,model,{now:'2026-10-19T12:05:00Z'});
    expect(result.quarantined).toBe(1); expect(store.getExtractionJobs()[0].status).toBe('quarantined');
    const count=vi.mocked(callText).mock.calls.length;await processDirtySessions(manager,store,model,{now:'2026-10-20T12:00:00Z'});expect(vi.mocked(callText).mock.calls.length).toBe(count);
    expect(store.retryExtraction(store.getExtractionJobs()[0].key)).toEqual({ok:true});
    vi.mocked(callText).mockResolvedValue('[]');result=await processDirtySessions(manager,store,model);
    expect(result).toMatchObject({processed:1,succeeded:1,failed:0,factsAdded:0});expect(manager.getDirtySessions()).toEqual([]);
  });
  it('partial malformed arrays fail rather than silently accepting a subset', async () => {
    summary();vi.mocked(callText).mockResolvedValue('[{"fact":"valid"},{"fact":42}]');
    expect((await processDirtySessions(manager,store,model)).failed).toBe(1);expect(store.size).toBe(0);
  });
  it('a failed summary cache commit reconciles using the durable receipt without a duplicate model call', async () => {
    summary();vi.mocked(callText).mockResolvedValue('[{"fact":"user likes tea","tags":["tea"]}]');
    const mark=vi.spyOn(manager,'markProcessed').mockImplementationOnce(()=>{throw new Error('disk fault');});
    expect((await processDirtySessions(manager,store,model)).factsAdded).toBe(1);expect(store.getAll()[0].status).toBe('candidate');
    expect((await processDirtySessions(manager,store,model)).skipped).toBe(1);expect(store.size).toBe(1);expect(callText).toHaveBeenCalledTimes(1);expect(mark).toHaveBeenCalledTimes(2);
  });
  it('fact insertions and the extraction success receipt are atomic', () => {
    const claim=store.beginExtraction('key',{sessionId:'s',sourceRevision:'r',extractorVersion:'v'});
    expect(()=>store.commitExtraction('key',[{fact:'valid'},{fact:''}],claim)).toThrow();
    expect(store.size).toBe(0); expect(store.getExtractionJobs()[0].status).toBe('running');
  });
  it('clear during extraction rejects stale results and never marks a failed job processed', async () => {
    summary();vi.mocked(callText).mockImplementationOnce(async()=>{store.clearAll();return '[{"fact":"resurrection"}]';});
    expect((await processDirtySessions(manager,store,model)).processed).toBe(0);expect(store.size).toBe(0);
  });
  it('concurrent duplicate calls share a lease and count only one committed source revision', async () => {
    summary();let release:any;vi.mocked(callText).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const first=processDirtySessions(manager,store,model); await Promise.resolve();
    expect((await processDirtySessions(manager,store,model)).deferred).toBe(1);
    release('[{"fact":"one fact"}]');expect((await first).factsAdded).toBe(1);expect(store.size).toBe(1);
  });
});

describe('in-flight derived writes', () => {
  it.each(['today','week','longterm','facts'])('discards %s compiler output after reset', async kind => {
    summary();const output=path.join(memory,`${kind}.md`);
    fs.writeFileSync(path.join(memory,'week.md'),'old week');
    vi.mocked(callText).mockImplementationOnce(async()=>{writeCompiledResetMarker(memory);clearCompiledMemoryArtifacts(memory);return 'old derived text';});
    const fake={getSummariesInRange:()=>[summary()]};
    const promise=kind==='today'?compileToday(fake,output,model):kind==='week'?compileWeek(fake,output,model):kind==='longterm'?compileLongterm(path.join(memory,'week.md'),output,model):compileFacts(fake,output,model);
    await expect(promise).rejects.toThrow(/generation/);expect(fs.readFileSync(output,'utf8')).toBe('');
  });
});
