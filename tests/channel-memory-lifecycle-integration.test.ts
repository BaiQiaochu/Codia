import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('../core/llm-client.ts',()=>({callText:vi.fn()}));
import { callText } from '../core/llm-client.ts';
import { FactStore } from '../lib/memory/fact-store.ts';
import { ChannelRouter } from '../hub/channel-router.ts';
import { compileFacts } from '../lib/memory/compile.ts';
let root:string,store:FactStore,router:any,memory:string;
beforeEach(()=>{
  vi.clearAllMocks();root=fs.mkdtempSync(path.join(os.tmpdir(),'channel-lifecycle-'));const agentsDir=path.join(root,'agents'),agentDir=path.join(agentsDir,'nova');memory=path.join(agentDir,'memory');fs.mkdirSync(memory,{recursive:true});
  fs.writeFileSync(path.join(agentDir,'config.yaml'),'agent:\n  name: Nova\nmemory:\n  enabled: true\n');
  store=new FactStore(path.join(memory,'facts.db'));
  router=new ChannelRouter({hub:{engine:{agentsDir,userDir:path.join(root,'user'),channelsDir:path.join(root,'channels'),productDir:path.join(root,'product'),getAgent:()=>null,resolveUtilityConfig:()=>({utility:'model',api_key:'key',base_url:'http://invalid',api:'openai-completions'})},eventBus:{emit:vi.fn()}}});
});
afterEach(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
it('updates a channel candidate with CAS and source revision instead of forgetting then re-adding it',async()=>{
  vi.mocked(callText).mockResolvedValueOnce('First channel summary').mockResolvedValueOnce('Corrected channel summary');
  await router._memorySummarize('nova','general',{messages:[{id:'m1',sender:'user',body:'first'}]});
  const first=store.getAll()[0];expect(first).toMatchObject({status:'candidate',reviewStatus:'unverified',channelId:'general'});
  await router._memorySummarize('nova','general',{messages:[{id:'m2',sender:'user',body:'second'}]});
  const all=store.getAll();expect(all).toHaveLength(1);expect(all[0]).toMatchObject({id:first.id,revision:2,status:'candidate',fact:'[#general] Corrected channel summary'});
  expect(all[0].sourceRevision).not.toBe(first.sourceRevision);expect(all[0].sourceRefs.some(ref=>ref.messageId==='m2')).toBe(true);
  expect(store.searchFullText('Corrected')).toEqual([]);
  store.update(all[0].id,{status:'active'},all[0].revision);
  expect(store.searchFullText('Corrected',20,{channelId:'general'})).toHaveLength(1);
  await compileFacts({},path.join(memory,'facts.md'),{}, {factStore:store});expect(fs.readFileSync(path.join(memory,'facts.md'),'utf8')).not.toContain('Corrected');
});
it('does not restore a forgotten channel summary from an in-flight model call',async()=>{
  vi.mocked(callText).mockImplementationOnce(async()=>{store.clearAll();return 'Stale channel summary';});
  await router._memorySummarize('nova','general',{messages:[{id:'m1',sender:'user',body:'old context'}]});expect(store.size).toBe(0);
});
it('NO_MEMORY supersedes automatic candidates without deleting user-confirmed facts',async()=>{
  const a=store.add({fact:'Automatic channel fact',session_id:'channel-general',status:'candidate'});
  const b=store.add({fact:'Confirmed channel fact',session_id:'channel-general',reviewStatus:'user_confirmed'});
  vi.mocked(callText).mockResolvedValue('NO_MEMORY');await router._memorySummarize('nova','general','empty context');
  expect(store.getById(a.id).status).toBe('superseded');expect(store.getById(b.id).status).toBe('active');
});
