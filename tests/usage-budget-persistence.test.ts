// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUsageLedger } from '../lib/llm/usage-ledger.ts';
import { normalizeLlmUsage } from '../lib/llm/usage-observer.ts';
import { aggregateEntries, formatCost } from '../desktop/src/react/settings/tabs/providers/usage-ledger-model.ts';
const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, {recursive:true,force:true})));
const context = {source:{subsystem:'memory',operation:'summary',surface:'background',trigger:'daily'}, attribution:{kind:'memory',agentId:'a',runId:'run-1',jobId:'job-1'}};
const model = {id:'test',provider:'synthetic',api:'openai-completions',contextWindow:100,maxTokens:20,cost:{input:1,output:2,cacheRead:1,cacheWrite:1}};
function location() { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'usage-budget-'));dirs.push(dir);return path.join(dir,'usage.sqlite'); }
describe('persistent usage and budget regression', () => {
  it('does not coerce missing or null prices into free cost', () => {
    expect(normalizeLlmUsage({input:10,output:2,costTotal:null},{costRates:{input:null,output:null}}).costTotal).toBeNull();
  });
  it('separates true zero and unknown coverage', () => {
    const entries=[{status:'ok',usage:{costTotal:0}},{status:'usage_missing',usage:null},{status:'ok',usage:{costTotal:0.5}}];
    expect(aggregateEntries('all','all',entries)).toMatchObject({costTotal:0.5,knownCostCount:2,unknownCostCount:1,costCoverage:2/3});
    expect(formatCost(0)).toBe('$0.00');
  });
  it('persists entries, attribution, completeness and outstanding reservations across restart', () => {
    const dbPath=location();const ledger=createUsageLedger({dbPath});
    ledger.record({model,usage:{input:10,output:2,cost:{total:0.5}},usageContext:context});
    ledger.start({model,usageContext:context,maxOutputTokens:20}); ledger.close();
    const restored=createUsageLedger({dbPath});
    expect(restored.list().entries[0].attribution).toMatchObject({runId:'run-1',jobId:'job-1'});
    expect(restored.list().completeness).toMatchObject({persistent:true,storedEntries:1});
    expect(restored.getBudgetReport().totals.pendingCalls).toBe(1);restored.close();
  });
  it('atomically reserves a shared daily cap across database connections', () => {
    const dbPath=location();const one=createUsageLedger({dbPath});const two=createUsageLedger({dbPath});
    one.setBudgetConfig({memoryDaily:{maxCalls:1}});
    one.start({model,usageContext:context,maxOutputTokens:20});
    expect(()=>two.start({model,usageContext:context,maxOutputTokens:20})).toThrow(/budget/i);
    one.close();two.close();
  });
  it('retains unknown provider usage and blocks money admission', () => {
    const ledger=createUsageLedger({dbPath:location()});ledger.setBudgetConfig({memoryDaily:{maxUsd:1}});
    const req=ledger.start({model,usageContext:context,maxOutputTokens:20});ledger.finish(req.requestId,{usage:null});
    expect(()=>ledger.start({model,usageContext:context,maxOutputTokens:20})).toThrow(/unknown/i);
    expect(ledger.getBudgetReport().totals.unknownCostCalls).toBe(1);ledger.close();
  });
});

it('never persists SDK credentials or URL query secrets in pending or completed documents', async () => {
  const dbPath=location();const ledger=createUsageLedger({dbPath});
  const request=ledger.start({model:{...model,headers:{Authorization:'Bearer SECRET_FIXTURE_TOKEN'},apiKey:'SECRET_FIXTURE_TOKEN',baseUrl:'https://example.test?key=SECRET_FIXTURE_TOKEN'},usageContext:context});
  ledger.finish(request.requestId,{usage:{input:1,output:1,totalTokens:2}});ledger.close();
  const {createRequire}=await import('node:module');const Database=createRequire(import.meta.url)('better-sqlite3');const db=new Database(dbPath);
  try { for (const table of ['usage_reservations','usage_entries']) expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).not.toContain('SECRET_FIXTURE_TOKEN'); }
  finally { db.close(); }
});
it('recomputes normalized costs using the dispatch pricing snapshot and preserves unknown pricing', () => {
  const ledger=createUsageLedger();
  const normalized={input:{totalTokens:10,uncachedTokens:10},output:{totalTokens:2},cache:{readTokens:0,writeTokens:0},totalTokens:12,costTotal:0};
  const req=ledger.start({model:{...model,pricing:null},usageContext:context});
  expect(ledger.finish(req.requestId,{usage:normalized,costRates:model.cost}).usage.costTotal).toBeNull();ledger.close();
});
it('does not label an unpriced SDK cost zero as confirmed free, or an SDK estimate as supplier-reported',()=>{
  const ledger=createUsageLedger();try {
    const minimal={provider:'synthetic',modelId:'test',api:'openai-completions'};
    const zero=ledger.record({model:minimal,usage:{input:10,output:2,totalTokens:12,cost:{total:0}},usageContext:context});
    expect(zero.usage.costTotal).toBeNull();expect(zero.costBasis).toBe('unknown');
    const estimate=ledger.record({model:minimal,usage:{input:10,output:2,totalTokens:12,cost:{total:.001}},usageContext:context});
    expect(estimate.costBasis).toBe('configured_estimate');
  }finally{ledger.close();}
});
it('does not release token reservations for malformed normalized totals or missing token fields',()=>{
  const ledger=createUsageLedger();try {
    for (const usage of [
      {input:{totalTokens:10,uncachedTokens:10},output:{totalTokens:2},cache:{readTokens:0,writeTokens:0},totalTokens:0,costTotal:0},
      {input:{},output:{totalTokens:2},cache:{},totalTokens:null,costTotal:0},
    ]) {const request=ledger.start({model,usageContext:context});const result=ledger.finish(request.requestId,{usage});expect(result.usage.costTotal).toBeNull();expect(result.usage.totalTokens).toBeNull();}
    expect(ledger.getBudgetReport().totals).toMatchObject({knownCostCalls:0,unknownCostCalls:2,knownTokens:0,reservedTokens:240});
  }finally{ledger.close();}
});

it('whitelists structured usage fields in SQLite for both success and partial-error observations',async()=>{
  const dbPath=location();const ledger=createUsageLedger({dbPath});
  const usage={input:{totalTokens:10,uncachedTokens:10,extra:'SECRET_NORMALIZED'},output:{totalTokens:2,headers:{Authorization:'SECRET_NORMALIZED'}},cache:{readTokens:0,writeTokens:0,apiKey:'SECRET_NORMALIZED'},totalTokens:12,costTotal:0,metadata:{apiKey:'SECRET_NORMALIZED'}};
  ledger.record({model,usageContext:context,usage});const request=ledger.start({model,usageContext:context});ledger.recordError(request.requestId,new Error('synthetic'), 'error',{usage});ledger.close();
  const {createRequire}=await import('node:module');const db=new (createRequire(import.meta.url)('better-sqlite3'))(dbPath);
  try{expect(JSON.stringify(db.prepare('SELECT document FROM usage_entries').all())).not.toContain('SECRET_NORMALIZED');}finally{db.close();}
});
