import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
vi.mock('../lib/memory/compile.ts',()=>({compileToday:vi.fn().mockResolvedValue('compiled'),compileWeek:vi.fn().mockResolvedValue('compiled'),compileLongterm:vi.fn().mockResolvedValue('compiled'),compileFacts:vi.fn().mockResolvedValue('compiled'),compileEditableFacts:vi.fn().mockResolvedValue('compiled'),assemble:vi.fn(),editableFactsPath:(dir:string)=>path.join(dir,'editable-facts.md'),ensureEditableFactsBaseline:vi.fn()}));
vi.mock('../lib/experience-extractor.ts',()=>({EXPERIENCE_EXTRACTOR_VERSION:'candidate-v1',extractSessionExperiences:vi.fn()}));
vi.mock('../core/llm-client.ts',()=>({callText:vi.fn().mockResolvedValue('[]')}));
import {extractSessionExperiences} from '../lib/experience-extractor.ts';
import {callText} from '../core/llm-client.ts';
import {createMemoryTicker} from '../lib/memory/memory-ticker.ts';
import {FactStore} from '../lib/memory/fact-store.ts';
import {buildTrustedMemoryContext,buildRecordedMemoryContext,persistMemoryRuntimeSnapshot} from '../lib/memory/runtime-context.ts';
let root:string,sessionPath:string,store:FactStore,ticker:any,makeTicker:()=>any,summaryManager:any;
beforeEach(()=>{
 vi.clearAllMocks();root=fs.mkdtempSync(path.join(os.tmpdir(),'codia-history-env-'));
 const memoryDir=path.join(root,'memory'),sessionDir=path.join(root,'sessions');fs.mkdirSync(memoryDir);fs.mkdirSync(sessionDir);fs.mkdirSync(path.join(root,'.git'));
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({dependencies:{example:'^1'}}));fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify({packages:{'node_modules/example':{version:'1.0.0'}}}));
 sessionPath=path.join(sessionDir,'s1.jsonl');fs.writeFileSync(sessionPath,JSON.stringify({type:'message',id:'m1',timestamp:new Date().toISOString(),message:{role:'user',content:'synthetic task'}})+'\n');
 fs.writeFileSync(path.join(sessionDir,'session-meta.json'),JSON.stringify({'s1.jsonl':{cwd:root,channelId:'old-channel'}}));
 store=new FactStore(path.join(memoryDir,'facts.db'));
 const summary={session_id:'s1',summary:'### Key Facts\nNone\n\n### Events\n'+('Synthetic old task evidence. '.repeat(8)),updated_at:new Date().toISOString(),snapshot:'',sourceRefs:[{kind:'message',messageId:'m1',author:'user'}]};
 summaryManager={rollingSummary:vi.fn(),getSummary:()=>summary,getDirtySessions:vi.fn(()=>[]),markProcessed:vi.fn(),getAllSummaries:()=>[summary]};
 makeTicker=()=>createMemoryTicker({agentId:'a',agentDir:root,memoryDir,sessionDir,summaryManager,factStore:store,getResolvedMemoryModel:()=>({}),getMemoryMasterEnabled:()=>true,getExperienceEnabled:()=>true,getBridgeContextForSessionPath:()=>({chatType:'channel',platform:'new-provider',chatId:'new-chat'}),memoryMdPath:path.join(memoryDir,'memory.md'),todayMdPath:path.join(memoryDir,'today.md'),weekMdPath:path.join(memoryDir,'week.md'),longtermMdPath:path.join(memoryDir,'longterm.md'),factsMdPath:path.join(memoryDir,'facts.md')});
 ticker=makeTicker();
});
afterEach(async()=>{await ticker?.stop();store.close();fs.rmSync(root,{recursive:true,force:true});});
it('extracts and retries using the recorded historical environment after metadata/manifests change',async()=>{
 const recorded=buildTrustedMemoryContext({sessionPath,appVersion:'1.0.0'});persistMemoryRuntimeSnapshot(sessionPath,{...recorded,cwd:root,provenance:'recorded'});
 fs.writeFileSync(path.join(root,'sessions/session-meta.json'),JSON.stringify({'s1.jsonl':{cwd:root,channelId:'new-channel'}}));
 fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify({packages:{'node_modules/example':{version:'2.0.0'}}}));
 vi.mocked(extractSessionExperiences).mockResolvedValueOnce({extracted:0,status:'failed',error:'synthetic failure'}).mockResolvedValueOnce({extracted:1,status:'succeeded'});
 ticker.notifyTurn(sessionPath);await ticker.notifySessionEnd(sessionPath);
 const first=vi.mocked(extractSessionExperiences).mock.calls[0][4];
 expect(first).toMatchObject({projectId:`workspace:${root}`,channel:'old-channel',appVersion:'1.0.0',dependencyVersions:{example:'1.0.0'}});
 const job=store.getExtractionJobs()[0];await ticker.stop();store.retryExtraction(job.key);ticker=makeTicker();await ticker.tick();
 expect(vi.mocked(extractSessionExperiences).mock.calls[1][4]).toMatchObject({projectId:`workspace:${root}`,channel:'old-channel',appVersion:'1.0.0',dependencyVersions:{example:'1.0.0'}});
 // Live recall deliberately follows the present environment, unlike historical extraction.
 expect(buildTrustedMemoryContext({sessionPath,appVersion:'2.0.0'})).toMatchObject({channel:'new-channel',appVersion:'2.0.0',dependencyVersions:{example:'2.0.0'}});
});
it('keeps all historical environment unknown without a recorded snapshot despite current metadata',async()=>{
 vi.mocked(extractSessionExperiences).mockResolvedValue({extracted:0,status:'succeeded'});
 ticker.notifyTurn(sessionPath);await ticker.notifySessionEnd(sessionPath);
 expect(vi.mocked(extractSessionExperiences).mock.calls[0][4]).toMatchObject({projectId:null,channel:null,platform:null,appVersion:null,dependencyVersions:{},environmentDiagnostics:expect.arrayContaining(['missing_recorded_environment'])});
});

