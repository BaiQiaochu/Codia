import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresWorkspaceStore } from '../lib/cloud-workspace/postgres-store.ts';
import { CloudWorkspaceService } from '../lib/cloud-workspace/service.ts';
import { CloudWorkspaceWorker } from '../lib/cloud-workspace/worker.ts';
import { CloudRecordService } from '../lib/cloud-workspace/records.ts';
import { LocalObjectStore } from '../lib/cloud-workspace/object-store.ts';
import { CodiaDocumentAgentExecutor } from '../lib/cloud-workspace/agent-executor.ts';

// A real PostgreSQL server is REQUIRED. Skipped tests are never live validation.
const url = process.env.CODIA_TEST_POSTGRES_URL;
const suite = url ? describe : describe.skip;
const alice = { userId:'pg-alice',studioId:'studio-one' };
const bob = { userId:'pg-bob',studioId:'studio-one' };
const other = { userId:'pg-alice',studioId:'studio-two' };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const fixtureId=randomUUID().replaceAll('-','').slice(0,16);
const databaseName=`codia_workspace_${fixtureId}`, roleName=`codia_workspace_test_${fixtureId}`;
let databaseUrl:string;
let bootstrap:Pool, admin: Pool, pool: Pool, store: PostgresWorkspaceStore;
const fixturePools=new Map<Pool,Promise<void>|null>();
const fixturePoolErrors:string[]=[];
function makePool(config:PoolConfig) {
  const value=new Pool(config);fixturePools.set(value,null);
  value.on('error',(error:Error&{code?:string})=>fixturePoolErrors.push(error.code??'unexpected_pool_error'));
  return value;
}
async function closePool(value?:Pool) {
  if(!value)return;
  let pending=fixturePools.get(value);
  if(!pending){pending=value.end();fixturePools.set(value,pending);}
  await pending;
}
async function fixture(name = 'fixture') {
  const workspace = await store.createWorkspace(alice, name);
  const staged = await store.stageVersion(alice, workspace.id, `${name}.md`, 4, sha('test'));
  const uploaded = await store.finalizeVersion(alice, staged.version.id, null);
  return {workspace,...uploaded};
}
suite('PostgreSQL live transactions, RLS and concurrency (isolated fixture only)', () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname) || !parsed.pathname.startsWith('/codia_')) throw new Error('Live test URL must target an isolated loopback codia_ database');
    bootstrap = makePool({connectionString:url});
    await bootstrap.query(`CREATE DATABASE ${databaseName}`);
    parsed.pathname=`/${databaseName}`;databaseUrl=parsed.toString();
    admin = makePool({connectionString:databaseUrl});
    await admin.query(await readFile(new URL('../lib/cloud-workspace/migrations/002-workspace-runtime.sql',import.meta.url),'utf8'));
    await admin.query(await readFile(new URL('../lib/cloud-workspace/migrations/004-cloud-agent-tasks.sql',import.meta.url),'utf8'));
    await admin.query(`CREATE ROLE ${roleName} NOSUPERUSER NOBYPASSRLS NOLOGIN; GRANT USAGE ON SCHEMA codia_workspace TO ${roleName}; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA codia_workspace TO ${roleName}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA codia_workspace TO ${roleName};`);
    pool = makePool({connectionString:databaseUrl,max:12,options:`-c role=${roleName}`});
    store = new PostgresWorkspaceStore(pool);
    await store.verifySchema();
    const role = await pool.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(role.rows[0]).toMatchObject({current_user:roleName,rolsuper:false,rolbypassrls:false});
  });
  afterAll(async () => {
    for(const value of fixturePools.keys())if(value!==bootstrap)await closePool(value);
    if(bootstrap) {
      try {
        // pg-pool can resolve end() while idle sockets are still completing
        // Terminate. Never FORCE-drop their database: that races shutdown and
        // emits a fatal 57P01 on the otherwise successfully closed clients.
        const deadline=Date.now()+5000;
        for(;;) {
          const active=await bootstrap.query('SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=$1',[databaseName]);
          if(active.rows[0].count===0)break;
          if(Date.now()>=deadline)throw new Error('Disposable PostgreSQL clients did not finish closing');
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        await bootstrap.query(`DROP DATABASE IF EXISTS ${databaseName}`);
        await bootstrap.query(`DROP ROLE IF EXISTS ${roleName}`);
      } finally {await closePool(bootstrap);}
    }
    expect(fixturePoolErrors).toEqual([]);
  });
  it('reopens PostgreSQL clients and durably projects one actual SDK Agent answer with workflow CAS',async()=>{
    // Actual PostgreSQL + SDK child + synthetic HTTP model + local immutable
    // object fixture. This is not a managed S3 or paid model acceptance test.
    const root=await mkdtemp(path.join(os.tmpdir(),'codia-pg-agent-'));
    const requests:any[]=[];
    const server=http.createServer(async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk;
      requests.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'text/event-stream'});
      for(const chunk of [{choices:[{index:0,delta:{role:'assistant',content:'A durable PostgreSQL-backed Codia answer.'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:12,total_tokens:32}}])res.write(`data: ${JSON.stringify({id:'synthetic',object:'chat.completion.chunk',created:1,model:'fixture-model',...chunk})}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const model={id:'fixture-model',name:'Synthetic test model',provider:'openai',api:'openai-completions',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:4096};
    const executor=new CodiaDocumentAgentExecutor({resolve:async actor=>actor.userId===alice.userId&&actor.studioId===alice.studioId?{model,apiKey:'fixture-only-test-key'}:null});
    let clientPool:Pool|undefined;
    try {
      let service=new CloudWorkspaceService(store,new LocalObjectStore(root),executor);
      let records=new CloudRecordService(service);
      const workspace=await store.createWorkspace(alice,'PostgreSQL cross-client records');
      const conversation=await records.create(alice,workspace.id,'conversation','Durable conversation',{messages:[]});
      const input={text:'Persist this synthetic chat message',expectedVersion:conversation.currentVersion,requestKey:'pg-conversation-request'};
      const accepted=await records.message(alice,conversation.id,input);
      expect(accepted.run).toMatchObject({status:'queued',operation:'agent-conversation'});
      expect((await records.message(alice,conversation.id,input)).run.id).toBe(accepted.run.id);
      // Drop every original PG connection before processing the accepted job.
      await new CloudWorkspaceWorker(service).stop();await store.close();await closePool(pool);
      pool=makePool({connectionString:databaseUrl,max:12,options:`-c role=${roleName}`});
      store=new PostgresWorkspaceStore(pool);
      service=new CloudWorkspaceService(store,new LocalObjectStore(root),executor);records=new CloudRecordService(service);
      const worker=new CloudWorkspaceWorker(service);await worker.tick();await worker.stop();
      const detail=await store.run(alice,accepted.run.id);
      expect(detail.run.status,JSON.stringify(detail.run)).toBe('succeeded');
      clientPool=makePool({connectionString:databaseUrl,max:4,options:`-c role=${roleName}`});
      const otherStore=new PostgresWorkspaceStore(clientPool);
      const otherService=new CloudWorkspaceService(otherStore,new LocalObjectStore(root),executor);
      const clientTwo=new CloudRecordService(otherService);
      const reopened=await clientTwo.get(alice,conversation.id);
      expect(reopened.data.messages.map((message:any)=>message.role)).toEqual(['user','assistant']);
      expect(reopened.data.messages[1].text).toBe('A durable PostgreSQL-backed Codia answer.');
      expect((await records.message(alice,conversation.id,input)).run.id).toBe(accepted.run.id);
      expect((await clientTwo.get(alice,conversation.id)).data.messages).toHaveLength(2);
      expect(await new CloudWorkspaceWorker(service).tick()).toBe(false);
      expect(requests).toHaveLength(1);expect(requests[0].tools||[]).toEqual([]);
      await expect(clientTwo.get(bob,conversation.id)).rejects.toMatchObject({code:'not_found'});
      await expect(clientTwo.get(other,conversation.id)).rejects.toMatchObject({code:'not_found'});
      const workflow=await records.create(alice,workspace.id,'workflow','Release workflow',{instruction:'Review',steps:[]});
      const updates=await Promise.allSettled([records.update(alice,workflow.id,workflow.currentVersion,{instruction:'Client one',steps:['test']}),clientTwo.update(alice,workflow.id,workflow.currentVersion,{instruction:'Client two',steps:['verify']})]);
      expect(updates.filter(result=>result.status==='fulfilled')).toHaveLength(1);
      expect(updates.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'version_conflict'}});
      expect((await clientTwo.get(alice,workflow.id)).currentVersion).not.toBe(workflow.currentVersion);
      expect(JSON.parse((await otherService.read(alice,workflow.currentVersion)).bytes.toString()).data.instruction).toBe('Review');
    } finally {
      await closePool(clientPool);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});
    }
  },20000);
  it('persists uploads, normalizes API shapes, and enforces owner+studio through RLS', async () => {
    const f = await fixture('rls');
    expect(f.file).toMatchObject({current_version:f.version.id,size:4,version_count:1});
    expect(typeof f.file.created_at).toBe('string');
    for(const actor of [bob,other]) {
      expect(await store.listWorkspaces(actor)).toEqual([]);
      await expect(store.file(actor,f.file.id)).rejects.toMatchObject({code:'not_found'});
      await expect(store.version(actor,f.version.id)).rejects.toMatchObject({code:'not_found'});
      await expect(store.events(actor,f.workspace.id)).rejects.toMatchObject({code:'not_found'});
    }
    // Query without explicit predicates to test database RLS, not application SQL.
    await store.database.transaction({tenantId:bob.studioId,actorId:bob.userId},async tx=>expect((await tx.query('SELECT * FROM codia_workspace.versions')).rows).toEqual([]));
    expect((await pool.query('SELECT * FROM codia_workspace.workspaces')).rows).toEqual([]);
    expect((await store.versions(alice,f.file.id))[0].id).toBe(f.version.id);
    await expect(store.workspace(alice,'invalid-id')).rejects.toMatchObject({status:404});
  });
  it('stages concurrent uploads and atomically publishes only one CAS winner', async()=>{
    const f=await fixture('cas');
    const versions=await Promise.all(['one','two'].map(value=>store.stageVersion(alice,f.workspace.id,f.file.name,3,sha(value),f.file.id,f.version.id)));
    const results=await Promise.allSettled(versions.map(v=>store.finalizeVersion(alice,v.version.id,f.version.id)));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'version_conflict'}});
    expect(await store.versions(alice,f.file.id)).toHaveLength(2);
    expect((await store.version(alice,f.version.id)).sha256).toBe(sha('test'));
  });
  it('atomically reserves names, recovers rejected names and detects stale uploads', async()=>{
    const workspace=await store.createWorkspace(alice,'name');
    const results=await Promise.allSettled([1,2].map(()=>store.stageVersion(alice,workspace.id,'same.md',1,sha('x'))));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'file_name_exists'}});
    const staged=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value;
    await store.rejectVersion(staged.version.id);
    const retry=await store.stageVersion(alice,workspace.id,'same.md',1,sha('x'));
    expect(retry.file.id).not.toBe(staged.file.id);
    await store.reconcileStaging(Date.now()+301_000);
    await expect(store.finalizeVersion(alice,retry.version.id,null)).rejects.toMatchObject({code:'upload_not_pending'});
  });
  it('pins idempotency to input and operation across simultaneous requests', async()=>{
    const f=await fixture('idem');
    const runs=await Promise.all(Array.from({length:8},()=>store.createRun(alice,f.workspace.id,f.version.id,'same-request')));
    expect(new Set(runs.map(r=>r.id)).size).toBe(1);
    await expect(store.createRun(alice,f.workspace.id,f.version.id,'same-request','agent-summary')).rejects.toMatchObject({code:'idempotency_conflict'});
    const cross=await store.createWorkspace(alice,'cross');
    await expect(store.createRun(alice,cross.id,f.version.id,'cross-request')).rejects.toMatchObject({code:'not_found'});
    const events=await store.events(alice,f.workspace.id);
    expect(events.events.filter(e=>e.kind==='run.queued')).toHaveLength(1);
    // Keep later claim tests isolated by consuming this queued record.
    const claim=await store.claim(); expect(claim?.id).toBe(runs[0].id); await store.fail(claim!,'test_done');
  });
  it('claims each run once using SKIP LOCKED and fences stale attempts and leases', async()=>{
    const f=await fixture('queue');
    const runs=await Promise.all(Array.from({length:6},(_,i)=>store.createRun(alice,f.workspace.id,f.version.id,`queue-request-${i}`)));
    const claims=(await Promise.all(runs.map(()=>store.claim(100,1000)))).filter(Boolean);
    expect(new Set(claims.map(r=>r!.id)).size).toBe(6);
    expect(claims.every(r=>r!.owner_user===alice.userId && r!.studio_id===alice.studioId)).toBe(true);
    expect(await store.claim(100,1001)).toBeNull();
    const original=claims[0]!;
    expect(await store.renewLease(original,100,1050)).toBe(true);
    expect(await store.renewLease(original,100,1150)).toBe(false);
    const recovered=await store.claim(100,1200);
    expect(recovered!.attempt).toBe(2);
    const stale=claims.find(r=>r!.id===recovered!.id)!;
    await expect(store.complete(stale!,{objectKey:'stale/result',size:1,sha256:sha('x')},1201)).rejects.toMatchObject({code:'stale_executor'});
    expect(await store.renewLease(stale!,100,1201)).toBe(false);
    const output=await store.complete({...recovered,workspace_id:'forged'},{objectKey:`results/${recovered!.id}/2`,size:1,sha256:sha('x')},1201);
    const detail=await store.run(alice,recovered!.id);
    expect(detail.run.status).toBe('succeeded'); expect(detail.artifacts).toHaveLength(1); expect(output.fileId).toBe(detail.artifacts[0].file_id);
    expect((await store.file(alice,output.fileId)).workspace_id).toBe(f.workspace.id);
    // Exhaust remaining records so they cannot contaminate later claims.
    for(let attempt=0;attempt<12;attempt++) { const run=await store.claim(1,2000+attempt*10); if(!run) break; }
    await store.claim(1,5000);
    expect((await store.listRuns(alice,f.workspace.id)).every(r=>['succeeded','failed'].includes(r.status))).toBe(true);
  });
  it('does not revive a lease that expired while renewal waited for a row lock',async()=>{
    const f=await fixture('lease-lock');
    const run=await store.createRun(alice,f.workspace.id,f.version.id,'lease-lock-request');
    const claim=await store.claim(200); expect(claim!.id).toBe(run.id);
    const blocker=await admin.connect();
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM codia_workspace.runs WHERE id=$1 FOR UPDATE',[run.id]);
      const renewal=store.renewLease(claim!,1000);
      await new Promise(resolve=>setTimeout(resolve,350)); await blocker.query('COMMIT');
      expect(await renewal).toBe(false);
      const recovered=await store.claim(); expect(recovered).toMatchObject({id:run.id,attempt:2}); await store.fail(recovered!,'test_done');
    } finally {await blocker.query('ROLLBACK');blocker.release();}
  });
  it('publishes durable outbox exactly once and reconnects without duplicate events',async()=>{
    const f=await fixture('events');
    const before=await store.events(alice,f.workspace.id);
    await Promise.all(Array.from({length:10},(_,i)=>store.createRun(alice,f.workspace.id,f.version.id,`events-request-${i}`)));
    await Promise.all(Array.from({length:4},()=>store.publishOutbox()));
    const after=await store.events(alice,f.workspace.id,before.cursor);
    expect(after.events).toHaveLength(10); expect(new Set(after.events.map(e=>e.id)).size).toBe(10);
    expect((await store.events(alice,f.workspace.id,after.cursor)).events).toEqual([]);
    const reopened=new PostgresWorkspaceStore(pool); expect((await reopened.events(alice,f.workspace.id)).events).toHaveLength(11);
  });
  it('database prevents immutable-history mutation and cross-owner foreign keys',async()=>{
    const f=await fixture('history');
    await expect(store.database.transaction({tenantId:alice.studioId,actorId:alice.userId},tx=>tx.query('UPDATE codia_workspace.versions SET sha256=$1 WHERE id=$2',[sha('wrong'),f.version.id]))).rejects.toThrow('immutable');
    await store.publishOutbox();
    await expect(store.database.transaction({tenantId:alice.studioId,actorId:alice.userId},tx=>tx.query('UPDATE codia_workspace.events SET kind=$1 WHERE workspace_id=$2',['changed',f.workspace.id]))).rejects.toThrow('immutable');
    const otherWorkspace=await store.createWorkspace(bob,'other-owner');
    await expect(store.database.transaction({tenantId:alice.studioId,actorId:alice.userId},tx=>tx.query('UPDATE codia_workspace.files SET workspace_id=$1 WHERE id=$2',[otherWorkspace.id,f.file.id]))).rejects.toThrow();
  });
  it('atomically finalizes conversation input and queues work, rolling back invalid enqueues',async()=>{
    const workspace=await store.createWorkspace(alice,'atomic-chat');
    const staged=await store.stageVersion(alice,workspace.id,'chat.json',4,sha('test'));
    await expect(store.finalizeVersion(alice,staged.version.id,null,{requestKey:'bad',operation:'agent-conversation'})).rejects.toMatchObject({code:'invalid_request_key'});
    expect(await store.listFiles(alice,workspace.id)).toEqual([]);
    expect(await store.listRuns(alice,workspace.id)).toEqual([]);
    expect((await store.events(alice,workspace.id)).events).toEqual([]);
    const finalized=await store.finalizeVersion(alice,staged.version.id,null,{requestKey:'atomic-chat-request',operation:'agent-conversation'});
    expect(finalized.run).toMatchObject({status:'queued',input_version:staged.version.id,operation:'agent-conversation'});
    expect((await store.events(alice,workspace.id)).events.map(e=>e.kind)).toEqual(['file.version_ready','run.queued']);
    expect((await store.file(alice,staged.file.id)).current_version).toBe(staged.version.id);
  });

});
