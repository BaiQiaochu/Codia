// @ts-nocheck
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { Hono } from 'hono';import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { createUsageMaintenanceRoute } from '../server/routes/usage-maintenance.ts';
import { createConfigRoute } from '../server/routes/config.ts';
import { createUsageLedger } from '../lib/llm/usage-ledger.ts';
import { FactStore } from '../lib/memory/fact-store.ts';
import { commandUsage } from '../lib/cli/usage-maintenance.ts';
let root,engine,agent,app,principal;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'usage-route-'));fs.mkdirSync(path.join(root,'memory'));agent={id:'a',agentDir:root,factStore:new FactStore(path.join(root,'memory','facts.db'))};engine={usageLedger:createUsageLedger(),getAgent:id=>id==='a'?agent:null};principal={kind:'account_user',principalId:'owner',scopes:['settings.read','settings.write']};app=new Hono();app.use('*',async(c,next)=>{c.set('authPrincipal',principal);await next();});app.route('/api',createUsageMaintenanceRoute(engine));app.route('/api',createConfigRoute(engine));});
afterEach(()=>{engine.usageLedger.close();agent.factStore.close();fs.rmSync(root,{recursive:true,force:true});});
const send=(url,body,method='PATCH')=>app.request(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
describe('budget and retention settings API',()=>{
  it('uses authorization and compare-and-swap configuration writes',async()=>{
    let report=await(await app.request('/api/usage/budget')).json();expect((await send('/api/usage/budget',{config:{daily:{maxCalls:1}},expectedRevision:report.revision})).status).toBe(200);
    expect((await send('/api/usage/budget',{config:{daily:{maxCalls:2}},expectedRevision:report.revision})).status).toBe(400);
    principal.scopes=['settings.read'];expect((await send('/api/usage/budget',{config:{},expectedRevision:1})).status).toBe(403);
    principal.scopes=[];expect((await app.request('/api/usage/budget')).status).toBe(403);
  });
  it('mounts maintenance before dynamic memory IDs and requires explicit cleanup confirmation',async()=>{
    const url='/api/memories/maintenance?agentId=a';const report=await(await app.request(url)).json();
    const saved=await send(url,{policy:{completedExtractionDays:30,ordinaryEventDays:90},expectedRevision:report.revision});expect(saved.status).toBe(200);const next=await saved.json();
    expect(next.policy.ordinaryEventDays).toBe(90);expect((await send(url,{expectedRevision:next.revision},'POST')).status).toBe(400);
    expect((await send(url,{confirmed:true,expectedRevision:next.revision},'POST')).status).toBe(200);
    expect((await app.request('/api/memories/maintenance?agentId=missing')).status).toBe(404);
    const source=fs.readFileSync(path.resolve('server/index.ts'),'utf8');expect(source.indexOf('app.route("/api", createUsageMaintenanceRoute(engine))')).toBeLessThan(source.indexOf('app.route("/api", createConfigRoute(engine))'));
  });
  it('rejects concurrent retention saves sharing an old revision',async()=>{
    const url='/api/memories/maintenance?agentId=a';const report=await(await app.request(url)).json();
    const results=await Promise.all([send(url,{expectedRevision:report.revision,policy:{completedExtractionDays:7,ordinaryEventDays:null}}),send(url,{expectedRevision:report.revision,policy:{completedExtractionDays:null,ordinaryEventDays:30}})]);
    expect(results.map(result=>result.status).sort()).toEqual([200,409]);
  });
  it('rejects stale cleanup confirmation after a competing policy save',async()=>{
    const url='/api/memories/maintenance?agentId=a';const report=await(await app.request(url)).json();
    const results=await Promise.all([send(url,{expectedRevision:report.revision,policy:{completedExtractionDays:7,ordinaryEventDays:30}}),send(url,{expectedRevision:report.revision,confirmed:true},'POST')]);
    expect(results.map(result=>result.status)).toEqual([200,409]);
  });
  it('CLI reuses the API revision and requires explicit retention apply confirmation',async()=>{
    const client={get:vi.fn().mockResolvedValue({revision:3}),request:vi.fn().mockResolvedValue({ok:true}),post:vi.fn().mockResolvedValue({ok:true})};const write=vi.fn();
    await commandUsage(client,['budget','set','{"daily":{"maxCalls":10}}'],{},write);
    expect(client.request).toHaveBeenCalledWith('PATCH','/api/usage/budget',{body:{config:{daily:{maxCalls:10}},expectedRevision:3}});
    await expect(commandUsage(client,['retention','a','apply'],{},write)).rejects.toThrow(/confirm/);expect(client.post).not.toHaveBeenCalled();
  });
});
