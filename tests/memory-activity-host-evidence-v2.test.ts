import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {it,expect,vi} from 'vitest';
import {CodiaEngine} from '../core/engine.ts';
import {Scheduler} from '../hub/scheduler.ts';
import {ActivityStore} from '../lib/desk/activity-store.ts';
import {resolveMemoryProjectId} from '../lib/memory/runtime-context.ts';
import {listMemoryRunEvidence} from '../server/routes/memory-run-evidence.ts';
it('joins host snapshots from actual scheduled execution to persisted run evidence without relabeling legacy or external runs',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codia-host-review-'));
 try {
  fs.mkdirSync(path.join(root,'.git'));
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'1.0.0',dependencies:{example:'^1'}}));
  fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify({packages:{'node_modules/example':{version:'1.0.0'}}}));
  const activityDir=path.join(root,'agents','alpha','activity');fs.mkdirSync(activityDir,{recursive:true});
  const activitiesFile=path.join(root,'activities.json');const store=new ActivityStore(activitiesFile,activityDir);
  const sessionPath=path.join(activityDir,'scheduled.jsonl');fs.writeFileSync(sessionPath,'');
  const metaFile=path.join(activityDir,'session-meta.json');fs.writeFileSync(metaFile,JSON.stringify({'scheduled.jsonl':{cwd:root,channelId:'old-channel'}}));
  store.add({id:'legacy',agentId:'alpha',type:'cron',status:'done',sessionPath,startedAt:1,finishedAt:2});
  const engine:any={agentsDir:path.join(root,'agents'),productDir:path.join(root,'product'),ensureAgentRuntime:vi.fn(),getHomeCwd:()=>root,getSessionCwd:()=>root,getAgent:()=>({agentName:'Alpha'}),getActivityStore:()=>store,summarizeActivity:vi.fn(async()=> 'Synthetic task evidence'),emitDevLog:vi.fn(),executeIsolated:CodiaEngine.prototype.executeIsolated,
   _sessionCoord:{executeIsolated:vi.fn(async(_prompt,opts)=>{opts.onSessionReady(sessionPath);return {sessionPath,environment:{projectId:'forged',provenance:'recorded'}};})}};
  const scheduler=new Scheduler({hub:{engine,eventBus:{emit:vi.fn()}}});
  const result=await scheduler._executeActivityForAgent('alpha','synthetic','cron','Synthetic',{cwd:root});
  const persisted=store.get(result.activityId);expect(persisted.environment).toMatchObject({projectId:resolveMemoryProjectId(root),channel:'old-channel',appVersion:'1.0.0',dependencyVersions:{example:'1.0.0'},runId:result.activityId,provenance:'recorded'});
  expect(persisted.sessionPath).toBe(sessionPath);
  engine._sessionCoord.executeIsolated.mockResolvedValueOnce({sessionPath,error:null,environment:{cwd:root,projectId:'forged-external',provenance:'recorded'}});
  const external=await scheduler._executeActivityForAgent('alpha','synthetic external','cron','External',{cwd:root});
  expect(store.get(external.activityId).environment).toBeNull();
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'2.0.0',dependencies:{example:'^2'}}));
  fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify({packages:{'node_modules/example':{version:'2.0.0'}}}));
  fs.writeFileSync(metaFile,JSON.stringify({'scheduled.jsonl':{cwd:root,channelId:'new-channel'}}));
  const reloaded=new ActivityStore(activitiesFile,activityDir);
  const evidence=await listMemoryRunEvidence({listAgents:()=>[{id:'alpha'}],getActivityStore:()=>reloaded,getSessionCwd:()=>root},'alpha');
  expect(evidence.runs.find(r=>r.runId===`activity:${result.activityId}`)).toMatchObject({sessionId:sessionPath,status:'succeeded',projectId:resolveMemoryProjectId(root),environmentProvenance:'recorded',environment:{channel:'old-channel',appVersion:'1.0.0',dependencyVersions:{example:'1.0.0'}}});
  for(const id of ['legacy',external.activityId])expect(evidence.runs.find(r=>r.runId===`activity:${id}`)).toMatchObject({projectId:null,environmentProvenance:'session_current',environment:{}});
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
