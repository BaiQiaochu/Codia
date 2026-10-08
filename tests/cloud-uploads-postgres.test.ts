import { readFile,mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import { PostgresWorkspaceStore } from '../lib/cloud-workspace/postgres-store.ts';
import { CloudWorkspaceService } from '../lib/cloud-workspace/service.ts';
import { LocalObjectStore } from '../lib/cloud-workspace/object-store.ts';
import { uploadHash,CLOUD_RESUMABLE_UPLOAD_LIMIT } from '../lib/cloud-workspace/uploads.ts';
import { uploadContract,uploadOwner as actor,uploadOther as stranger } from './helpers/cloud-upload-contract.ts';
const url=process.env.CODIA_TEST_POSTGRES_URL,suite=url?describe:describe.skip;
const database=`codia_uploads_${randomUUID().replaceAll('-','').slice(0,16)}`;
let bootstrap:Pool,admin:Pool,pool:Pool,store:PostgresWorkspaceStore,service:CloudWorkspaceService,root:string,databaseUrl:string;
const errors:string[]=[];
const watch=(pool:Pool)=>{pool.on('error',error=>errors.push(error.message));return pool;};
function runtimePool(){return watch(new Pool({connectionString:databaseUrl,options:'-c role=pg_database_owner',max:12}));}
async function reopen(){await pool.end();pool=runtimePool();store=new PostgresWorkspaceStore(pool);service=new CloudWorkspaceService(store,new LocalObjectStore(root));return service;}
suite('PostgreSQL v5 uploads, durable recovery, RLS and transaction races',()=>{
  beforeAll(async()=>{
    const parsed=new URL(url!);if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||!parsed.pathname.startsWith('/codia_'))throw new Error('Requires an isolated loopback codia_ database');
    bootstrap=watch(new Pool({connectionString:url}));await bootstrap.query(`CREATE DATABASE ${database}`);parsed.pathname=`/${database}`;databaseUrl=parsed.toString();admin=watch(new Pool({connectionString:databaseUrl}));
    for(const name of ['002-workspace-runtime.sql','004-cloud-agent-tasks.sql'])await admin.query(await readFile(new URL(`../lib/cloud-workspace/migrations/${name}`,import.meta.url),'utf8'));
    await expect(new PostgresWorkspaceStore(admin).verifySchema()).rejects.toMatchObject({code:'cloud_database_migration_required'});
    const existingId=randomUUID();await admin.query("INSERT INTO codia_workspace.workspaces(id,owner_user,studio_id,name) VALUES($1,'v4-owner','v4-studio','existing v4')",[existingId]);
    await admin.query(await readFile(new URL('../lib/cloud-workspace/migrations/005-resumable-uploads.sql',import.meta.url),'utf8'));
    expect((await admin.query('SELECT id FROM codia_workspace.workspaces WHERE id=$1',[existingId])).rowCount).toBe(1);
    await admin.query('GRANT USAGE ON SCHEMA codia_workspace TO pg_database_owner; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA codia_workspace TO pg_database_owner; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA codia_workspace TO pg_database_owner');
    root=await mkdtemp(path.join(os.tmpdir(),'codia-upload-pg-'));pool=runtimePool();store=new PostgresWorkspaceStore(pool);service=new CloudWorkspaceService(store,new LocalObjectStore(root));await store.verifySchema();
  });
  beforeEach(async()=>{await admin.query('TRUNCATE codia_workspace.workspaces CASCADE');});
  afterAll(async()=>{
    await pool?.end();await admin?.end();if(root)await rm(root,{recursive:true,force:true});
    if(bootstrap){try{const deadline=Date.now()+5000;while(Number((await bootstrap.query('SELECT count(*) AS count FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].count)!==0){if(Date.now()>deadline)throw new Error('Fixture clients did not close');await new Promise(resolve=>setTimeout(resolve,25));}await bootstrap.query(`DROP DATABASE IF EXISTS ${database}`);}finally{await bootstrap.end();}}
    expect(errors).toEqual([]);
  });
  uploadContract(()=>({service,reopen}));
  it('serializes duplicate creation, concurrent chunk receipts and final publication in DB',async()=>{
    const ws=await store.createWorkspace(actor,'concurrency'),bytes=Buffer.from('pg atomic'),spec={name:'atomic.bin',size:bytes.length,sha256:uploadHash(bytes),requestKey:randomUUID()};
    const uploads=await Promise.all(Array.from({length:8},()=>service.createUpload(actor,ws.id,spec)));
    expect(new Set(uploads.map(row=>row.id)).size).toBe(1);const upload=uploads[0];
    await Promise.all(Array.from({length:8},()=>service.uploadChunk(actor,upload.id,0,bytes,uploadHash(bytes))));
    const state=await store.beginUploadCompletion(actor,upload.id);await service.objects.putImmutable(state.version.object_key,bytes);
    const results=await Promise.all(Array.from({length:8},()=>store.finalizeUpload(actor,upload.id,state.session.manifest_sha256)));
    expect(new Set(results.map(row=>row.version.id)).size).toBe(1);expect(await store.versions(actor,results[0].file.id)).toHaveLength(1);
    expect((await store.events(actor,ws.id)).events.filter(event=>event.kind==='file.version_ready')).toHaveLength(1);
  });
  it('enforces FORCE RLS on upload+chunk tables and immutable manifest/state/metadata',async()=>{
    const ws=await store.createWorkspace(actor,'RLS'),bytes=Buffer.from('RLS'),upload=await service.createUpload(actor,ws.id,{name:'rls.bin',size:3,sha256:uploadHash(bytes),requestKey:randomUUID()});await service.uploadChunk(actor,upload.id,0,bytes,uploadHash(bytes));
    const force=(await admin.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('codia_workspace.uploads'::regclass,'codia_workspace.upload_chunks'::regclass)")).rows;expect(force.every(row=>row.relrowsecurity&&row.relforcerowsecurity)).toBe(true);
    await store.database.transaction({tenantId:stranger.studioId,actorId:stranger.userId},async tx=>{expect((await tx.query('SELECT * FROM codia_workspace.uploads')).rows).toEqual([]);expect((await tx.query('SELECT * FROM codia_workspace.upload_chunks')).rows).toEqual([]);});
    expect((await pool.query('SELECT * FROM codia_workspace.uploads')).rows).toEqual([]);
    await expect(admin.query("UPDATE codia_workspace.uploads SET state='completed',manifest_sha256=repeat('a',64),revision=revision+1 WHERE id=$1",[upload.id])).rejects.toThrow('Invalid upload state');
    const state=await store.beginUploadCompletion(actor,upload.id);
    await expect(admin.query("UPDATE codia_workspace.uploads SET manifest_sha256=repeat('b',64),revision=revision+1 WHERE id=$1",[upload.id])).rejects.toThrow('manifest is immutable');
    await expect(admin.query("UPDATE codia_workspace.upload_chunks SET sha256=repeat('a',64) WHERE upload_id=$1",[upload.id])).rejects.toThrow('chunks are immutable');
    expect(state.session.state).toBe('completing');
  });
  it('expires frozen sessions, retains creation-key identity and fences late finalization',async()=>{
    const ws=await store.createWorkspace(actor,'expiry'),bytes=Buffer.from('x'),spec={name:'expiry.bin',size:1,sha256:uploadHash(bytes),requestKey:randomUUID()},upload=await service.createUpload(actor,ws.id,spec);await service.uploadChunk(actor,upload.id,0,bytes,uploadHash(bytes));const state=await store.beginUploadCompletion(actor,upload.id);
    // Synthetic fixture clock move, using admin only; production never mutates expiry.
    await admin.query('ALTER TABLE codia_workspace.uploads DISABLE TRIGGER immutable_upload');try{await admin.query('UPDATE codia_workspace.uploads SET expires_at=0 WHERE id=$1',[upload.id]);}finally{await admin.query('ALTER TABLE codia_workspace.uploads ENABLE TRIGGER immutable_upload');}
    expect((await service.uploadStatus(actor,upload.id)).state).toBe('expired');
    await expect(store.finalizeUpload(actor,upload.id,state.session.manifest_sha256)).rejects.toMatchObject({code:'upload_expired'});
    await expect(service.uploadChunk(actor,upload.id,0,bytes,uploadHash(bytes))).rejects.toMatchObject({code:'upload_expired'});
    expect((await service.createUpload(actor,ws.id,spec)).id).toBe(upload.id);expect(await store.listFiles(actor,ws.id)).toEqual([]);
  });
  it('serializes owner byte quotas across concurrent requests to separate workspaces',async()=>{
    const owner={userId:randomUUID(),studioId:'quota'},spaces=await Promise.all(Array.from({length:6},()=>store.createWorkspace(owner,'quota')));
    const outcomes=await Promise.allSettled(spaces.map(space=>service.createUpload(owner,space.id,{name:'big',size:CLOUD_RESUMABLE_UPLOAD_LIMIT,sha256:'a'.repeat(64),requestKey:randomUUID()})));
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(4);
    expect(outcomes.filter(result=>result.status==='rejected').every(result=>(result as PromiseRejectedResult).reason.code==='upload_quota_exceeded')).toBe(true);
  });
});
