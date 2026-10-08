import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createServerAuthService } from '../core/server-auth.ts';
import { normalizePrincipal } from '../core/security-principal.ts';
import { CloudWorkspaceStore } from '../lib/cloud-workspace/store.ts';
import { CloudWorkspaceService } from '../lib/cloud-workspace/service.ts';
import { CloudWorkspaceWorker } from '../lib/cloud-workspace/worker.ts';
import { CloudRecordService } from '../lib/cloud-workspace/records.ts';
import { LocalObjectStore } from '../lib/cloud-workspace/object-store.ts';
import { CodiaDocumentAgentExecutor, createEngineCloudAgentExecutor } from '../lib/cloud-workspace/agent-executor.ts';
import { createCloudWorkspacesRoute, cloudOriginAllowed, verifyCloudLocalBearer } from '../server/routes/cloud-workspaces.ts';
const actor = {userId:'owner',studioId:'studio'}, other = {userId:'other',studioId:'studio'};
let directory:string, store:CloudWorkspaceStore, service:CloudWorkspaceService, records:CloudRecordService;
const servers:http.Server[]=[];
beforeEach(() => { directory=fs.mkdtempSync(path.join(os.tmpdir(),'codia-records-'));store=new CloudWorkspaceStore(path.join(directory,'meta.db'));service=new CloudWorkspaceService(store,new LocalObjectStore(path.join(directory,'objects')));records=new CloudRecordService(service); });
afterEach(async()=> { for(const s of servers.splice(0)) {s.closeAllConnections();await new Promise<void>(resolve=>s.close(()=>resolve()));} store.close();fs.rmSync(directory,{recursive:true,force:true}); });
function app(scopes=['files.read','files.write','chat'],credentialKind='user_session') {const a=new Hono();a.use('*',async(c,next)=>{(c as any).set('authPrincipal',normalizePrincipal({...actor,kind:'account_user',credentialKind,connectionKind:'cloud',scopes}));await next();});a.route('/api',createCloudWorkspacesRoute(service));return a;}
const post=(a:Hono,url:string,body:unknown)=>a.request(url,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'cloud-studio'},body:JSON.stringify(body)});
async function modelFixture(reply='This response came through the local simulated model protocol.') {
 const requests:any[]=[];
 const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests.push({body:JSON.parse(body),authorization:req.headers.authorization});
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 for(const chunk of [{choices:[{index:0,delta:{role:'assistant',content:reply},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:12,total_tokens:32}}])res.write(`data: ${JSON.stringify({id:'synthetic',object:'chat.completion.chunk',created:1,model:'fixture-model',...chunk})}\n\n`);
 res.end('data: [DONE]\n\n');});server.listen(0,'127.0.0.1');await once(server,'listening');servers.push(server);
 const address=server.address() as {port:number};
 const model={id:'fixture-model',name:'Synthetic test model',provider:'openai',api:'openai-completions',baseUrl:`http://127.0.0.1:${address.port}/v1`,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:4096};
 const executor=new CodiaDocumentAgentExecutor({resolve:async a=>a.userId===actor.userId&&a.studioId===actor.studioId?{model,apiKey:'fixture-only-test-key'}:null});
 return {executor,requests};
}
describe('actual bounded SDK Agent and cloud business records',()=>{
 it('runs real Pi Agent child against a local simulated model HTTP protocol and persists result',async()=>{
  const fixture=await modelFixture();service.agentExecutor=fixture.executor;
  const ws=store.createWorkspace(actor,'Agent');const file=await service.upload(actor,ws.id,'document.md',Buffer.from('# Test document\nVerify only synthetic content.'));
  const run=store.createRun(actor,ws.id,file.version.id,'agent-request-key','agent-summary');
  await new CloudWorkspaceWorker(service).tick();
  const detail=store.run(actor,run.id);expect(detail.run.status, JSON.stringify(detail.run)).toBe('succeeded');expect(detail.artifacts).toHaveLength(1);
  expect((await service.read(actor,detail.artifacts[0].version_id)).bytes.toString()).toContain('simulated model protocol');
  expect(fixture.requests).toHaveLength(1);expect(fixture.requests[0].body.messages.some((m:any)=>JSON.stringify(m.content).includes('Verify only synthetic content'))).toBe(true);
  expect(fixture.requests[0].body.tools || []).toEqual([]);
 },20000);
 it('atomically saves message plus queue, resumes after close, and other client sees one durable assistant reply',async()=>{
  const fixture=await modelFixture('A persistent conversation answer.');service.agentExecutor=fixture.executor;
  const ws=store.createWorkspace(actor,'Conversation');const record=await records.create(actor,ws.id,'conversation','Cloud chat',{messages:[]});
  const input={text:'Remember this synthetic message',expectedVersion:record.currentVersion,requestKey:'conversation-key-one'};
  const sent=await records.message(actor,record.id,input);expect(sent.run.status).toBe('queued');
  expect((await records.message(actor,record.id,input)).run.id).toBe(sent.run.id);
  store.close();store=new CloudWorkspaceStore(path.join(directory,'meta.db'));service=new CloudWorkspaceService(store,service.objects,fixture.executor);records=new CloudRecordService(service);
  await new CloudWorkspaceWorker(service).tick();
  const clientTwo=new CloudRecordService(new CloudWorkspaceService(store,service.objects,fixture.executor));
  const reopened=await clientTwo.get(actor,record.id);expect(reopened.data.messages.map((m:any)=>m.role)).toEqual(['user','assistant']);expect(reopened.data.messages[1].text).toBe('A persistent conversation answer.');
  expect((await records.message(actor,record.id,input)).run.id).toBe(sent.run.id);expect((await clientTwo.get(actor,record.id)).data.messages).toHaveLength(2);expect(fixture.requests).toHaveLength(1);
  await expect(clientTwo.get(other,record.id)).rejects.toThrow('not_found');
 },20000);
 it('rolls back the ready record and user message when atomic queue validation fails',async()=>{
  const ws=store.createWorkspace(actor,'Atomic');const record=await records.create(actor,ws.id,'conversation','Atomic chat',{messages:[]});const f=store.file(actor,record.id);
  await expect(service.upload(actor,ws.id,f.name,Buffer.from('{}'),f.id,record.currentVersion,{requestKey:'bad',operation:'agent-conversation'})).rejects.toThrow('invalid_request_key');
  expect((await records.get(actor,record.id)).data.messages).toEqual([]);expect(store.file(actor,record.id).current_version).toBe(record.currentVersion);expect(store.listRuns(actor,ws.id)).toEqual([]);
 });
 it('persists workflow edits with CAS and leaves immutable history accessible',async()=>{
  const ws=store.createWorkspace(actor,'Workflows');const record=await records.create(actor,ws.id,'workflow','Release checklist',{instruction:'Review the release',steps:[]});
  const saved=await records.update(actor,record.id,record.currentVersion,{instruction:'Review and verify',steps:['test']});
  expect(saved.id).toBe(record.id);expect(saved.currentVersion).not.toBe(record.currentVersion);expect((await records.list(actor,ws.id,'workflow'))[0].id).toBe(record.id);
  await expect(records.update(actor,record.id,record.currentVersion,{instruction:'stale'})).rejects.toThrow('version_conflict');
  expect(JSON.parse((await service.read(actor,record.currentVersion)).bytes.toString()).data.instruction).toBe('Review the release');
 });
 it('preserves arbitrary binary file bytes and authenticated download headers',async()=>{
  const ws=store.createWorkspace(actor,'Binary');const bytes=Buffer.from([0,255,42,0,128,1]);const upload=await service.upload(actor,ws.id,'sample.bin',bytes);
  const response=await app().request(`/api/cloud/versions/${upload.version.id}/content?download=1`);expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);expect(response.headers.get('content-disposition')).toContain('attachment;');expect(response.headers.get('content-security-policy')).toContain('sandbox');
 });
 it('denies files-only paid invocation before queueing and denies legacy demo even with forged studio',async()=>{
  service.agentExecutor={availability:async()=>({available:true}),execute:async()=>Buffer.from('no')};const ws=store.createWorkspace(actor,'Permissions');const upload=await service.upload(actor,ws.id,'a.txt',Buffer.from('x'));
  const response=await post(app(['files.read','files.write']),`/api/cloud/workspaces/${ws.id}/runs`,{operation:'agent-summary',inputVersion:upload.version.id,requestKey:'scope-test-key'});expect(response.status).toBe(403);expect(store.listRuns(actor,ws.id)).toEqual([]);
  expect((await app(undefined,'legacy_pwa_demo').request('/api/cloud/workspaces')).status).toBe(403);
 });
 it('never borrows the local owner model for another user or studio',async()=>{
  let reads=0;const engine={_runtimeContext:actor,currentModel:{id:'m'},modelRegistry:{getApiKeyAndHeaders:async()=>{reads++;return{ok:true,apiKey:'fixture-only'};}}};const executor=createEngineCloudAgentExecutor(engine);
  expect((await executor.availability(other)).available).toBe(false);expect((await executor.availability({...actor,studioId:'another'})).available).toBe(false);expect(reads).toBe(0);expect((await executor.availability(actor)).available).toBe(true);
 });
 it('does not fake agent success when model unavailable and binds idempotency to operation',async()=>{
  const ws=store.createWorkspace(actor,'No model');const upload=await service.upload(actor,ws.id,'a.txt',Buffer.from('x'));const run=store.createRun(actor,ws.id,upload.version.id,'unavailable-test-key','agent-summary');
  expect(()=>store.createRun(actor,ws.id,upload.version.id,'unavailable-test-key','document-summary')).toThrow('idempotency_conflict');await new CloudWorkspaceWorker(service).tick();expect(store.run(actor,run.id).run).toMatchObject({status:'failed',error:'model_not_configured'});
 });
 it('uses the persisted workspace even if executor run metadata is mutated',async()=>{
  const ws=store.createWorkspace(actor,'Original');const another=store.createWorkspace(other,'Other');const upload=await service.upload(actor,ws.id,'a.txt',Buffer.from('x'));const created=store.createRun(actor,ws.id,upload.version.id,'mutate-scope-key');const claimed=store.claim()!;
  store.complete({...claimed,workspace_id:another.id},{objectKey:'test/mutated-run-output',size:1,sha256:'x'});
  expect(store.file(actor,store.run(actor,created.id).artifacts[0].file_id).workspace_id).toBe(ws.id);expect(store.listFiles(other,another.id)).toEqual([]);
 });
 it('lease renewal fences stale attempts and never revives expired leases',async()=>{
  const ws=store.createWorkspace(actor,'Leases');const upload=await service.upload(actor,ws.id,'a.txt',Buffer.from('x'));store.createRun(actor,ws.id,upload.version.id,'lease-test-key');const first=store.claim(10,1000)!;
  expect(store.renewLease(first,10,1005)).toBe(true);expect(store.claim(10,1011)).toBeNull();const second=store.claim(10,1016)!;expect(store.renewLease(first,10,1017)).toBe(false);expect(store.renewLease(second,10,1027)).toBe(false);
 });
});


