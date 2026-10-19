import fs from 'node:fs';
import path from 'node:path';

/** Derive applicability from the trusted executor cwd, not model-provided tool arguments. */
export function resolveMemoryProjectId(cwd?: string | null): string | null {
  if (!cwd || typeof cwd !== 'string') return null;
  let current: string;
  try {
    current = fs.realpathSync(cwd);
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch { return null; }
  const start = current;
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) { current = start; break; }
    current = parent;
  }
  const normalized = process.platform === 'win32' ? current.toLowerCase() : current;
  return `workspace:${normalized}`;
}

export type TrustedMemoryEnvironment = {
  projectId: string | null; channel: string | null; platform: string; appVersion: string | null;
  dependencyVersions: Record<string,string>; sessionId: string | null; runId: string | null;
  environmentDiagnostics: string[];
};
type RuntimeInput = { runtimeContext?: any; cwd?: string | null; sessionPath?: string | null; sessionMetadata?: Record<string,any>; appVersion?: string | null; bridgeMetadata?: {chatType?:string;channelId?:string;sessionKey?:string;platform?:string;chatId?:string}; runtimeSnapshot?: {projectId?:string|null;dependencyVersions?:Record<string,string>} };
function readSmallJson(file: string) {
  try { if(fs.statSync(file).size > 4*1024*1024)return null;return JSON.parse(fs.readFileSync(file,'utf8')); } catch {return null;}
}
export function readMemorySessionMetadata(sessionPath?: string | null): Record<string,any> {
  if(!sessionPath)return {};
  const meta=readSmallJson(path.join(path.dirname(sessionPath),'session-meta.json'))?.[path.basename(sessionPath)] || {};
  const document=readSmallJson(`${sessionPath}.memory-runtime.json`);
  const snapshot=document?.ambiguous ? null : document?.environment;
  return {...(snapshot?.provenance==='recorded'?{cwd:snapshot.cwd,channelId:snapshot.channel}:{}),...meta};
}
/** Resolve installed/locked exact versions, never claim a package.json range is an installed version. */
function dependencySnapshot(projectId: string | null): Record<string,string> {
  const versions: Record<string,string> = {node:process.versions.node};
  if(!projectId?.startsWith('workspace:'))return versions;
  const root=projectId.slice('workspace:'.length),manifest=readSmallJson(path.join(root,'package.json'));
  if(!manifest)return versions;
  const lock=readSmallJson(path.join(root,'package-lock.json'));
  const names=Object.keys({...manifest.dependencies,...manifest.devDependencies,...manifest.optionalDependencies}).filter(name=>/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)).slice(0,99);
  for(const name of names){
    const installed=readSmallJson(path.join(root,'node_modules',name,'package.json'))?.version;
    const locked=lock?.packages?.[`node_modules/${name}`]?.version || lock?.dependencies?.[name]?.version;
    const version=installed || locked;
    if(typeof version==='string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))versions[name]=version;
  }
  return versions;
}
/** Host-only constructor: callers pass SDK/session metadata, never a tool's model-authored params. */
export function buildTrustedMemoryContext(input: RuntimeInput = {}): TrustedMemoryEnvironment {
  const ctx=input.runtimeContext || {};
  const sessionPath=input.sessionPath || ctx.sessionManager?.getSessionFile?.() || ctx.sessionPath || null;
  const metadata=input.sessionMetadata || readMemorySessionMetadata(sessionPath);
  const cwd=ctx.sessionManager?.getCwd?.() || ctx.cwd || input.cwd || metadata.cwd || metadata.workspaceFolders?.[0] || null;
  const projectId=resolveMemoryProjectId(cwd);
  const bridge=input.bridgeMetadata;
  const bridgeChannel=bridge?.chatType==='channel' ? bridge.channelId || bridge.sessionKey || (bridge.platform && bridge.chatId ? `bridge:${bridge.platform}:${bridge.chatId}` : null) : null;
  const rawChannel=metadata.channelId || ctx.conversationScope?.channelId || ctx.channelId || bridgeChannel || null;
  const channel=typeof rawChannel==='string' && rawChannel.trim()?rawChannel:null;
  const dependencyVersions=dependencySnapshot(projectId);
  // A run snapshot can augment the local manifest only when explicitly bound to this project.
  if(input.runtimeSnapshot?.projectId===projectId && projectId)for(const [name,version] of Object.entries(input.runtimeSnapshot.dependencyVersions || {})){
    if(typeof version==='string' && name.length<=100 && version.length<=100)dependencyVersions[name]=version;
  }
  const environmentDiagnostics:string[]=[];
  if(!projectId)environmentDiagnostics.push('missing_project');
  if(!channel)environmentDiagnostics.push('missing_channel');
  if(!input.appVersion)environmentDiagnostics.push('missing_app_version');
  return {projectId,channel,platform:process.platform,appVersion:input.appVersion || null,dependencyVersions,
    sessionId:ctx.sessionId || metadata.sessionId || sessionPath || null,runId:ctx.runId || metadata.runId || null,environmentDiagnostics};
}
export function experienceApplicabilityDiagnostics(applicability: {scope?:string;projectId?:string|null;channel?:string|null;platform?:string|null;appVersion?:string|null;dependencyVersions?:Record<string,string>}, context: Partial<TrustedMemoryEnvironment>): string[] {
  const reasons:string[]=[];
  if(applicability.scope==='project' && !applicability.projectId)reasons.push('missing_applicability_project');
  for(const [key,label] of [['projectId','project'],['channel','channel'],['platform','platform'],['appVersion','app_version']] as const){
    if(applicability[key] && !context[key])reasons.push(`missing_${label}`);
    else if(applicability[key] && applicability[key]!==context[key])reasons.push(`${label}_mismatch`);
  }
  for(const [name,version] of Object.entries(applicability.dependencyVersions || {})){
    if(!context.dependencyVersions?.[name])reasons.push(`missing_dependency:${name}`);
    else if(context.dependencyVersions[name]!==version)reasons.push(`dependency_mismatch:${name}`);
  }
  return reasons;
}

