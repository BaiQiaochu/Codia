import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { CloudWorkspaceService } from './service.ts';
import { type CloudRow } from './store.ts';
import { CloudTaskService, parseTaskPlan, validateTaskSession } from './agent-tasks.ts';
// Fixed transform only, not an arbitrary-code sandbox or an LLM agent.
// Only bounded input bytes/name enter the child; no credentials/user paths/tools.
const TRANSFORM = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{input+=c;if(input.length>3000000)process.exit(2)});process.stdin.on('end',()=>{const v=JSON.parse(input);const bytes=Buffer.from(v.base64,'base64');const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);const lines=text.split(/\\r?\\n/);const meaningful=lines.map(x=>x.trim()).filter(Boolean);const headings=meaningful.filter(x=>/^#{1,6}\\s/.test(x)).slice(0,12);const out=['# 文档检查与摘要','', '> 固定文本处理流程；未调用大模型。','', '文件：'+v.name,'输入版本：'+v.versionId,'字节数：'+bytes.length,'字符数：'+text.length,'行数：'+lines.length,'', '## 结构',...(headings.length?headings:['未检测到 Markdown 标题']),'', '## 内容摘录',...meaningful.slice(0,8).map(x=>x.slice(0,240)),'','## 持久化验证','本产物已作为不可变版本提交；客户端关闭不会取消后台任务。'].join('\\n');process.stdout.write(out);});`;
export async function executeDocumentTransform(run: CloudRow, bytes: Buffer): Promise<Buffer> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codia-cloud-run-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=64', '-e', TRANSFORM], { cwd: directory, env: { LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const output: Buffer[] = []; let size = 0;
      const timeout = setTimeout(() => { child.kill(); reject(new Error('executor_timeout')); }, 5000);
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) { child.kill(); reject(new Error('executor_output_limit')); } else output.push(chunk); });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(timeout); if (code === 0) resolve(Buffer.concat(output)); else reject(new Error('unsupported_document_or_executor_failed')); });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ name: run.name, versionId: run.input_version, base64: bytes.toString('base64') }));
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
export class CloudWorkspaceWorker {
  declare service: CloudWorkspaceService;
  declare timer: ReturnType<typeof setInterval> | null;
  declare active: Promise<boolean> | null;
  constructor(service: CloudWorkspaceService) { this.service = service; this.timer = null; this.active = null; }
  start() { if (!this.timer) { this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 500); this.timer.unref(); void this.tick().catch(() => {}); } }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = null; await this.active; }
  tick(): Promise<boolean> {
    if (this.active) return this.active;
    this.active = this.runOne().finally(() => { this.active = null; });
    return this.active;
  }
  async runOne(): Promise<boolean> {
    await this.service.store.reconcileStaging();
    await this.service.store.dispatchDueSchedules();
    await this.service.store.publishOutbox();
    const run = await this.service.store.claim();
    if (!run) return false;
    const controller = new AbortController();
    let renewing = false, leaseLost = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.service.store.renewLease(run).then(ok => { if (!ok) { leaseLost = true; controller.abort(); } })
        .catch(() => { leaseLost = true; controller.abort(); }).finally(() => { renewing = false; });
    }, 1000);
    heartbeat.unref();
    try {
      const bytes = await this.service.objects.get(run.object_key);
      if (bytes.length !== run.size || crypto.createHash('sha256').update(bytes).digest('hex') !== run.sha256) throw new Error('input_integrity_mismatch');
      const task = run.operation === 'agent-task' ? await new CloudTaskService(this.service).prepare({ userId: run.owner_user, studioId: run.studio_id }, run.workspace_id, parseTaskPlan(bytes)) : null;
      const output = ['agent-summary','agent-conversation','agent-task'].includes(run.operation)
        ? await (this.service.agentExecutor ? this.service.agentExecutor.execute(run, task ? Buffer.from(JSON.stringify(task)) : bytes, controller.signal) : Promise.reject(new Error('model_not_configured')))
        : await executeDocumentTransform(run, bytes);
      if (leaseLost || controller.signal.aborted) throw new Error('stale_executor');
      if (task) {
        const session = validateTaskSession(output, run);
        if (JSON.stringify(session.inputVersions) !== JSON.stringify(task.inputVersions) || session.sourceWorkflowVersion !== task.sourceWorkflowVersion) throw new Error('task_output_invalid');
      }
      // Recheck cancellation/lease immediately before any output staging. Completion fences again.
      if (!await this.service.store.renewLease(run)) throw new Error('stale_executor');
      const objectKey = `workspaces/${run.workspace_id}/runs/${run.id}/attempt-${run.attempt}/${task ? 'session.json' : 'result.md'}`;
      const expected = { size: output.length, sha256: crypto.createHash('sha256').update(output).digest('hex') };
      const saved = await this.service.objects.putImmutable(objectKey, output);
      if (saved.size !== expected.size || saved.sha256 !== expected.sha256) throw new Error('output_integrity_mismatch');
      const stored = await this.service.objects.get(objectKey);
      if (stored.length !== expected.size || crypto.createHash('sha256').update(stored).digest('hex') !== expected.sha256) throw new Error('output_integrity_mismatch');
      await this.service.store.complete(run, { objectKey, ...expected });
    } catch (err) {
      const code = err instanceof Error && /^[a-z_]+$/.test(err.message) ? err.message : 'processing_failed';
      await this.service.store.fail(run, code);
    } finally { clearInterval(heartbeat); controller.abort(); }
    await this.service.store.publishOutbox();
    return true;
  }
}
