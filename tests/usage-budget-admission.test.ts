// @ts-nocheck
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { callText } from '../core/llm-client.ts';
import { createUsageLedger } from '../lib/llm/usage-ledger.ts';
import { installUsageBudgetGuard, isUsageAccounted, USAGE_RESERVATION } from '../lib/llm/usage-budget-guard.ts';
import { confirmModelPricing } from '../shared/model-pricing.ts';
import { normalizeLlmUsage } from '../lib/llm/usage-observer.ts';
const model={id:'test',provider:'synthetic',api:'openai-completions',baseUrl:'https://example.test/v1',contextWindow:100,maxTokens:20,cost:{input:1,output:2,cacheRead:1,cacheWrite:1}};
const context={source:{subsystem:'memory',operation:'compile_today',surface:'system',trigger:'daily'},attribution:{kind:'memory',agentId:'a'}};
const ledgers=[];
function ledger(config={}) { const result=createUsageLedger();result.setBudgetConfig(config);ledgers.push(result);return result; }
afterEach(()=>{ledgers.splice(0).forEach(l=>l.close());vi.restoreAllMocks();});
const response=()=>({ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content:'summary'}}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})});
describe('real model entry-point budget admission with synthetic responses',()=>{
  it('checks the shared gate before any non-streaming fetch and prevents parallel oversubscription',async()=>{
    const usageLedger=ledger({memoryDaily:{maxCalls:1}});const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(response());
    const options={api:model.api,baseUrl:model.baseUrl,model,maxTokens:20,messages:[{role:'user',content:'synthetic'}],usageLedger,usageContext:context};
    const result=await Promise.allSettled([callText(options),callText(options),callText({...options,usageContext:{...context,source:{...context.source,operation:'experience_extract'}}})]);
    expect(result.filter(item=>item.status==='fulfilled')).toHaveLength(1);expect(fetch).toHaveBeenCalledTimes(1);
    expect(usageLedger.getBudgetReport('a').memoryDaily.calls).toBe(1);
  });
  it('retains incomplete/empty usage as unknown rather than zero',()=>{
    expect(normalizeLlmUsage({})).toBeNull();expect(normalizeLlmUsage({input:4},{costRates:model.cost})).toMatchObject({costTotal:null,totalTokens:null,output:{totalTokens:null}});
    const l=ledger({daily:{maxTokens:200}});const first=l.start({model,usageContext:context,maxOutputTokens:20});l.finish(first.requestId,{usage:null});
    expect(l.getBudgetReport().totals).toMatchObject({reservedTokens:120,knownTokens:0,unknownTokenCalls:1});
    expect(()=>l.start({model,usageContext:context,maxOutputTokens:20})).toThrow(/token allowance/);
  });
  it('does not lose explicit free metadata or accept invalidated pricing',()=>{
    const l=ledger({daily:{maxUsd:0}});
    const pricing=confirmModelPricing({confirmed:true,currency:'USD',unit:'per-million-tokens',cost:{input:0,output:0,cacheRead:0,cacheWrite:0},confirmedFree:true,source:'synthetic local'}, {provider:model.provider,modelId:model.id,api:model.api,baseUrl:model.baseUrl});
    const free={...model,cost:pricing.cost,pricing};const req=l.start({model:free,usageContext:context,maxOutputTokens:20});
    expect(l.finish(req.requestId,{usage:{input:10,output:2,totalTokens:12}}).usage.costTotal).toBe(0);
    expect(()=>l.start({model:{...free,baseUrl:'https://changed.test'},usageContext:context,maxOutputTokens:20})).toThrow(/unknown/);
  });
  it('reserves stream calls before dispatch, records once, and honors current runtime rates',async()=>{
    const l=ledger({daily:{maxUsd:0.001}});const send=vi.fn(()=>{const stream=new AssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:'done',reason:'stop',message:{role:'assistant',content:[],stopReason:'stop',usage:{input:10,output:2,totalTokens:12}}});stream.end();});return stream;});
    const session={agent:{streamFunction:send}};let current=model;
    installUsageBudgetGuard(session,()=>l,()=>context,()=>current);
    const result=await (await session.agent.streamFunction(model,{},{})).result();expect(isUsageAccounted(result)).toBe(true);expect(l.list().entries).toHaveLength(1);
    current={...model,cost:{input:100,output:100,cacheRead:100,cacheWrite:100}};
    await expect(session.agent.streamFunction(model,{},{})).rejects.toThrow(/USD reservation/);expect(send).toHaveBeenCalledTimes(1);
  });
  it('reuses only an active matching snapshot reservation and keeps per-agent memory caps separate',async()=>{
    const l=ledger({memoryDaily:{maxCalls:1}});const original=vi.fn(()=>new AssistantMessageEventStream());const session={agent:{streamFunction:original}};
    installUsageBudgetGuard(session,()=>l,()=>context);
    const req=l.start({model,usageContext:context});
    await session.agent.streamFunction(model,{}, {[USAGE_RESERVATION]:{ledger:l,requestId:req.requestId}});expect(original).toHaveBeenCalledTimes(1);
    expect(()=>l.start({model,usageContext:{...context,attribution:{kind:'memory',agentId:'b'}}})).not.toThrow();
    await expect(session.agent.streamFunction(model,{}, {[USAGE_RESERVATION]:{ledger:l,requestId:'forged'}})).rejects.toThrow(/budget/);
  });
  it('unknown usage remains guarded after UTC rollover until the relevant configured month ends',()=>{
    let now=Date.parse('2026-10-19T12:00:00Z');const l=createUsageLedger({now:()=>now});ledgers.push(l);l.setBudgetConfig({daily:{maxCalls:1},monthly:{maxUsd:10}});
    const request=l.start({model,usageContext:context});l.finish(request.requestId,{usage:null});now+=86400000;
    expect(()=>l.start({model,usageContext:context})).toThrow(/unknown/);now=Date.parse('2026-11-01T00:00:00Z');expect(()=>l.start({model,usageContext:context})).not.toThrow();
  });
});
it('settles a frozen session using the current runtime price at dispatch',async()=>{
  const l=ledger();const current={...model,cost:{input:20,output:40,cacheRead:20,cacheWrite:20}};
  const session={agent:{streamFunction:()=>{const stream=new AssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:'done',reason:'stop',message:{role:'assistant',content:[],stopReason:'stop',usage:{input:10,output:2,totalTokens:12,cost:{total:0}}}});stream.end();});return stream;}}};
  installUsageBudgetGuard(session,()=>l,()=>context,()=>current);await(await session.agent.streamFunction(model,{},{})).result();
  expect(l.list().entries[0].usage.costTotal).toBeCloseTo(0.00028);expect(l.list().entries[0].costBasis).toBe('configured_estimate');
});
