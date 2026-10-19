// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {CodiaEngine} from '../core/engine.ts';
import {ActivityHub} from '../lib/activity-hub.ts';
import {WorkflowActivityStore} from '../lib/workflow-activity-store.ts';
import {listMemoryRunEvidence} from '../server/routes/memory-run-evidence.ts';
const dirs=[];afterEach(()=>dirs.splice(0).forEach(dir=>fs.rmSync(dir,{recursive:true,force:true})));
describe('production dispatch memory snapshot v2',()=>{
 it('persists the trusted actual dispatch environment and never retroactively upgrades old runs',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codia-run-v2-'));dirs.push(dir);fs.mkdirSync(path.join(dir,'.git'));
  const canonicalRoot=fs.realpathSync(dir);const projectId=`workspace:${process.platform==='win32'?canonicalRoot.toLowerCase():canonicalRoot}`;
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({version:'1.2.3',dependencies:{example:'^1'}}));fs.writeFileSync(path.join(dir,'package-lock.json'),JSON.stringify({packages:{'node_modules/example':{version:'1.2.0'}}}));
  const sessionPath=path.join(dir,'session.jsonl');fs.writeFileSync(path.join(dir,'session-meta.json'),JSON.stringify({'session.jsonl':{channelId:'channel-v2'}}));
  const file=path.join(dir,'activities.json');const hub=new ActivityHub(null,new WorkflowActivityStore(file));hub.upsert({id:'real',kind:'subagent',agentId:'alpha',status:'running',sessionPath,startedAt:Date.now()});hub.upsert({id:'old',kind:'subagent',agentId:'alpha',status:'done',sessionPath,startedAt:1,finishedAt:2});
  const engine=Object.create(CodiaEngine.prototype);engine._activityHub=hub;engine.productDir=path.join(dir,'product');engine._sessionCoord={executeIsolated:vi.fn(async(_prompt,opts)=>{opts.onSessionReady(sessionPath);return {ok:true};})};engine.getSessionCwd=()=>dir;
  const resultSnapshot = await engine.executeIsolated('synthetic',{cwd:dir,parentSessionPath:sessionPath,subagentTaskId:'real',runId:'new-run',agentId:'alpha',environment:{projectId:'forged'}});
  expect(resultSnapshot.environment).toMatchObject({projectId:projectId,runId:'new-run',provenance:'recorded'});
  hub.upsert({id:'real',status:'done',finishedAt:Date.now()});
  const reloaded=new ActivityHub(null,new WorkflowActivityStore(file));const result=await listMemoryRunEvidence({activityHub:reloaded,getSessionCwd:()=>dir},'alpha');
  expect(result.runs.find(r=>r.runId==='workflow:real')).toMatchObject({projectId:projectId,environmentProvenance:'recorded',environment:{channel:'channel-v2',platform:process.platform,appVersion:'1.2.3',dependencyVersions:{example:'1.2.0'}}});
  expect(result.runs.find(r=>r.runId==='workflow:old')).toMatchObject({projectId:null,environmentProvenance:'session_current'});
  expect(engine._sessionCoord.executeIsolated).toHaveBeenCalledTimes(1);
  engine._sessionCoord.executeIsolated.mockResolvedValue({ok:true,environment:{projectId:'forged-external',provenance:'recorded'}});
  const external=await engine.executeIsolated('synthetic external',{agentId:'alpha'});
  expect(external.environment).toBeNull();
 });
});