it('preserves the first snapshot and suspends learning after resumed session environment changes',async()=>{
 const first={...buildTrustedMemoryContext({sessionPath,appVersion:'1.0.0'}),cwd:root,provenance:'recorded' as const};
 persistMemoryRuntimeSnapshot(sessionPath,first);
 persistMemoryRuntimeSnapshot(sessionPath,{...first,runId:'another-run',sessionId:'another-id'});
 expect(buildRecordedMemoryContext(sessionPath)).toMatchObject({provenance:'recorded',appVersion:'1.0.0'});
 persistMemoryRuntimeSnapshot(sessionPath,{...first,channel:'new-channel',appVersion:'2.0.0',dependencyVersions:{example:'2.0.0'}});
 persistMemoryRuntimeSnapshot(sessionPath,first); // Ambiguity is sticky even after returning to the original environment.
 const document=JSON.parse(fs.readFileSync(`${sessionPath}.memory-runtime.json`,'utf8'));
 expect(document).toMatchObject({ambiguous:true,environment:{channel:'old-channel',appVersion:'1.0.0'}});
 expect(buildRecordedMemoryContext(sessionPath)).toMatchObject({projectId:null,channel:null,appVersion:null,dependencyVersions:{},environmentDiagnostics:['ambiguous_recorded_environment']});
 summaryManager.getDirtySessions.mockReturnValue([summaryManager.getSummary()]);
 ticker.notifyTurn(sessionPath);await ticker.notifySessionEnd(sessionPath);await ticker.tick();
 expect(summaryManager.rollingSummary).not.toHaveBeenCalled();expect(extractSessionExperiences).not.toHaveBeenCalled();
 expect(store.getExtractionJobs()).toHaveLength(0);expect(store.exportAll()).toHaveLength(0);
 expect(ticker.getHealthStatus().deepMemory.extraction).toMatchObject({deferred:1});
});
it('uses memory project scope instead of the user session classification for rolling summaries',async()=>{
 fs.writeFileSync(path.join(root,'sessions/session-meta.json'),JSON.stringify({'s1.jsonl':{projectId:'project-user-selected',memoryProjectId:`workspace:${root}`,channelId:'old-channel'}}));
 vi.mocked(extractSessionExperiences).mockResolvedValue({extracted:0,status:'succeeded'});
 ticker.notifyTurn(sessionPath);await ticker.notifySessionEnd(sessionPath);
 expect(summaryManager.rollingSummary.mock.calls[0][3]).toMatchObject({projectId:`workspace:${root}`,channelId:'old-channel'});
});

it('rejects facts at commit if the session environment changes during extraction',async()=>{
 const first={...buildTrustedMemoryContext({sessionPath,appVersion:'1.0.0'}),cwd:root,provenance:'recorded' as const};
 persistMemoryRuntimeSnapshot(sessionPath,first);
 summaryManager.getDirtySessions.mockReturnValue([summaryManager.getSummary()]);
 vi.mocked(callText).mockImplementationOnce(async()=>{
  persistMemoryRuntimeSnapshot(sessionPath,{...first,appVersion:'2.0.0'});
  return JSON.stringify([{fact:'Synthetic fact must not be committed',tags:['test']}]);
 });
 await ticker.tick();
 expect(callText).toHaveBeenCalled();expect(store.exportAll()).toHaveLength(0);
 expect(store.getExtractionJobs()).toEqual([expect.objectContaining({status:'failed',error:expect.stringContaining('ambiguous')})]);
});
