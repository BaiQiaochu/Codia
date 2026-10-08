import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCloudWorkspaceRuntime, readCloudWorkspaceConfig } from '../lib/cloud-workspace/config.ts';
import { asAsyncWorkspaceRepository } from '../lib/cloud-workspace/repository.ts';
const directory = '/tmp/codia-config-contract';
// Synthetic configuration only. No external service is contacted by these tests.
const cloud = {
  CODIA_CLOUD_DATABASE:'postgres',CODIA_CLOUD_OBJECT_STORE:'s3',
  CODIA_CLOUD_DATABASE_URL:'postgresql://test:fixture@127.0.0.1/codia_test',
  CODIA_CLOUD_S3_ENDPOINT:'https://s3.us-east-1.amazonaws.com',CODIA_CLOUD_S3_BUCKET:'test-bucket',CODIA_CLOUD_S3_REGION:'us-east-1',
  CODIA_CLOUD_S3_ACCESS_KEY_ID:'AKIAIOSFODNN7EXAMPLE',CODIA_CLOUD_S3_SECRET_ACCESS_KEY:'EXAMPLE_NOT_A_SECRET',
};
const read = (env: NodeJS.ProcessEnv) => readCloudWorkspaceConfig({localDirectory:directory,env});
describe('workspace runtime configuration (offline validation)',()=>{
  it('defaults only nonproduction environments to explicit local adapters',()=>{
    expect(read({})).toMatchObject({database:'sqlite',objectStore:'local'});
    expect(read({NODE_ENV:'production'})).toMatchObject({database:'sqlite',objectStore:'local'});
    expect(()=>read({CODIA_CLOUD_MODE:'production'})).toThrow('explicitly');
    expect(()=>read({CODIA_CLOUD_MODE:'production',CODIA_CLOUD_DATABASE:'sqlite',CODIA_CLOUD_OBJECT_STORE:'local'})).toThrow('Production');
  });
  it('refuses mixed, invalid or implicitly ignored connection settings',()=>{
    expect(()=>read({CODIA_CLOUD_DATABASE:'postgres'})).toThrow('together');
    expect(()=>read({CODIA_CLOUD_OBJECT_STORE:'s3'})).toThrow('together');
    expect(()=>read({CODIA_CLOUD_DATABASE:'unknown'})).toThrow('select');
    expect(()=>read({CODIA_CLOUD_DATABASE_URL:cloud.CODIA_CLOUD_DATABASE_URL})).toThrow('explicit');
  });
  it.each(['CODIA_CLOUD_DATABASE_URL','CODIA_CLOUD_S3_ENDPOINT','CODIA_CLOUD_S3_BUCKET','CODIA_CLOUD_S3_REGION','CODIA_CLOUD_S3_ACCESS_KEY_ID','CODIA_CLOUD_S3_SECRET_ACCESS_KEY'])('requires %s without exposing its value',key=>{
    const env: NodeJS.ProcessEnv={...cloud}; delete env[key]; expect(()=>read(env)).toThrow(key);
  });
  it('requires verified TLS in production and rejects driver URL SSL overrides',()=>{
    expect(read({...cloud,CODIA_CLOUD_MODE:'production'}).postgres?.ssl).toEqual({rejectUnauthorized:true});
    expect(()=>read({...cloud,CODIA_CLOUD_MODE:'production',CODIA_CLOUD_DATABASE_TLS:'disable'})).toThrow('requires verified TLS');
    expect(()=>read({...cloud,CODIA_CLOUD_DATABASE_URL:'postgresql://test:fixture@db.example/codia_test'})).toThrow('loopback');
    expect(()=>read({...cloud,CODIA_CLOUD_DATABASE_URL:cloud.CODIA_CLOUD_DATABASE_URL+'?sslmode=no-verify'})).toThrow('instead of URL');
    for(const query of ['ssl=no-verify','ssl=0','host=remote.example','options=-c%20role%3Dsuperuser']) expect(()=>read({...cloud,CODIA_CLOUD_MODE:'production',CODIA_CLOUD_DATABASE_URL:cloud.CODIA_CLOUD_DATABASE_URL+'?'+query})).toThrow('driver query overrides');
    expect(read({...cloud,CODIA_CLOUD_DATABASE_TLS:'verify-full',CODIA_CLOUD_DATABASE_CA:'test-ca'}).postgres?.ssl).toEqual({rejectUnauthorized:true,ca:'test-ca'});
  });
  it('bounds the pool and storage timeout and validates S3 without network access',()=>{
    expect(()=>read({...cloud,CODIA_CLOUD_DATABASE_POOL_SIZE:'0'})).toThrow('POOL_SIZE');
    expect(()=>read({...cloud,CODIA_CLOUD_S3_TIMEOUT_MS:'15001'})).toThrow('TIMEOUT_MS');
    expect(()=>read({...cloud,CODIA_CLOUD_S3_ENDPOINT:'http://insecure.example'})).toThrow('HTTPS');
    expect(read(cloud)).toMatchObject({database:'postgres',objectStore:'s3'});
  });
  it('normalizes sync success/throw to promises without leaking db handles',async()=>{
    const wrapped=asAsyncWorkspaceRepository({kind:'sqlite-local',db:{secret:'private'},createWorkspace(){return {id:'workspace'}},file(){throw new Error('not_found')}} as any);
    expect((wrapped as any).db).toBeUndefined();
    expect(wrapped.createWorkspace({userId:'a',studioId:'b'},'name')).toBeInstanceOf(Promise);
    await expect(wrapped.file({userId:'a',studioId:'b'},'missing')).rejects.toThrow('not_found');
  });
  it('creates a durable local runtime and reopens the same authority',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'codia-config-'));
    const actor={userId:'test',studioId:'studio'};
    try {
      const runtime=await createCloudWorkspaceRuntime({localDirectory:root,env:{}});
      const workspace=await runtime.store.createWorkspace(actor,'saved');
      await runtime.objects.putImmutable('test/version',Buffer.from('body'));
      await runtime.close();
      const reopened=await createCloudWorkspaceRuntime({localDirectory:root,env:{}});
      expect((await reopened.store.listWorkspaces(actor))[0].id).toBe(workspace.id);
      expect(await reopened.objects.get('test/version')).toEqual(Buffer.from('body'));
      await reopened.close();
    } finally {await rm(root,{recursive:true,force:true});}
  });
});
