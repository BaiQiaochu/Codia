import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe,it,expect,afterEach,vi } from 'vitest';
import * as runtime from '../lib/memory/runtime-context.ts';
import { openExperienceStore, isExperienceApplicable } from '../lib/experience-store.ts';
import { createExperienceTools } from '../lib/tools/experience.ts';
import { createMemorySearchTool } from '../lib/memory/memory-search.ts';
import { FactStore } from '../lib/memory/fact-store.ts';
const dirs:string[]=[]; afterEach(()=>dirs.splice(0).forEach(dir=>fs.rmSync(dir,{recursive:true,force:true})));
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memory-env-v2-'));dirs.push(dir);fs.mkdirSync(path.join(dir,'.git'));fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({dependencies:{example:'^3.0.0'}}));fs.writeFileSync(path.join(dir,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'node_modules/example':{version:'3.1.2'}}}));const sessionPath=path.join(dir,'session.jsonl');fs.writeFileSync(path.join(dir,'session-meta.json'),JSON.stringify({'session.jsonl':{channelId:'channel-a'}}));const canonicalRoot=fs.realpathSync(dir);const projectId=`workspace:${process.platform==='win32'?canonicalRoot.toLowerCase():canonicalRoot}`;return {dir,projectId,sessionPath,ctx:{sessionManager:{getCwd:()=>dir,getSessionFile:()=>sessionPath}}};}
describe('trusted memory environment v2',()=>{
 it.each([
  {platform:'win32',root:String.raw`C:\Users\Runner\Workspace`,expected:String.raw`workspace:c:\users\runner\workspace`},
  {platform:'darwin',root:'/private/var/Workspace',expected:'workspace:/private/var/Workspace'},
  {platform:'linux',root:'/tmp/Workspace',expected:'workspace:/tmp/Workspace'},
 ] as const)('uses canonical filesystem case for $platform project IDs',({platform,root,expected})=>{
  const platformSpy=vi.spyOn(process,'platform','get').mockReturnValue(platform);
  const realpathSpy=vi.spyOn(fs,'realpathSync').mockReturnValue(root);
  const statSpy=vi.spyOn(fs,'statSync').mockReturnValue({isDirectory:()=>true} as fs.Stats);
  const existsSpy=vi.spyOn(fs,'existsSync').mockImplementation(file=>file===path.join(root,'.git'));
  try {
   expect(runtime.resolveMemoryProjectId('workspace-alias')).toBe(expected);
   expect(realpathSpy).toHaveBeenCalledWith('workspace-alias');
  } finally {
   existsSpy.mockRestore();statSpy.mockRestore();realpathSpy.mockRestore();platformSpy.mockRestore();
  }
 });
 it('constructs actual project, channel metadata and resolved manifest dependencies',()=>{const f=fixture();const context=runtime.buildTrustedMemoryContext({runtimeContext:f.ctx,appVersion:'1.0'});expect(context).toMatchObject({projectId:f.projectId,channel:'channel-a',dependencyVersions:{example:'3.1.2',node:process.versions.node}});expect(isExperienceApplicable({scope:'project',projectId:context.projectId,channel:'channel-a',dependencyVersions:{example:'3.1.2'}},context)).toBe(true);});
 it('unknown channel or dependency fails closed and explains missing environment',()=>{const f=fixture();fs.unlinkSync(path.join(f.dir,'session-meta.json'));fs.unlinkSync(path.join(f.dir,'package-lock.json'));const context=runtime.buildTrustedMemoryContext({runtimeContext:f.ctx});expect(context.channel).toBeNull();expect(context.dependencyVersions.example).toBeUndefined();expect(runtime.experienceApplicabilityDiagnostics({scope:'project',projectId:context.projectId,channel:'channel-a',dependencyVersions:{example:'3.1.2'}},context)).toEqual(expect.arrayContaining(['missing_channel','missing_dependency:example']));});
 it('switches projects without carrying cached prior metadata/dependencies',()=>{const first=fixture(),second=fixture();fs.unlinkSync(path.join(second.dir,'session-meta.json'));fs.unlinkSync(path.join(second.dir,'package-lock.json'));const a=runtime.buildTrustedMemoryContext({runtimeContext:first.ctx});const b=runtime.buildTrustedMemoryContext({runtimeContext:second.ctx});expect(a.projectId).not.toBe(b.projectId);expect(b.channel).toBeNull();expect(b.dependencyVersions.example).toBeUndefined();});
 it('experience production tool never accepts forged applicability from model params',async()=>{const f=fixture();const store=openExperienceStore(f.dir);try{let e=store.createCandidate({category:'Build',content:'Synthetic lockfile check',applicability:{scope:'project',projectId:f.projectId,channel:'channel-a',dependencyVersions:{example:'3.1.2'}}}).entry;e=store.recordReview(e.id,e.revision,{eventId:'review',runId:'actual',reviewerId:'owner',outcome:'success',evidenceRef:'synthetic',summary:'Synthetic report',environment:{projectId:f.projectId,channel:'channel-a',dependencyVersions:{example:'3.1.2'}}});e=store.transition(e.id,e.revision,'validated');store.transition(e.id,e.revision,'enabled');}finally{store.close();}const [tool]=createExperienceTools(f.dir,{isEnabled:()=>true,getContext:(ctx)=>runtime.buildTrustedMemoryContext({runtimeContext:ctx})});const ok=await tool.execute('t1',{query:'lockfile'},f.ctx);if(!('memoryIds' in ok.details))throw new Error('Expected enabled recall result');expect(ok.details.memoryIds).toHaveLength(1);fs.writeFileSync(path.join(f.dir,'session-meta.json'),JSON.stringify({'session.jsonl':{channelId:'wrong'}}));const wrong=await tool.execute('t2',{query:'lockfile',channel:'channel-a',dependencyVersions:{example:'3.1.2'}},f.ctx);if(!('memoryIds' in wrong.details) || !('environmentDiagnostics' in wrong.details))throw new Error('Expected enabled recall diagnostics');expect(wrong.details.memoryIds).toHaveLength(0);expect(wrong.details.environmentDiagnostics).toEqual(['channel_mismatch']);});
 it('memory search resolves third-argument runtime context and enforces channel isolation',async()=>{const f=fixture(),store=new FactStore(':memory:');try{store.add({fact:'SYNTHETIC cobalt',projectId:f.projectId,channelId:'other'});const tool=createMemorySearchTool(store,{getContext:(ctx)=>runtime.buildTrustedMemoryContext({runtimeContext:ctx})});const result=await tool.execute('t',{query:'cobalt'},f.ctx);expect(result.details.resultCount).toBe(0);fs.writeFileSync(path.join(f.dir,'session-meta.json'),JSON.stringify({'session.jsonl':{channelId:'other'}}));const matching=await tool.execute('matching-channel',{query:'cobalt'},f.ctx);expect(matching.details.resultCount).toBe(1);}finally{store.close();}});
 it('uses only trusted bridge metadata for channel fallback',()=>{const f=fixture();fs.unlinkSync(path.join(f.dir,'session-meta.json'));const context=runtime.buildTrustedMemoryContext({runtimeContext:f.ctx,bridgeMetadata:{chatType:'channel',platform:'slack',chatId:'C123'}});expect(context.channel).toBe('bridge:slack:C123');expect(runtime.buildTrustedMemoryContext({runtimeContext:f.ctx,bridgeMetadata:{chatType:'dm',platform:'slack',chatId:'D123'}}).channel).toBeNull();});

});
