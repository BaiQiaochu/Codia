import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type SavedResult = { status: number; body: Record<string, any> };
type Admission = { version: 1; fingerprint: string; token: string; state: 'claimed' | 'completed'; createdAt: number; result?: SavedResult };
/** Durable request deduplication only; workflow remains the execution owner.
 * An unacknowledged claim is deliberately never stolen or automatically retried.
 */
export class TemplateLaunchAdmissions {
  readonly directory: string | null;
  private readonly platform: string;
  constructor(root: string | null | undefined, platform = process.platform) {
    this.platform = platform;
    this.directory = typeof root === 'string' && path.isAbsolute(root) ? path.join(root, 'template-launch-admissions') : null;
  }
  private file(requestId: string) {
    if (!this.directory) throw new Error('persistent_template_launch_directory_unavailable');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error('unsafe_template_launch_directory');
    return path.join(this.directory, `${createHash('sha256').update(requestId).digest('hex')}.json`);
  }
  private syncDirectory() {
    let fd: number | undefined;
    try { fd = fs.openSync(this.directory!, 'r'); fs.fsyncSync(fd); }
    catch (error: any) {
      // Windows cannot open/fsync a directory through Node on all supported
      // filesystems. Files are still fsynced and claims/renames stay atomic.
      // This protects against process crashes, not every power-loss scenario.
      if (this.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  private read(file: string): Admission {
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 128_000) throw new Error('template_launch_record_unreadable');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.version !== 1 || typeof record.fingerprint !== 'string' || !['claimed', 'completed'].includes(record.state)) throw new Error('template_launch_record_unreadable');
    return record;
  }
  claim(requestId: string, fingerprint: string): { owned: true; token: string } | { owned: false; result: SavedResult } {
    const file = this.file(requestId);
    const token = randomUUID();
    let fd: number;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const previous = this.read(file);
      if (previous.fingerprint !== fingerprint) return { owned: false, result: { status: 409, body: { error: 'request_id_payload_mismatch' } } };
      return { owned: false, result: previous.state === 'completed' && previous.result ? previous.result : { status: 409, body: { error: 'template_launch_result_unknown', requestId, note: '此启动请求已有持久记录，但未确认返回结果。请先检查已有工作流与产物；禁止自动重新派发。' } } };
    }
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, fingerprint, token, state: 'claimed', createdAt: Date.now() } satisfies Admission)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    this.syncDirectory();
    return { owned: true, token };
  }
  complete(requestId: string, token: string, result: SavedResult) {
    const file = this.file(requestId);
    const record = this.read(file);
    if (record.token !== token || record.state !== 'claimed') throw new Error('template_launch_claim_changed');
    // Persist successful run references, not user prompts or full preflight drafts.
    const saved = result.status === 202 ? result : { status: result.status, body: { error: String(result.body.error || 'template_launch_blocked').slice(0, 500) } };
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ ...record, state: 'completed', result: saved })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    this.syncDirectory();
  }
}
