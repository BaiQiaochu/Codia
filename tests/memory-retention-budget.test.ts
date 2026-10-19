// @ts-nocheck
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { beforeEach,afterEach,describe,it,expect } from 'vitest';
import { FactStore } from '../lib/memory/fact-store.ts';
import { openExperienceStore } from '../lib/experience-store.ts';
import { applyMemoryRetention, deferExtractionForBudget, readRetentionPolicy, writeRetentionPolicy, retentionPolicyRevision } from '../lib/memory/retention-policy.ts';
import { UsageBudgetError } from '../lib/llm/usage-budget-store.ts';
let root, fact, experience;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'memory-retention-'));fs.mkdirSync(path.join(root,'memory'));fact=new FactStore(path.join(root,'memory','facts.db'));experience=openExperienceStore(root);});
afterEach(()=>{fact.close();experience.close();fs.rmSync(root,{recursive:true,force:true});});
const old='2020-01-01T00:00:00.000Z';
describe('conservative memory history retention',()=>{
  it('persists an optional policy and never defaults to removing history',()=>{
    expect(readRetentionPolicy(path.join(root,'memory'))).toEqual({completedExtractionDays:null,ordinaryEventDays:null});
    writeRetentionPolicy(path.join(root,'memory'),{completedExtractionDays:30,ordinaryEventDays:90});
    expect(readRetentionPolicy(path.join(root,'memory')).ordinaryEventDays).toBe(90);
    expect(()=>writeRetentionPolicy(path.join(root,'memory'),{ordinaryEventDays:0})).toThrow();
  });
  it('compacts only completed extraction metadata and keeps source idempotency across restart',()=>{
    const meta={sessionId:'s1',sourceRevision:'r1',extractorVersion:'v1',sourceRefs:[{kind:'message',messageId:'m1'}]};
    const claim=fact.beginExtraction('complete',meta);fact.commitExtraction('complete',[],claim);
    const failed=fact.beginExtraction('failed',meta);fact.failExtraction('failed',new Error('unknown provider result'),failed);
    fact.db.prepare('UPDATE memory_extractions SET updated_at=?').run(old);
    expect(applyMemoryRetention(fact,experience,{completedExtractionDays:1,ordinaryEventDays:1}).compactedExtractions).toBe(1);
    expect(fact.db.prepare("SELECT source_refs FROM memory_extractions WHERE key='failed'").get().source_refs).toContain('m1');
    fact.close();fact=new FactStore(path.join(root,'memory','facts.db'));expect(fact.beginExtraction('complete',meta).status).toBe('succeeded');
  });
  it('archives ordinary events but keeps statistics, deduplication, unknown events and tombstones',()=>{
    const entry=experience.createCandidate({category:'Build',content:'Check real results',applicability:{scope:'project',projectId:'p'},sourceRefs:[{type:'session',id:'s1'}]}).entry;
    const feedback={event:'retrieved',eventId:'read-1',runId:'r1',experienceRevision:1};
    experience.recordFeedback(entry.id,feedback);experience.recordFeedback(entry.id,{event:'unknown',eventId:'u1',runId:'r2',experienceRevision:1});
    experience.db.prepare('UPDATE experience_events SET created_at=?').run(old);
    const report=applyMemoryRetention(fact,experience,{completedExtractionDays:1,ordinaryEventDays:1});
    expect(report.archivedEvents).toBe(1);expect(experience.get(entry.id).stats).toMatchObject({retrieved:1,unknown:1});
    expect(experience.recordFeedback(entry.id,feedback).added).toBe(false);
    expect(experience.db.prepare("SELECT COUNT(*) n FROM experience_events WHERE event='unknown'").get().n).toBe(1);
    experience.invalidateSources([{type:'session',id:'s1'}]);const count=experience.db.prepare('SELECT COUNT(*) n FROM experience_tombstones').get().n;
    applyMemoryRetention(fact,experience,{completedExtractionDays:1,ordinaryEventDays:1});expect(experience.db.prepare('SELECT COUNT(*) n FROM experience_tombstones').get().n).toBe(count);
    expect(()=>experience.createCandidate({category:'Build',content:'Cannot revive',sourceRefs:[{type:'session',id:'s1'}]})).toThrow();
  });
  it('budget rejection queues without spending retry attempts or quarantine',()=>{
    const claim=fact.beginExtraction('waiting',{sessionId:'s',sourceRevision:'r',extractorVersion:'v'});
    expect(deferExtractionForBudget(fact,'waiting',claim,new UsageBudgetError('allowance exhausted','2030-01-01T00:00:00Z','memoryDaily'))).toBe(true);
    expect(fact.getExtractionJobs()[0]).toMatchObject({status:'failed',attempts:0,nextRetryAt:'2030-01-01T00:00:00Z'});
    expect(fact.beginExtraction('waiting',{sessionId:'s',sourceRevision:'r',extractorVersion:'v'}).status).toBe('deferred');
  });
});

it('serializes retention policy CAS across real Node processes',async()=>{
  const memoryDir=path.join(root,'memory');const revision=retentionPolicyRevision(readRetentionPolicy(memoryDir));
  const module=pathToFileURL(path.resolve('lib/memory/retention-policy.ts')).href;
  const child=days=>new Promise((resolve,reject)=>{
    const code=`import { writeRetentionPolicy } from ${JSON.stringify(module)}; try {writeRetentionPolicy(${JSON.stringify(memoryDir)},{completedExtractionDays:${days},ordinaryEventDays:null},${JSON.stringify(revision)});console.log('saved')}catch(e){if(e.status===409)console.log('conflict');else{console.error(e);process.exitCode=1}}`;
    const proc=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let out='',err='';proc.stdout.on('data',b=>out+=b);proc.stderr.on('data',b=>err+=b);proc.on('error',reject);proc.on('exit',code=>code===0?resolve(out.trim()):reject(Error(err)));
  });
  expect((await Promise.all([child(7),child(30)])).sort()).toEqual(['conflict','saved']);
});
