import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CloudWorkspaceService } from '../../lib/cloud-workspace/service.ts';
import { ObjectAlreadyExistsError, type ObjectStore } from '../../lib/cloud-workspace/object-store.ts';
import { CLOUD_UPLOAD_CHUNK_SIZE, CLOUD_RESUMABLE_UPLOAD_LIMIT, uploadHash } from '../../lib/cloud-workspace/uploads.ts';
import type { CloudActor } from '../../lib/cloud-workspace/store.ts';
export const uploadOwner: CloudActor={userId:'upload-alice',studioId:'upload-studio'};
export const uploadOther: CloudActor={userId:'upload-bob',studioId:'upload-studio'};
export const uploadOtherStudio: CloudActor={userId:'upload-alice',studioId:'other-studio'};
export function uploadContract(context:()=>{service:CloudWorkspaceService; reopen:()=>Promise<CloudWorkspaceService>; expire:(uploadIds:string[])=>Promise<void>}) {
  async function fixture(bytes=Buffer.from('persistent upload'),actor=uploadOwner) {
    const {service}=context(),workspace=await service.store.createWorkspace(actor,'Upload contract');
    const spec={name:'document.bin',size:bytes.length,sha256:uploadHash(bytes),requestKey:randomUUID()};
    const upload=await service.createUpload(actor,workspace.id,spec);
    return {service,workspace,spec,upload,bytes,actor};
  }
  async function chunks(f:Awaited<ReturnType<typeof fixture>>) {
    for (let index=0;index<Math.ceil(f.bytes.length/CLOUD_UPLOAD_CHUNK_SIZE);index++) {
      const value=f.bytes.subarray(index*CLOUD_UPLOAD_CHUNK_SIZE,(index+1)*CLOUD_UPLOAD_CHUNK_SIZE);
      await f.service.uploadChunk(f.actor,f.upload.id,index,value,uploadHash(value));
    }
  }
  it('replays intent after progress/reopen/complete and verifies a >2MiB binary upload',async()=>{
    const bytes=Buffer.alloc(2*CLOUD_UPLOAD_CHUNK_SIZE+71,0xa7),f=await fixture(bytes);
    await chunks(f);
    expect((await f.service.createUpload(f.actor,f.workspace.id,f.spec)).id).toBe(f.upload.id);
    const resumed=await context().reopen();
    expect((await resumed.listUploads(f.actor,f.workspace.id))[0].received_chunks).toEqual([0,1,2]);
    const result=await resumed.completeUpload(f.actor,f.upload.id);
    expect(result.upload).toMatchObject({state:'completed',received_bytes:bytes.length,manifest_sha256:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect((await resumed.read(f.actor,result.version.id)).bytes.equals(bytes)).toBe(true);
    expect((await resumed.completeUpload(f.actor,f.upload.id)).version.id).toBe(result.version.id);
    expect((await resumed.createUpload(f.actor,f.workspace.id,f.spec)).state).toBe('completed');
    expect(await resumed.store.versions(f.actor,result.file.id)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('object_key');
    await expect(resumed.store.createRun(f.actor,f.workspace.id,result.version.id,randomUUID())).rejects.toMatchObject({code:'document_input_too_large',status:413});
    await expect(resumed.store.createSchedule(f.actor,f.workspace.id,{name:'too big',inputVersion:result.version.id,operation:'document-summary',requestKey:randomUUID(),firstRunAt:Date.now(),intervalMs:null})).rejects.toMatchObject({code:'document_input_too_large'});
  });
  it('enforces exact chunk index/length/hash, missing chunks, and immutable same-index replay',async()=>{
    const f=await fixture(Buffer.alloc(CLOUD_UPLOAD_CHUNK_SIZE+5,9)),first=f.bytes.subarray(0,CLOUD_UPLOAD_CHUNK_SIZE);
    await expect(f.service.completeUpload(f.actor,f.upload.id)).rejects.toMatchObject({code:'upload_incomplete'});
    await expect(f.service.uploadChunk(f.actor,f.upload.id,-1,first,uploadHash(first))).rejects.toMatchObject({code:'invalid_chunk_index'});
    await expect(f.service.uploadChunk(f.actor,f.upload.id,0,Buffer.from('x'),uploadHash('x'))).rejects.toMatchObject({code:'invalid_chunk_size'});
    await expect(f.service.uploadChunk(f.actor,f.upload.id,0,first,'0'.repeat(64))).rejects.toMatchObject({code:'chunk_hash_mismatch'});
    const ack=await f.service.uploadChunk(f.actor,f.upload.id,0,first,uploadHash(first));
    const replay=await f.service.uploadChunk(f.actor,f.upload.id,0,first,uploadHash(first));
    expect(replay.revision).toBe(ack.revision); expect(replay.received_bytes).toBe(CLOUD_UPLOAD_CHUNK_SIZE);
    const changed=Buffer.alloc(CLOUD_UPLOAD_CHUNK_SIZE,8);
    await expect(f.service.uploadChunk(f.actor,f.upload.id,0,changed,uploadHash(changed))).rejects.toMatchObject({code:'chunk_conflict'});
    const last=f.bytes.subarray(CLOUD_UPLOAD_CHUNK_SIZE);
    await f.service.uploadChunk(f.actor,f.upload.id,1,last,uploadHash(last));
    await expect(f.service.completeUpload(f.actor,f.upload.id)).resolves.toBeTruthy();
  });
  it('supports zero bytes and rejects oversize/invalid session metadata without allocation',async()=>{
    const f=await fixture(Buffer.alloc(0));
    expect((await f.service.completeUpload(f.actor,f.upload.id)).version.size).toBe(0);
    await expect(f.service.createUpload(f.actor,f.workspace.id,{...f.spec,requestKey:randomUUID(),size:CLOUD_RESUMABLE_UPLOAD_LIMIT+1})).rejects.toMatchObject({code:'file_too_large'});
    await expect(f.service.createUpload(f.actor,f.workspace.id,{...f.spec,requestKey:randomUUID(),size:-1})).rejects.toMatchObject({code:'invalid_upload_size'});
    await expect(f.service.createUpload(f.actor,f.workspace.id,{...f.spec,size:1})).rejects.toMatchObject({code:'idempotency_conflict'});
  });
  it('enforces owner+studio at every guessed session endpoint',async()=>{
    const f=await fixture();
    for (const actor of [uploadOther,uploadOtherStudio]) {
      await expect(f.service.uploadStatus(actor,f.upload.id)).rejects.toMatchObject({code:'not_found'});
      await expect(f.service.listUploads(actor,f.workspace.id)).rejects.toMatchObject({code:'not_found'});
      await expect(f.service.uploadChunk(actor,f.upload.id,0,f.bytes,uploadHash(f.bytes))).rejects.toMatchObject({code:'not_found'});
      await expect(f.service.completeUpload(actor,f.upload.id)).rejects.toMatchObject({code:'not_found'});
      await expect(f.service.cancelUpload(actor,f.upload.id)).rejects.toMatchObject({code:'not_found'});
    }
  });
  it('persists frozen manifest and permits completion after uncertain immutable PUT/publication',async()=>{
    const f=await fixture(); await chunks(f);
    const frozen=await f.service.store.beginUploadCompletion(f.actor,f.upload.id);
    await f.service.objects.putImmutable(frozen.version.object_key,f.bytes);
    const restarted=await context().reopen();
    const result=await restarted.completeUpload(f.actor,f.upload.id);
    expect(result.upload.state).toBe('completed');
    const replay=await restarted.completeUpload(f.actor,f.upload.id);
    expect(replay.version).toEqual(result.version);
    expect(await restarted.store.versions(f.actor,result.file.id)).toHaveLength(1);
  });
  it('recovers uncertain chunk PUT without trusting OBJECT_EXISTS alone',async()=>{
    const f=await fixture(),state=await f.service.store.uploadSession(f.actor,f.upload.id);
    const key=`workspaces/${f.workspace.id}/uploads/${f.upload.id}/chunks/0`;
    await f.service.objects.putImmutable(key,f.bytes);
    expect((await f.service.uploadChunk(f.actor,f.upload.id,0,f.bytes,uploadHash(f.bytes))).received_chunks).toEqual([0]);
    const corrupt: ObjectStore={kind:'corrupt-test',putImmutable:async()=>{throw new ObjectAlreadyExistsError();},get:async()=>Buffer.alloc(f.bytes.length,42)};
    const bad=new CloudWorkspaceService(f.service.store,corrupt);
    await expect(bad.completeUpload(f.actor,f.upload.id)).rejects.toMatchObject({code:'chunk_integrity_mismatch'});
    expect((await f.service.uploadStatus(f.actor,f.upload.id)).state).toBe('completing');
    expect(state.version.status).toBe('staging');
  });
  it('freezes full-file hash and rejects valid chunks assembled into the wrong declared file',async()=>{
    const f=await fixture();
    const wrong=Buffer.alloc(f.bytes.length,5);
    await f.service.uploadChunk(f.actor,f.upload.id,0,wrong,uploadHash(wrong));
    await expect(f.service.completeUpload(f.actor,f.upload.id)).rejects.toMatchObject({code:'upload_hash_mismatch'});
    expect(await f.service.store.listFiles(f.actor,f.workspace.id)).toEqual([]);
    expect((await f.service.cancelUpload(f.actor,f.upload.id)).state).toBe('cancelled');
  });
  it('preserves old bytes and current version when replacement CAS loses',async()=>{
    const f=await fixture();await chunks(f);const original=await f.service.completeUpload(f.actor,f.upload.id);
    const spec={...f.spec,requestKey:randomUUID(),fileId:original.file.id,expectedVersion:original.version.id};
    const a=await f.service.createUpload(f.actor,f.workspace.id,spec),b=await f.service.createUpload(f.actor,f.workspace.id,{...spec,requestKey:randomUUID()});
    for(const upload of [a,b]) await f.service.uploadChunk(f.actor,upload.id,0,f.bytes,uploadHash(f.bytes));
    const winner=await f.service.completeUpload(f.actor,a.id);
    await expect(f.service.completeUpload(f.actor,b.id)).rejects.toMatchObject({code:'version_conflict'});
    expect((await f.service.store.file(f.actor,original.file.id)).current_version).toBe(winner.version.id);
    expect((await f.service.read(f.actor,original.version.id)).bytes.equals(f.bytes)).toBe(true);
    expect((await f.service.cancelUpload(f.actor,b.id)).state).toBe('cancelled');
  });
  it('cancel fences an already assembling completion and releases the filename safely',async()=>{
    const f=await fixture();await chunks(f);
    let started!:()=>void,release!:()=>void;
    const blocked=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
    const objects: ObjectStore={kind:'gated-test',putImmutable:(key,bytes)=>f.service.objects.putImmutable(key,bytes),get:async key=>{if(key.includes('/chunks/')){started();await blocked;}return f.service.objects.get(key);}};
    const concurrent=new CloudWorkspaceService(f.service.store,objects),pending=concurrent.completeUpload(f.actor,f.upload.id);
    await entered;
    expect((await f.service.cancelUpload(f.actor,f.upload.id)).state).toBe('cancelled'); release();
    await expect(pending).rejects.toMatchObject({code:'upload_not_pending'});
    expect(await f.service.store.listFiles(f.actor,f.workspace.id)).toEqual([]);
    expect((await f.service.createUpload(f.actor,f.workspace.id,{...f.spec,requestKey:randomUUID()})).state).toBe('uploading');
  });
  it('cancels concurrently despite legacy cleanup-name collisions, retaining bytes and history',async()=>{
    const f=await fixture(),collisionNames=[`${f.spec.name}.failed-${f.upload.file_id}`,`${f.upload.file_id}.failed`];
    const kept=await Promise.all(collisionNames.map(name=>f.service.upload(f.actor,f.workspace.id,name,Buffer.from(name))));
    await chunks(f);
    const cancelled=await Promise.allSettled(Array.from({length:8},()=>f.service.cancelUpload(f.actor,f.upload.id)));
    for(const outcome of cancelled) { if(outcome.status==='rejected') throw outcome.reason;expect(outcome.value).toMatchObject({state:'cancelled',revision:3}); }
    const restarted=await context().reopen(),history=await restarted.store.uploadSession(f.actor,f.upload.id);
    expect(history.version.status).toBe('rejected');expect(history.chunks).toHaveLength(1);
    expect((await restarted.createUpload(f.actor,f.workspace.id,f.spec)).id).toBe(f.upload.id);
    expect((await restarted.cancelUpload(f.actor,f.upload.id)).revision).toBe(3);
    for(const [index,file] of kept.entries()) expect((await restarted.read(f.actor,file.version.id)).bytes.toString()).toBe(collisionNames[index]);
    expect((await restarted.store.listFiles(f.actor,f.workspace.id)).map(file=>file.name).sort()).toEqual([...collisionNames].sort());
    const retry=await restarted.createUpload(f.actor,f.workspace.id,{...f.spec,requestKey:randomUUID()});
    expect(retry.file_id).not.toBe(f.upload.file_id);expect(retry.state).toBe('uploading');
    await expect(restarted.createUpload(f.actor,f.workspace.id,{...f.spec,name:`.rejected/${f.upload.file_id}`,requestKey:randomUUID()})).rejects.toMatchObject({code:'invalid_name'});
  });
  it('cancellation releases an active byte reservation across workspaces despite old cleanup names',async()=>{
    const {service}=context(),actor={userId:randomUUID(),studioId:'cancel-quota'},ws=await service.store.createWorkspace(actor,'cancel quota'),uploads=[];
    for(let i=0;i<4;i++) uploads.push(await service.createUpload(actor,ws.id,{name:`large-${i}`,size:CLOUD_RESUMABLE_UPLOAD_LIMIT,sha256:'a'.repeat(64),requestKey:randomUUID()}));
    const first=uploads[0];
    for(const name of [`large-0.failed-${first.file_id}`,`${first.file_id}.failed`]) await service.upload(actor,ws.id,name,Buffer.from(name));
    const other=await service.store.createWorkspace(actor,'new upload'),spec={name:'replacement',size:CLOUD_RESUMABLE_UPLOAD_LIMIT,sha256:'b'.repeat(64),requestKey:randomUUID()};
    await expect(service.createUpload(actor,other.id,spec)).rejects.toMatchObject({code:'upload_quota_exceeded'});
    expect((await service.cancelUpload(actor,first.id)).state).toBe('cancelled');
    expect((await service.createUpload(actor,other.id,spec)).state).toBe('uploading');
    expect((await service.uploadStatus(actor,first.id)).revision).toBe(2);
  });
  it('expiry releases owner-wide quotas despite cleanup-name collisions and preserves retries',async()=>{
    const {service,expire}=context(),actor={userId:randomUUID(),studioId:'expiry-quota'},workspace=await service.store.createWorkspace(actor,'expiry quota');
    const uploads=[];
    for(let i=0;i<4;i++) uploads.push(await service.createUpload(actor,workspace.id,{name:`large-${i}`,size:CLOUD_RESUMABLE_UPLOAD_LIMIT,sha256:'a'.repeat(64),requestKey:randomUUID()}));
    const first=uploads[0],kept=[];
    for(const name of [`large-0.failed-${first.file_id}`,`${first.file_id}.failed`]) kept.push(await service.upload(actor,workspace.id,name,Buffer.from(name)));
    const other=await service.store.createWorkspace(actor,'another workspace'),spec={name:'after-cleanup',size:1,sha256:uploadHash('x'),requestKey:randomUUID()};
    await expect(service.createUpload(actor,other.id,spec)).rejects.toMatchObject({code:'upload_quota_exceeded'});
    await expire(uploads.map(row=>row.id));
    // Public reads and creation used to fail owner-wide while cleaning this row.
    const lists=await Promise.allSettled(Array.from({length:4},()=>service.listUploads(actor,other.id)));
    for(const outcome of lists) { if(outcome.status==='rejected') throw outcome.reason;expect(outcome.value).toEqual([]); }
    const next=await service.createUpload(actor,other.id,spec);expect(next.state).toBe('uploading');
    for(const upload of uploads) {
      expect(await service.uploadStatus(actor,upload.id)).toMatchObject({state:'expired',revision:2});
      expect((await service.store.uploadSession(actor,upload.id)).version.status).toBe('rejected');
      expect((await service.cancelUpload(actor,upload.id)).state).toBe('expired');
    }
    for(const file of kept) expect((await service.read(actor,file.version.id)).bytes.toString()).toBe(file.file.name);
    const restarted=await context().reopen();expect((await restarted.uploadStatus(actor,first.id)).state).toBe('expired');
    expect((await restarted.createUpload(actor,other.id,spec)).id).toBe(next.id);
  });
  it('bounds active and retained reservations across workspaces and cancellation loops',async()=>{
    const actor={userId:randomUUID(),studioId:'quota-studio'}, {service}=context(),ws=await service.store.createWorkspace(actor,'quota');
    for(let i=0;i<4;i++) await service.createUpload(actor,ws.id,{name:`big-${i}`,size:CLOUD_RESUMABLE_UPLOAD_LIMIT,sha256:'1'.repeat(64),requestKey:randomUUID()});
    const second=await service.store.createWorkspace(actor,'quota2');
    await expect(service.createUpload(actor,second.id,{name:'overflow',size:1,sha256:'1'.repeat(64),requestKey:randomUUID()})).rejects.toMatchObject({code:'upload_quota_exceeded'});
    const retainedActor={userId:randomUUID(),studioId:'quota-studio'},retainedWs=await service.store.createWorkspace(retainedActor,'retained');
    for(let i=0;i<32;i++) { const upload=await service.createUpload(retainedActor,retainedWs.id,{name:`small-${i}`,size:1,sha256:'1'.repeat(64),requestKey:randomUUID()});await service.cancelUpload(retainedActor,upload.id); }
    await expect(service.createUpload(retainedActor,retainedWs.id,{name:'overflow',size:1,sha256:'1'.repeat(64),requestKey:randomUUID()})).rejects.toMatchObject({code:'upload_retention_quota_exceeded'});
  });
  it('keeps long active completing versions out of generic stale-stage rejection',async()=>{
    const f=await fixture();await chunks(f);await f.service.store.beginUploadCompletion(f.actor,f.upload.id);
    await f.service.store.reconcileStaging(Date.now()+6*60*1000,0);
    expect((await f.service.store.uploadSession(f.actor,f.upload.id)).version.status).toBe('staging');
    await expect(f.service.completeUpload(f.actor,f.upload.id)).resolves.toBeTruthy();
  });
  it('explicit retries pin original input/operation and dedupe source linkage',async()=>{
    const f=await fixture();await chunks(f);const uploaded=await f.service.completeUpload(f.actor,f.upload.id);
    const source=await f.service.store.createRun(f.actor,f.workspace.id,uploaded.version.id,randomUUID());
    await expect(f.service.store.retryRun(f.actor,source.id,randomUUID())).rejects.toMatchObject({code:'run_not_retryable'});
    await f.service.store.cancelRun(f.actor,source.id);
    const key=randomUUID(),retry=await f.service.store.retryRun(f.actor,source.id,key);
    expect(retry).toMatchObject({retry_of:source.id,input_version:uploaded.version.id,operation:'document-summary',status:'queued'});
    expect((await f.service.store.retryRun(f.actor,source.id,key)).id).toBe(retry.id);
    await expect(f.service.store.retryRun(uploadOther,source.id,key)).rejects.toMatchObject({code:'not_found'});
    const conversation=await f.service.store.createRun(f.actor,f.workspace.id,uploaded.version.id,randomUUID(),'agent-conversation');await f.service.store.cancelRun(f.actor,conversation.id);
    await expect(f.service.store.retryRun(f.actor,conversation.id,randomUUID())).rejects.toMatchObject({code:'run_not_retryable'});
  });
}
