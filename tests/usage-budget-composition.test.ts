// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createUsageLedger } from '../lib/llm/usage-ledger.ts';
import { installUsageBudgetGuard } from '../lib/llm/usage-budget-guard.ts';
import { runSessionSnapshotSideTask } from '../lib/llm/session-snapshot-side-task-runner.ts';
import { createCachePreservingCompactionResult } from '../core/session-compactor.ts';
import { buildSessionCacheSnapshot } from '../core/session-cache-snapshot.ts';
import { recordAssistantUsage } from '../core/session-coordinator.ts';
import { recordBridgeAssistantUsage } from '../core/bridge-session-manager.ts';
const model={id:'synthetic',name:'Synthetic',provider:'synthetic',api:'openai-completions',baseUrl:'https://example.invalid/v1',reasoning:false,input:['text'],contextWindow:100,maxTokens:20,cost:{input:1,output:2,cacheRead:1,cacheWrite:1}};
const ctx={source:{subsystem:'memory',operation:'summary',surface:'system',trigger:'daily'},attribution:{kind:'memory',agentId:'a'}};
describe('composed budget gate integrity',()=>{
  it.each(['endpoint','price','output'])('does not reuse a real side-task reservation after %s changes',async(change)=>{
    const l=createUsageLedger();const send=vi.fn(()=>({result:async()=>({stopReason:'stop',content:[],usage:{input:10,output:2,totalTokens:12}})}));
    const session={agent:{streamFunction:send}};
    const current=change==='endpoint'?{...model,baseUrl:'https://changed.invalid/v1'}:change==='price'?{...model,cost:{input:100,output:100,cacheRead:100,cacheWrite:100}}:{...model,maxTokens:40};
    installUsageBudgetGuard(session,()=>l,()=>ctx,()=>current);
    const snapshot=buildSessionCacheSnapshot({sessionPath:'/sessions/synthetic.jsonl',reason:'memory.reflection',model,systemPrompt:'stable',tools:[],messages:[{role:'user',content:'synthetic'}]});
    try {await expect(runSessionSnapshotSideTask({snapshot,model,suffixMessage:{role:'user',content:'summarize'},streamFn:session.agent.streamFunction,usageLedger:l,usageContext:ctx,cacheGroup:'memory.reflection'})).rejects.toThrow(/changed|reservation/i);expect(send).not.toHaveBeenCalled();}finally{l.close();}
  });
  it.each(['session','bridge'])('does not duplicate real Agent synthetic errors in %s fallback observers',async(surface)=>{
    for(const denied of [true,false]) {
      const l=createUsageLedger();l.setBudgetConfig(denied?{daily:{maxCalls:0}}:{});let sent=0;
      const agent=new Agent({initialState:{model,systemPrompt:'',tools:[],messages:[]},streamFn:()=>{sent++;throw Error('synthetic synchronous provider failure');}});const session={agent};
      installUsageBudgetGuard(session,()=>l,()=>ctx);
      agent.subscribe(event=>surface==='session'?recordAssistantUsage({ledger:l,event,session,sessionPath:'/sessions/synthetic.jsonl',agentId:'a',model,source:ctx.source,attribution:ctx.attribution}):recordBridgeAssistantUsage({ledger:l,event,session,sessionPath:'/sessions/synthetic.jsonl',agent:{id:'a'},model,bridgeContext:{isBridgeSession:true}}));
      try {await agent.prompt('synthetic input');expect(sent).toBe(denied?0:1);expect(l.getBudgetReport().totals.calls).toBe(denied?0:1);expect(l.getBudgetReport().totals.unknownCostCalls).toBe(denied?0:1);}finally{l.close();}
    }
  });
});

it.each(['snapshot','compactor'])('preserves positive error snapshots as unknown in the real %s caller',async(kind)=>{
  const l=createUsageLedger();const partial={input:10,output:1,totalTokens:11};const streamFn=()=>({result:async()=>({stopReason:'error',errorMessage:'synthetic interrupted response',content:[],usage:partial})});
  try {
    const work=kind==='snapshot'?runSessionSnapshotSideTask({snapshot:buildSessionCacheSnapshot({sessionPath:'/sessions/synthetic.jsonl',reason:'memory.reflection',model,systemPrompt:'stable',tools:[],messages:[{role:'user',content:'synthetic'}]}),model,suffixMessage:{role:'user',content:'summarize'},streamFn,usageLedger:l,usageContext:ctx,cacheGroup:'memory.reflection'}):createCachePreservingCompactionResult({preparation:{firstKeptEntryId:'keep',tokensBefore:100,settings:{reserveTokens:20}},model,systemPrompt:'stable',messages:[{role:'user',content:'synthetic'}],streamFn,convertToLlm:async messages=>messages,usageLedger:l,usageContext:ctx,cacheMetadataOverride:{cacheStrategy:'utility_template',cacheGroup:'compaction'}});
    await expect(work).rejects.toThrow(/interrupted/);expect(l.getBudgetReport().totals).toMatchObject({unknownCostCalls:1,knownCostCalls:0,knownTokens:0});
    expect(l.getBudgetReport().totals.reservedTokens).toBeGreaterThan(0);expect(l.list().entries[0].reportedPartialUsage.totalTokens).toBe(11);
  }finally{l.close();}
});
