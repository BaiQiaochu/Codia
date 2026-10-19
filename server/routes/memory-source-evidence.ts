import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { memoryContentHash } from '../../lib/memory/memory-lifecycle.ts';
/** Exact-ID evidence preview. Never accepts a path from the request or reads another assistant's files. */
export async function readMemorySourceEvidence(engine:any,agent:any,memory:any) {
  const refs=(memory.sourceRefs || []).filter(ref=>ref.sessionId && ref.messageId).slice(0,20);
  const messages:{sessionId:string;messageId:string;role:string;text:string;timestamp:string|null;hashMatches:boolean|null}[]=[];
  const limitations:string[]=[];
  if((memory.sourceRefs || []).length>20)limitations.push('Only the first 20 exact message references are previewed.');
  if(!refs.length)return {messages,missingMessageIds:[],limitations:['This record has no exact message IDs; use its source session and verify manually.']};
  const sessions=await engine.listSessions?.() || [];
  const root=fs.realpathSync(agent.agentDir);
  for(const sessionId of [...new Set<string>(refs.map(ref=>ref.sessionId))]){
    const session=sessions.find(item=>item.agentId===agent.id && [item.sessionId,item.id,path.basename(item.path || '', '.jsonl')].includes(sessionId));
    if(!session?.path){limitations.push(`Source session unavailable: ${sessionId}`);continue;}
    let file:string;
    try{file=fs.realpathSync(session.path);const relative=path.relative(root,file);if(relative.startsWith('..') || path.isAbsolute(relative) || !file.endsWith('.jsonl'))throw new Error('Invalid source location');}catch{limitations.push(`Source session location unavailable: ${sessionId}`);continue;}
    const wanted=refs.filter(ref=>ref.sessionId===sessionId);
    const stream=fs.createReadStream(file,{encoding:'utf8',end:8*1024*1024-1});
    const lines=readline.createInterface({input:stream,crlfDelay:Infinity});
    try{
      for await(const line of lines){
        if(line.length>1024*1024)continue;
        let entry:any;try{entry=JSON.parse(line);}catch{continue;}
        if(entry.type!=='message' || !entry.message)continue;
        const messageId=entry.id || entry.message.id;
        const ref=wanted.find(ref=>ref.messageId===messageId);if(!ref)continue;
        const content=entry.message.content;
        const text=typeof content==='string'?content:Array.isArray(content)?content.filter(block=>block.type==='text' && typeof block.text==='string').map(block=>block.text).join('\n'):'';
        messages.push({sessionId,messageId,role:entry.message.role || 'unknown',text:text.slice(0,8000),timestamp:entry.timestamp || null,hashMatches:ref.evidenceHash?memoryContentHash(JSON.stringify(content || ''))===ref.evidenceHash:null});
        if(messages.filter(message=>message.sessionId===sessionId).length>=wanted.length)break;
      }
      if(fs.statSync(file).size>8*1024*1024)limitations.push(`Source scan is bounded to 8 MiB: ${sessionId}`);
    }catch{limitations.push(`Source session could not be read: ${sessionId}`);}finally{lines.close();stream.destroy();}
  }
  return {messages,missingMessageIds:refs.filter(ref=>!messages.some(message=>message.sessionId===ref.sessionId && message.messageId===ref.messageId)).map(ref=>ref.messageId),limitations};
}
