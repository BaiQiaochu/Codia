import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../core/llm-client.ts',()=>({callText:vi.fn()}));
import { callText } from '../core/llm-client.ts';
import { SessionSummaryManager } from '../lib/memory/session-summary.ts';
import { openExperienceStore } from '../lib/experience-store.ts';
import { captureMemoryEvidenceEpoch } from '../lib/memory/prompt-guard.ts';
import { writeCompiledEligibility } from '../lib/memory/compiled-memory-state.ts';
let root:string, memory:string, manager:SessionSummaryManager;
const model={model:'fixture',api:'openai-completions',api_key:'fixture',base_url:'http://invalid'};
const output='### Key Facts\nNo stable facts.\n\n### Timeline\nDiscussed a current project.';
const messages=()=>[{role:'user',content:'Fresh current question',timestamp:new Date().toISOString()}];
function withStore(fn:any) {const store=openExperienceStore(root);try{return fn(store);}finally{store.close();}}
function addExperience(content='Old sourced lesson') {return withStore((store:any)=>store.createCandidate({category:'debug',content,applicability:{scope:'global'}}).entry);}
function withdraw(entry:any) {withStore((store:any)=>store.transition(entry.id,entry.revision,'withdrawn'));}
function seed(extra:any={}) {manager.saveSummary('s1',{session_id:'s1',summary:'Old summary evidence',snapshot:'',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),memoryEvidenceEpoch:captureMemoryEvidenceEpoch(root),...extra});}
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));vi.mocked(callText).mockReset().mockResolvedValue(output);
  root=fs.mkdtempSync(path.join(os.tmpdir(),'summary-epoch-'));memory=path.join(root,'memory');fs.mkdirSync(memory);manager=new SessionSummaryManager(path.join(memory,'summaries'));
});
afterEach(()=>{vi.useRealTimers();fs.rmSync(root,{recursive:true,force:true});});

describe('rolling summary evidence epochs',()=>{
  it('checks warm caches and all listing paths after withdrawal, while benign additions preserve summaries',()=>{
    const original=addExperience();seed();expect(manager.getSummary('s1')).not.toBeNull();
    addExperience('Another independent candidate');expect(manager.getSummary('s1')).not.toBeNull();
    withdraw(original);expect(manager.getSummary('s1')).toBeNull();expect(manager.getAllSummaries()).toEqual([]);expect(manager.getDirtySessions()).toEqual([]);
    expect(new SessionSummaryManager(path.join(memory,'summaries')).getSummary('s1')).toBeNull();
  });
  it('rejects legacy unversioned summaries after an existing experience withdrawal',()=>{
    const entry=addExperience();seed({memoryEvidenceEpoch:undefined});expect(manager.getSummary('s1')).not.toBeNull();withdraw(entry);
    expect(manager.getSummary('s1')).toBeNull();expect(manager.getAllSummaries()).toEqual([]);
  });
  it('keeps each summary bound to its own expiry across cache hits, disk recompiles and restart',()=>{
    writeCompiledEligibility(memory,[{expiresAt:'2026-10-19T12:01:00.000Z'}]);seed();expect(manager.getSummary('s1')).not.toBeNull();
    vi.setSystemTime(new Date('2026-10-19T12:01:01.000Z'));writeCompiledEligibility(memory,[]);
    expect(manager.getSummary('s1')).toBeNull();expect(manager.getAllSummaries()).toEqual([]);expect(manager.getDirtySessions()).toEqual([]);
    expect(new SessionSummaryManager(path.join(memory,'summaries')).getSummary('s1')).toBeNull();
  });
  it('drops an in-flight rolling result after experience withdrawal',async()=>{
    const entry=addExperience();vi.mocked(callText).mockImplementationOnce(async()=>{withdraw(entry);return output;});
    expect(await manager.rollingSummary('s1',messages(),model)).toBe('');expect(manager.getSummary('s1')).toBeNull();expect(fs.readdirSync(path.join(memory,'summaries'))).toEqual([]);
  });
  it('drops an in-flight rolling result when an included source expires',async()=>{
    writeCompiledEligibility(memory,[{expiresAt:'2026-10-19T12:01:00.000Z'}]);
    vi.mocked(callText).mockImplementationOnce(async()=>{vi.setSystemTime(new Date('2026-10-19T12:01:01.000Z'));return output;});
    expect(await manager.rollingSummary('s1',messages(),model)).toBe('');expect(manager.getSummary('s1')).toBeNull();
  });
  it('cleans old tool, compaction, previous summary and reflection material before the model without rewriting raw inputs',async()=>{
    const entry=addExperience();const oldEpoch=captureMemoryEvidenceEpoch(root);seed();const oldGeneration=withStore((store:any)=>store.generation);
    const raw=[...messages(),{role:'toolResult',toolName:'recall_experience',content:`[codia-experience-generation:${oldGeneration}]\nobsolete tool lesson`},{role:'compactionSummary',summary:'obsolete compaction lesson',content:'obsolete compaction lesson',details:{memoryEvidenceEpoch:oldEpoch}}];
    const original=JSON.stringify(raw);withdraw(entry);
    await manager.rollingSummary('s1',raw,model,{memoryReflectionSnapshot:{existingMemory:'obsolete reflection',userProfile:'obsolete profile'}});
    const input=JSON.stringify(vi.mocked(callText).mock.calls[0][0]);expect(input).toContain('Fresh current question');expect(input).not.toMatch(/obsolete|Old summary evidence/);expect(JSON.stringify(raw)).toBe(original);
    expect(manager.getSummary('s1').memoryEvidenceEpoch.experienceGeneration).not.toBe(oldEpoch.experienceGeneration);
  });
  it('rechecks a returned draft at the final synchronous save boundary',async()=>{
    const entry=addExperience();const draft=await manager.createRollingSummaryDraft('s1',messages(),model);expect(draft.data.memoryEvidenceEpoch).toBeDefined();withdraw(entry);
    expect(()=>manager.saveSummary('s1',draft.data)).toThrow(/Memory evidence changed/);expect(manager.getSummary('s1')).toBeNull();
  });
  it('allows benign experience additions while a summary model call is in flight',async()=>{
    vi.mocked(callText).mockImplementationOnce(async()=>{addExperience('A harmless new candidate');return output;});
    expect(await manager.rollingSummary('s1',messages(),model)).toBe(output);expect(manager.getSummary('s1').memoryEvidenceEpoch).toBeDefined();
  });
  it('does not return an old summary on empty model output after withdrawal', async () => {
    const entry = addExperience(); seed();
    vi.mocked(callText).mockImplementationOnce(async () => { withdraw(entry); return ''; });
    expect(await manager.rollingSummary('s1', messages(), model)).toBe('');
  });
  it('inherits an adopted reflection snapshot expiry even if disk was recompiled', async () => {
    const memoryEvidenceEpoch = { ...captureMemoryEvidenceEpoch(root), expiresAt: '2026-10-19T12:01:00.000Z' };
    vi.mocked(callText).mockImplementationOnce(async () => { vi.setSystemTime(new Date('2026-10-19T12:01:01.000Z')); return output; });
    expect(await manager.rollingSummary('s1', messages(), model, { memoryReflectionSnapshot: { existingMemory: 'Short-lived background', memoryEvidenceEpoch } })).toBe('');
  });

});