/** Only applicability fields determine whether a resumed conversation has mixed environments. */
function applicabilityIdentity(environment: Partial<TrustedMemoryEnvironment>): string {
  return JSON.stringify([
    environment.projectId ?? null, environment.channel ?? null, environment.platform ?? null,
    environment.appVersion ?? null, Object.entries(environment.dependencyVersions || {}).sort(([a],[b])=>a.localeCompare(b)),
  ]);
}
/** Preserve the first host-written snapshot. Mixed/invalid history never becomes trusted again. */
export function persistMemoryRuntimeSnapshot(sessionPath:string, snapshot:TrustedMemoryEnvironment & {cwd:string;provenance:'recorded'}) {
  const file=`${sessionPath}.memory-runtime.json`;
  const previous=readSmallJson(file);
  const exists=fs.existsSync(file);
  if(previous?.ambiguous) return;
  if(exists && previous?.schemaVersion===1 && previous?.environment?.provenance==='recorded'
    && applicabilityIdentity(previous.environment)===applicabilityIdentity(snapshot)) return;
  const document=exists
    ? {...(previous && typeof previous==='object' && !Array.isArray(previous) ? previous : {}),schemaVersion:1,ambiguous:true,ambiguityReason:'session_environment_changed_or_invalid',lastObservedAt:new Date().toISOString()}
    : {schemaVersion:1,recordedAt:new Date().toISOString(),environment:snapshot};
  const temp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(document),'utf8');
  fs.renameSync(temp,file);
}

export type RecordedMemoryEnvironment = Omit<TrustedMemoryEnvironment,'platform'> & {platform:string|null;provenance:'recorded'|'unknown'};
/** Historical extraction must never consult current cwd, manifests, bridge metadata or app version.
 * This is intentionally separate from live tool recall. Missing history stays unknown. */
export function buildRecordedMemoryContext(sessionPath?:string|null): RecordedMemoryEnvironment {
  const unknown:RecordedMemoryEnvironment={projectId:null,channel:null,platform:null,appVersion:null,dependencyVersions:{},sessionId:null,runId:null,provenance:'unknown',environmentDiagnostics:['missing_recorded_environment']};
  if(!sessionPath)return unknown;
  const document=readSmallJson(`${sessionPath}.memory-runtime.json`);
  if(document?.ambiguous)return {...unknown,environmentDiagnostics:['ambiguous_recorded_environment']};
  if(document?.schemaVersion!==1 || !document.environment || document.environment.provenance!=='recorded' || Array.isArray(document.environment))return unknown;
  const snapshot=document.environment as Record<string,unknown>;
  const fields=['projectId','channel','platform','appVersion','sessionId','runId'] as const;
  if(fields.some(key=>snapshot[key]!=null && (typeof snapshot[key]!=='string' || String(snapshot[key]).length>4096)))return {...unknown,environmentDiagnostics:['invalid_recorded_environment']};
  const dependencies=snapshot.dependencyVersions;
  if(dependencies!=null && (typeof dependencies!=='object' || Array.isArray(dependencies) || Object.keys(dependencies).length>100 || Object.entries(dependencies).some(([name,version])=>name.length>100 || typeof version!=='string' || version.length>100)))return {...unknown,environmentDiagnostics:['invalid_recorded_environment']};
  const value=(key:typeof fields[number])=>typeof snapshot[key]==='string' && snapshot[key] ? snapshot[key] as string : null;
  const environment:RecordedMemoryEnvironment={projectId:value('projectId'),channel:value('channel'),platform:value('platform'),appVersion:value('appVersion'),sessionId:value('sessionId'),runId:value('runId'),dependencyVersions:{...(dependencies as Record<string,string> || {})},provenance:'recorded',environmentDiagnostics:[]};
  for(const [key,label] of [['projectId','project'],['channel','channel'],['platform','platform'],['appVersion','app_version']] as const)if(!environment[key])environment.environmentDiagnostics.push(`missing_${label}`);
  if(dependencies==null)environment.environmentDiagnostics.push('missing_dependency_snapshot');
  return environment;
}
