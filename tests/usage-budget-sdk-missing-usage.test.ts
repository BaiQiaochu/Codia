// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { stream } from '../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js';
import { stream as streamAnthropic } from '../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js';
import { createUsageLedger } from '../lib/llm/usage-ledger.ts';
import { installUsageBudgetGuard } from '../lib/llm/usage-budget-guard.ts';
const model={id:'synthetic-model',name:'synthetic',provider:'synthetic',api:'openai-completions',baseUrl:'https://example.invalid/v1',reasoning:false,input:['text'],contextWindow:100,maxTokens:20,cost:{input:1,output:2,cacheRead:1,cacheWrite:1}};
const usageContext={source:{subsystem:'session',operation:'reply',surface:'desktop',trigger:'user'},attribution:{kind:'session',agentId:'a'}};
const emptyUsage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
describe('real SDK missing usage accounting',()=>{
  it('retains the first reservation when the real SDK manufactures zero counters for an SSE response without usage',async()=>{
    let dispatches=0;
    const mockedFetch=async()=>{dispatches++;return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'synthetic answer'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}});};
    const ledger=createUsageLedger();try {
      ledger.setBudgetConfig({daily:{maxUsd:0.00015,maxTokens:120}});
      const session={agent:{streamFunction:(m,c,o)=>stream(m,c,{...o,apiKey:'synthetic-fake',fetch:mockedFetch,maxRetries:0})}};
      installUsageBudgetGuard(session,()=>ledger,()=>usageContext);
      const context={messages:[{role:'user',content:'synthetic input',timestamp:Date.now()}]};
      await(await session.agent.streamFunction(model,context,{maxTokens:20})).result();
      expect(ledger.list().entries[0]).toMatchObject({status:'usage_missing',usage:null});
      await expect(session.agent.streamFunction(model,context,{maxTokens:20})).rejects.toThrow(/budget/);
      expect(dispatches).toBe(1);expect(ledger.getBudgetReport().daily).toMatchObject({knownCostCalls:0,unknownCostCalls:1,reservedTokens:120,reservedUsd:0.00014});
    } finally {ledger.close();}
  });
  it('treats SDK zero placeholders on errors and normalized completions as unknown too',()=>{
    const ledger=createUsageLedger();try {
      const error=ledger.start({model,usageContext});ledger.recordError(error.requestId,new Error('synthetic provider failure'),'error',{usage:emptyUsage});
      const normalized=ledger.start({model,usageContext});ledger.finish(normalized.requestId,{usage:{input:{totalTokens:0,uncachedTokens:0},output:{totalTokens:0},cache:{readTokens:0,writeTokens:0},totalTokens:0,costTotal:0}});
      expect(ledger.getBudgetReport().totals).toMatchObject({knownCostCalls:0,unknownCostCalls:2,reservedTokens:240});
    } finally {ledger.close();}
  });
});

it('retains the full reservation for a real Anthropic SSE that reports positive partial usage but never finishes',async()=>{
  const events=[{type:'message_start',message:{id:'msg_synthetic',type:'message',role:'assistant',model:model.id,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'synthetic partial output'}}];
  let dispatches=0;const fetch=async()=>{dispatches++;return new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{status:200,headers:{'content-type':'text/event-stream'}});};
  const ledger=createUsageLedger();try{
    ledger.setBudgetConfig({daily:{maxUsd:.0002}});const anthropic={...model,api:'anthropic-messages',baseUrl:'https://example.invalid'};
    const session={agent:{streamFunction:(m,c,o)=>streamAnthropic(m,c,{...o,apiKey:'synthetic-fake',fetch,maxRetries:0})}};installUsageBudgetGuard(session,()=>ledger,()=>usageContext);
    const result=await(await session.agent.streamFunction(anthropic,{messages:[{role:'user',content:'synthetic',timestamp:Date.now()}]},{maxTokens:20})).result();
    expect(result.stopReason).toBe('error');expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(ledger.getBudgetReport().daily).toMatchObject({unknownCostCalls:1,knownCostCalls:0,reservedTokens:120,reservedUsd:.00014});
    await expect(session.agent.streamFunction(anthropic,{},{})).rejects.toThrow(/unknown/);expect(dispatches).toBe(1);
  }finally{ledger.close();}
});