describe('native cloud origin boundary',()=>{
 const originContext=(principal:any,authorization?:string,origin='null',verified=true)=>({get:(key:string)=>key==='cloudLocalBearer'?verified:normalizePrincipal(principal),req:{url:'http://127.0.0.1:12000/api/cloud/workspaces',header:(key:string)=>key==='origin'?origin:key==='authorization'?authorization:undefined}});
 const owner={...actor,kind:'local_user',credentialKind:'loopback_token',connectionKind:'local'};
 it('accepts file opaque origin only with authenticated local-owner bearer',()=>{
  expect(cloudOriginAllowed(originContext(owner,'Bearer synthetic-verified-token'))).toBe(true);
  expect(cloudOriginAllowed(originContext(owner))).toBe(false);
  expect(cloudOriginAllowed(originContext(owner,'Bearer '))).toBe(false);
  expect(cloudOriginAllowed(originContext(owner,'Bearer dummy','null',false))).toBe(false);
  expect(cloudOriginAllowed(originContext({...owner,kind:'device',credentialKind:'device_credential'},'Bearer device-token'))).toBe(false);
  expect(cloudOriginAllowed(originContext({...owner,credentialKind:'legacy_pwa_demo'},'Bearer demo'))).toBe(false);
  expect(cloudOriginAllowed(originContext({...owner,connectionKind:'cloud'},'Bearer token'))).toBe(false);
  expect(cloudOriginAllowed(originContext(owner,'Bearer synthetic-verified-token','https://evil.invalid'))).toBe(false);
 });
});


describe('verified native bearer provenance',()=>{
 it('cannot derive permission from a cookie principal, dummy bearer, remote transport or query fallback',()=>{
  const auth=createServerAuthService({gsapHome:directory,loopbackToken:'synthetic-loopback-secret',runtimeContext:{userId:actor.userId,studioId:actor.studioId}});
  expect(verifyCloudLocalBearer(auth,'Bearer synthetic-loopback-secret','local')).toBe(true);
  expect(verifyCloudLocalBearer(auth,'Bearer dummy','local')).toBe(false);
  expect(verifyCloudLocalBearer(auth,undefined,'local')).toBe(false);
  expect(verifyCloudLocalBearer(auth,'Bearer synthetic-loopback-secret','lan')).toBe(false);
  expect(verifyCloudLocalBearer(auth,'Bearer synthetic-loopback-secret','cloud')).toBe(false);
 });
});
