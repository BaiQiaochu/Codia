import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { CloudWorkspaceStore } from '../lib/cloud-workspace/store.ts';
import { LocalObjectStore, type ObjectStore } from '../lib/cloud-workspace/object-store.ts';
import { CloudWorkspaceService } from '../lib/cloud-workspace/service.ts';
import { createCloudWorkspacesRoute } from '../server/routes/cloud-workspaces.ts';
import { CLOUD_UPLOAD_CHUNK_SIZE,uploadHash } from '../lib/cloud-workspace/uploads.ts';
import { uploadContract,uploadOwner as actor } from './helpers/cloud-upload-contract.ts';
let root:string,store:CloudWorkspaceStore,service:CloudWorkspaceService;
async function reopen() { store.close();store=new CloudWorkspaceStore(path.join(root,'db.sqlite'));service=new CloudWorkspaceService(store,new LocalObjectStore(path.join(root,'objects')));return service; }
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'codia-upload-'));store=new CloudWorkspaceStore(path.join(root,'db.sqlite'));service=new CloudWorkspaceService(store,new LocalObjectStore(path.join(root,'objects')));});
afterEach(async()=>{vi.useRealTimers();store.close();await rm(root,{recursive:true,force:true});});
describe('resumable uploads SQLite durable contract',()=>uploadContract(()=>({service,reopen})));
describe('upload expiry, admission and binary HTTP guards',()=>{
  it('expires both writable and frozen sessions across restart; late bytes never publish',async()=>{
    const real=Date.now();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(real-25*60*60*1000);
    const ws=store.createWorkspace(actor,'expiry'),bytes=Buffer.from('expiry'),upload=await service.createUpload(actor,ws.id,{name:'expiry.bin',size:bytes.length,sha256:uploadHash(bytes),requestKey:randomUUID()});
    await service.uploadChunk(actor,upload.id,0,bytes,uploadHash(bytes));await service.store.beginUploadCompletion(actor,upload.id);
    vi.setSystemTime(real);await reopen();
    expect((await service.uploadStatus(actor,upload.id)).state).toBe('expired');
    await expect(service.uploadChunk(actor,upload.id,0,bytes,uploadHash(bytes))).rejects.toMatchObject({code:'upload_expired'});
    await expect(service.completeUpload(actor,upload.id)).rejects.toMatchObject({code:'upload_expired'});
    expect(store.listFiles(actor,ws.id)).toEqual([]);
  });
  it('rejects oversized run, paused-schedule, legacy schedule-enable and retry admission with typed 413',async()=>{
    const app=new Hono();app.use('*',async(c,next)=>{(c as any).set('authPrincipal',{...actor,kind:'account_user',credentialKind:'user_session',connectionKind:'cloud',scopes:['files.read','files.write','chat']});await next();});app.route('/api',createCloudWorkspacesRoute(service));
    const send=(url:string,body:unknown,method='POST')=>app.request(url,{method,headers:{'Content-Type':'application/json','X-Requested-With':'cloud-studio'},body:JSON.stringify(body)});
    for(const operation of ['document-summary','agent-task'] as const) {
      const ws=store.createWorkspace(actor,`admission ${operation}`),staged=store.stageVersion(actor,ws.id,'legacy.json',2,uploadHash('{}'));
      const input=store.finalizeVersion(actor,staged.version.id,null).version;
      const schedule=store.createSchedule(actor,ws.id,{name:'Legacy schedule',inputVersion:input.id,operation,requestKey:randomUUID(),firstRunAt:Date.now(),intervalMs:null,enabled:false});
      const run=store.createRun(actor,ws.id,input.id,randomUUID(),operation);store.cancelRun(actor,run.id);
      // Simulates durable legacy metadata that predates admission limits.
      store.db.prepare('UPDATE cw_versions SET size=? WHERE id=?').run(operation==='document-summary'?2097153:131073,input.id);
      for(const [url,body,method] of [
        [`/api/cloud/workspaces/${ws.id}/runs`,{inputVersion:input.id,operation,requestKey:randomUUID()},'POST'],
        [`/api/cloud/workspaces/${ws.id}/schedules`,{name:'Oversize paused',inputVersion:input.id,operation,requestKey:randomUUID(),firstRunAt:Date.now(),intervalMs:null,enabled:false},'POST'],
        [`/api/cloud/schedules/${schedule.id}`,{expectedRevision:1,enabled:true},'PUT'],
        [`/api/cloud/runs/${run.id}/retry`,{requestKey:randomUUID()},'POST'],
      ] as [string,unknown,string][]) {
        const response=await send(url,body,method);expect(response.status).toBe(413);expect(await response.json()).toEqual({error:operation==='document-summary'?'document_input_too_large':'agent_input_too_large'});
      }
      expect(store.listRuns(actor,ws.id)).toHaveLength(1);expect(store.schedule(actor,schedule.id).state).toBe('paused');
    }
  });
  it('single-flights same-session completion and rejects a third distinct assembly',async()=>{
    const ws=store.createWorkspace(actor,'admission'),bytes=Buffer.from('x'),uploads=[];
    for(let i=0;i<3;i++){const upload=await service.createUpload(actor,ws.id,{name:`admission-${i}`,size:1,sha256:uploadHash(bytes),requestKey:randomUUID()});await service.uploadChunk(actor,upload.id,0,bytes,uploadHash(bytes));uploads.push(upload);}
    let release!:()=>void,entered=0;const gate=new Promise<void>(resolve=>{release=resolve;}),objects=service.objects;
    const gated:ObjectStore={kind:'gated',putImmutable:(key,bytes)=>objects.putImmutable(key,bytes),get:async key=>{if(key.includes('/chunks/')){entered++;await gate;}return objects.get(key);}};
    const limited=new CloudWorkspaceService(store,gated);
    const a=limited.completeUpload(actor,uploads[0].id),duplicate=limited.completeUpload(actor,uploads[0].id),b=limited.completeUpload(actor,uploads[1].id);
    for(let i=0;i<100 && entered<2;i++) await new Promise(resolve=>setTimeout(resolve,5));
    expect(entered).toBe(2);
    await expect(limited.completeUpload(actor,uploads[2].id)).rejects.toMatchObject({code:'upload_completion_busy',status:503});release();
    const [first,replay]=await Promise.all([a,duplicate,b]);expect(first.version.id).toBe(replay.version.id);expect(entered).toBe(2);
  });
  it('keeps binary auth/origin/header/size guards and metadata-only public shapes',async()=>{
    const app=new Hono();app.use('*',async(c,next)=>{(c as any).set('authPrincipal',{...actor,kind:'account_user',credentialKind:'user_session',connectionKind:'cloud',scopes:['files.read','files.write']});await next();});app.route('/api',createCloudWorkspacesRoute(service));
    const ws=store.createWorkspace(actor,'api'),bytes=Buffer.from('http'),upload=await service.createUpload(actor,ws.id,{name:'api.bin',size:4,sha256:uploadHash(bytes),requestKey:randomUUID()});
    const url=`/api/cloud/uploads/${upload.id}/chunks/0`,headers={'Content-Type':'application/octet-stream','X-Requested-With':'cloud-studio','X-Chunk-SHA256':uploadHash(bytes)};
    for(const extra of [{'Content-Type':'application/json'},{'X-Requested-With':''},{Origin:'https://evil.invalid'},{'X-Chunk-SHA256':'bad'}]) expect((await app.request(url,{method:'PUT',headers:{...headers,...extra},body:bytes})).status).toBeGreaterThanOrEqual(400);
    expect((await app.request(url,{method:'PUT',headers,body:Buffer.alloc(CLOUD_UPLOAD_CHUNK_SIZE+1)})).status).toBe(413);
    const ack=await app.request(url,{method:'PUT',headers,body:bytes});expect(ack.status).toBe(200);expect(JSON.stringify(await ack.json())).not.toContain('object_key');
    const complete=await app.request(`/api/cloud/uploads/${upload.id}/complete`,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'cloud-studio'},body:'{}'});expect(complete.status).toBe(200);
    expect(await (await app.request('/api/cloud/health')).json()).toMatchObject({uploadLimit:2097152,resumableUploadLimit:33554432,uploadSession:true,runRetry:true,documentLimit:2097152,agentInputLimit:131072});
  });
});
