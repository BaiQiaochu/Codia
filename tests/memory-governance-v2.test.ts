import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createConfigRoute } from '../server/routes/config.ts';
import { FactStore } from '../lib/memory/fact-store.ts';
import { memoryContentHash } from '../lib/memory/memory-lifecycle.ts';
import { classifyHttpRoute } from '../server/http/route-security.ts';
import { openExperienceStore } from '../lib/experience-store.ts';

describe('memory governance v2 HTTP composition', () => {
  let dir: string, agent: any, engine: any, app: Hono, principal: any;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-governance-v2-'));
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    agent = { id: 'alpha', agentDir: dir, memoryMdPath: path.join(dir, 'memory/memory.md'), summariesDir: path.join(dir, 'memory/summaries'), factStore: new FactStore(path.join(dir, 'memory/facts.db')), summaryManager: { clearCache: vi.fn() } };
    engine = { config: {}, getAgent: (id: string) => id === 'alpha' ? agent : null, updateConfig: vi.fn().mockResolvedValue(undefined) };
    principal = { kind: 'account_user', principalId: 'user:owner', scopes: ['settings.read', 'settings.write'] };
    app = new Hono(); app.use('*', async (c, next) => { c.set('authPrincipal' as never, principal); await next(); });
    app.route('/api', createConfigRoute(engine));
  });
  afterEach(() => { agent.factStore.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = (url: string, body: unknown) => app.request(`/api/memories${url}?agentId=alpha`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('retires unsafe legacy HTTP export/import and never widens expired project facts', async () => {
    agent.factStore.add({ fact: 'SYNTHETIC cobalt', projectId: 'workspace:/synthetic/amber', expiresAt: '2020-01-01', status: 'active', sourceRefs: [{kind:'message',messageId:'m1'}] });
    const oldPayload = { version: 2, facts: agent.factStore.exportAll() };
    expect((await app.request('/api/memories/export?agentId=alpha')).status).toBe(410);
    const result = await send('/import', oldPayload);
    expect(result.status).toBe(410);
    expect((await result.json()).code).toBe('unsafe_memory_format_retired');
    expect(agent.factStore.searchFullText('cobalt')).toHaveLength(0);
    expect(agent.factStore.exportAll()).toHaveLength(1);
    expect(agent.factStore.exportAll()[0]).toMatchObject({ projectId: 'workspace:/synthetic/amber', expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(engine.updateConfig).not.toHaveBeenCalled();
  });
  it('queries bounded pages and totals in SQL without loading full records', async () => {
    agent.factStore.addBatch(Array.from({length:10000}, (_,i) => ({fact:`SYNTHETIC fact ${i}`,projectId:'workspace:/synthetic/old',session_id:'session-old',status:'candidate'})));
    const exportSpy = vi.spyOn(agent.factStore, 'exportAll');
    const result = await app.request('/api/memories?agentId=alpha&limit=10&offset=20&projectId=workspace%3A%2Fsynthetic%2Fold&reviewOnly=true&q=SYNTHETIC');
    const body = await result.json();
    expect(result.status).toBe(200); expect(body.memories).toHaveLength(10); expect(body.total).toBe(10000); expect(body.pendingTotal).toBe(10000); expect(body.offset).toBe(20);
    expect(exportSpy).not.toHaveBeenCalled();
    expect(body.projects).toContainEqual({id:'workspace:/synthetic/old',label:'old'});
  });
  it('batch applies explicit IDs only and returns per-item CAS conflicts', async () => {
    agent.factStore.addBatch(['one','two','three'].map(fact => ({fact,status:'candidate'})));
    const rows = agent.factStore.getAll();
    const result = await send('/batch', { operation:'confirm',confirmed:true,items:[{id:rows[0].id,expectedRevision:rows[0].revision},{id:rows[1].id,expectedRevision:99}] });
    const body = await result.json(); expect(result.status).toBe(200);
    expect(body.results[0]).toMatchObject({id:rows[0].id,ok:true,memory:{status:'active'}});
    expect(body.results[1]).toMatchObject({id:rows[1].id,ok:false,code:'revision_conflict',current:{status:'candidate'}});
    expect(agent.factStore.getById(rows[2].id).status).toBe('candidate');
  });
  it('pages experiences and extraction jobs with cross-page pending counts', async () => {
    const store = openExperienceStore(dir);
    try { for(let i=0;i<12;i++) store.createCandidate({category:'Build',content:`SYNTHETIC lesson ${i}`,applicability:{scope:'project',projectId:'workspace:/synthetic/old'},sourceRefs:[{type:'session',id:'old-session'}]}); } finally {store.close();}
    for(let i=0;i<12;i++) { const claim=agent.factStore.beginExtraction(`job-${i}`,{sessionId:'old-session',sourceRevision:'v1',extractorVersion:'v1'});agent.factStore.failExtraction(`job-${i}`,new Error('synthetic'),claim,{maxAttempts:1}); }
    for (const [suffix,key] of [['experiences','entries'],['extractions','jobs']]) {
      const body=await (await app.request(`/api/memories/${suffix}?agentId=alpha&limit=5&offset=5&source=old-session&reviewOnly=true`)).json();
      expect(body[key]).toHaveLength(5);expect(body.total).toBe(12);expect(body.pendingTotal).toBe(12);
    }
  });
  it('binds adoption and review to a recorded run, ignores forged body environment and deduplicates adoption', async()=>{
    fs.mkdirSync(path.join(dir,'.git'));
    engine.activityHub={list:()=>[{id:'actual',agentId:'alpha',status:'succeeded',startedAt:1000,finishedAt:2000,environment:{cwd:dir,projectId:`workspace:${dir}`,platform:'linux',channel:'test',dependencyVersions:{example:'1.0.0'}}}]};
    const store=openExperienceStore(dir);let entry:any;
    try{entry=store.createCandidate({category:'Build',content:'SYNTHETIC verified run',applicability:{scope:'project',projectId:`workspace:${dir}`,channel:'test',dependencyVersions:{example:'1.0.0'}}}).entry;}finally{store.close();}
    const runs=await (await app.request('/api/memories/runs?agentId=alpha')).json();expect(runs.runs[0]).toMatchObject({runId:'workflow:actual',status:'succeeded',projectId:`workspace:${dir}`,evidenceOrigin:'recorded_run'});
    const attempt={runId:'workflow:actual',confirmed:true,expectedRevision:entry.revision};
    expect((await (await send(`/experiences/${entry.id}/attempt`,attempt)).json()).entry.stats.attempted).toBe(1);
    const duplicate=await (await send(`/experiences/${entry.id}/attempt`,attempt)).json();expect(duplicate.added).toBe(false);expect(duplicate.entry.stats.attempted).toBe(1);
    const reviewed=await send(`/experiences/${entry.id}/review`,{...attempt,evidenceOrigin:'recorded_run',eventId:'review-real',summary:'Human inspected the actual report',outcome:'success',environment:{projectId:'forged'},evidenceRef:'forged'});
    expect(reviewed.status).toBe(200);const body=await reviewed.json();expect(body.entry.state).toBe('candidate');expect(body.entry.evidence[0]).toMatchObject({evidenceOrigin:'recorded_run',evidenceRef:'task-console:workflow:actual',environment:{projectId:`workspace:${dir}`},runSnapshot:{status:'succeeded'}});
    expect((await send(`/experiences/${entry.id}/attempt`,{...attempt,runId:'fabricated'})).status).toBe(404);
    principal.kind='agent';expect((await send(`/experiences/${entry.id}/attempt`,attempt)).status).toBe(403);
  });
  it('does not turn a current session environment or pending run into historical success', async()=>{
    engine.activityHub={list:()=>[{id:'pending',agentId:'alpha',status:'running',sessionPath:'synthetic-session'}]};engine.getSessionCwd=()=>dir;
    const store=openExperienceStore(dir);let entry:any;try{entry=store.createCandidate({category:'Build',content:'SYNTHETIC',applicability:{scope:'project',projectId:`workspace:${dir}`}}).entry;}finally{store.close();}
    const body={runId:'workflow:pending',confirmed:true,expectedRevision:entry.revision,evidenceOrigin:'recorded_run',eventId:'pending',summary:'It claims success',outcome:'success',environment:{projectId:`workspace:${dir}`}};
    const result=await send(`/experiences/${entry.id}/review`,body);expect(result.status).toBe(400);expect((await result.json()).code).toBe('run_outcome_mismatch');
    const attempt=await send(`/experiences/${entry.id}/attempt`,body);expect(attempt.status).toBe(400);expect((await attempt.json()).environmentDiagnostics).toContain('missing_project');
  });
  it('labels external evidence and prohibits stale content from using prior run evidence',async()=>{
    const store=openExperienceStore(dir);let entry:any;try{entry=store.createCandidate({category:'Build',content:'SYNTHETIC',applicability:{scope:'global'}}).entry;}finally{store.close();}
    const result=await send(`/experiences/${entry.id}/review`,{runId:'outside',confirmed:true,expectedRevision:1,evidenceOrigin:'external_manual',eventId:'manual',summary:'Human supplied unparsed external report',outcome:'unknown',environment:{},evidenceRef:'external:report'});
    expect(result.status).toBe(200);expect((await result.json()).entry.evidence[0].evidenceOrigin).toBe('external_manual');
    expect((await send(`/experiences/${entry.id}/attempt`,{runId:'outside',expectedRevision:1,confirmed:true})).status).toBe(404);
  });

  it('finds old project IDs beyond bounded default facets and enforces new route scopes',async()=>{
    agent.factStore.addBatch(Array.from({length:205},(_,i)=>({fact:`project-${i}`,projectId:`workspace:/old/project-${String(i).padStart(3,'0')}`})));
    const result=await app.request('/api/memories/projects?agentId=alpha&q=project-204&limit=5');
    expect(result.status).toBe(200);expect((await result.json()).projects).toEqual([{id:'workspace:/old/project-204',label:'project-204'}]);
    for(const suffix of ['/runs','/projects','/1/evidence'])expect(classifyHttpRoute({method:'GET',path:`/api/memories${suffix}`})).toEqual({kind:'scope',scope:'settings.read'});
    for(const suffix of ['/batch','/experiences/e1/attempt'])expect(classifyHttpRoute({method:'POST',path:`/api/memories${suffix}`})).toEqual({kind:'scope',scope:'settings.write'});
  });
  it('locates exact message evidence and reports source corrections without arbitrary file reads',async()=>{
    const sessionPath=path.join(dir,'source.jsonl'),content='SYNTHETIC original source';
    fs.writeFileSync(sessionPath,JSON.stringify({type:'message',id:'m-exact',timestamp:'2026-01-01T00:00:00Z',message:{role:'user',content}})+'\n');
    engine.listSessions=async()=>[{sessionId:'s-exact',path:sessionPath,agentId:'alpha'}];
    const fact=agent.factStore.add({fact:'SYNTHETIC fact',sourceRefs:[{kind:'message',sessionId:'s-exact',messageId:'m-exact',evidenceHash:memoryContentHash(JSON.stringify(content))}]});
    const read=()=>app.request(`/api/memories/${fact.id}/evidence?agentId=alpha`);
    expect((await (await read()).json()).messages[0]).toMatchObject({messageId:'m-exact',text:content,hashMatches:true});
    fs.writeFileSync(sessionPath,JSON.stringify({type:'message',id:'m-exact',message:{role:'user',content:'SYNTHETIC corrected'}})+'\n');
    expect((await (await read()).json()).messages[0].hashMatches).toBe(false);
    engine.listSessions=async()=>[{sessionId:'s-exact',path:'/etc/passwd',agentId:'alpha'}];
    const denied=await (await read()).json();expect(denied.messages).toEqual([]);expect(denied.missingMessageIds).toEqual(['m-exact']);
  });
  it('archives ordinary feedback without losing counters or retry receipts',()=>{
    const store=openExperienceStore(dir);
    try{
      const entry=store.createCandidate({category:'Build',content:'SYNTHETIC archive',applicability:{scope:'global'}}).entry;
      const feedback={runId:'r',eventId:'t',experienceRevision:1,event:'retrieved' as const};
      store.recordFeedback(entry.id,feedback);
      store.db.exec("INSERT INTO experience_event_receipts SELECT event_key,experience_id,run_id,event,experience_revision,payload,created_at FROM experience_events WHERE event='retrieved';DELETE FROM experience_events WHERE event='retrieved';");
      expect(store.get(entry.id)?.stats.retrieved).toBe(1);expect(store.recordFeedback(entry.id,feedback).added).toBe(false);expect(store.get(entry.id)?.stats.retrieved).toBe(1);
    }finally{store.close();}
  });

  it('does not infer historical project identity from a presently readable recorded cwd',async()=>{
    fs.mkdirSync(path.join(dir,'.git'));
    engine.activityHub={list:()=>[{id:'old-cwd',agentId:'alpha',status:'done',environment:{cwd:dir}}]};
    const result=await (await app.request('/api/memories/runs?agentId=alpha')).json();
    expect(result.runs[0]).toMatchObject({projectId:null,environment:{projectId:null},environmentDiagnostics:expect.arrayContaining(['missing_project'])});
  });

});
