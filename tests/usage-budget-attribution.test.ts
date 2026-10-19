// @ts-nocheck
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { describe,it,expect,vi } from 'vitest';
import { createHostApi } from '../lib/workflow/host-api.ts';import { WorkflowJournal } from '../lib/workflow/journal.ts';
import { createLimiter } from '../lib/workflow/concurrency.ts';
import { Scheduler } from '../hub/scheduler.ts';import { createUsageLedger } from '../lib/llm/usage-ledger.ts';
describe('host-owned durable usage attribution',()=>{
  it('passes the immutable workflow journal run ID to isolated execution',async()=>{
    const executeIsolated=vi.fn(async()=>({replyText:'synthetic result',error:null}));const journal=new WorkflowJournal(null);journal.setMetadata({runId:'trusted-run'});
    const api=createHostApi({executeIsolated,journal,baseIsoOpts:{agentId:'a'},limiter:createLimiter({maxConcurrent:1,maxTotal:5}),onProgress:()=>{}});
    await api.agent('synthetic task');expect(executeIsolated).toHaveBeenCalledWith('synthetic task',expect.objectContaining({workflowRunId:'trusted-run'}));
    expect(()=>api.agent('synthetic task',{runId:'model-forged'})).toThrow(/runId|unsupported|unknown/i);
  });
  it.each(['recorded','unknown'])('links cron job, actual activity run, session evidence and the ledger with %s runtime provenance',async(provenance)=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'usage-attribution-'));const ledger=createUsageLedger();const add=vi.fn();const sessionPath=path.join(root,'session.jsonl');
    const engine={agents:new Map(),agentsDir:root,getStudioCronStore:()=>({listJobs:()=>[]}),canRunBackgroundTask:()=>true,ensureAgentRuntime:async()=>{},getAgent:()=>({agentName:'A'}),getActivityStore:()=>({add}),summarizeActivity:async()=>null,emitDevLog:()=>{},executeIsolated:vi.fn(async(_prompt,opts)=>{
      ledger.record({model:{id:'synthetic',provider:'synthetic'},usage:null,usageContext:{source:{subsystem:'automation',operation:'run',surface:'system',trigger:'scheduled'},attribution:{kind:'automation',agentId:opts.agentId,runId:opts.runId,jobId:opts.jobId}}});
      return {sessionPath,error:null,environment:{provenance,runId:opts.runId,projectId:'recorded-project'}};
    })};
    try {const scheduler=new Scheduler({hub:{engine,eventBus:{emit:vi.fn()}}});await scheduler._executeCronJobForAgent('a',{id:'job-synthetic',label:'synthetic',prompt:'synthetic task'});
      const activity=add.mock.calls[0][0];expect(activity).toMatchObject({id:expect.stringMatching(/^cron_/),jobId:'job-synthetic',sessionPath});
      expect(engine.executeIsolated.mock.calls[0][1]).toMatchObject({runId:activity.id,jobId:activity.jobId});
      expect(ledger.list().entries[0].attribution).toMatchObject({agentId:'a',runId:activity.id,jobId:'job-synthetic'});
      expect(activity.environment).toEqual(provenance==='recorded'?{provenance,runId:activity.id,projectId:'recorded-project'}:null);
    }finally{ledger.close();fs.rmSync(root,{recursive:true,force:true});}
  });
});
