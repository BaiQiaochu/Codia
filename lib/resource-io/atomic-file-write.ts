import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Replace regular files without exposing truncated contents; never fall back to overwrite. */
export function atomicLocalWrite(filePath: string, content: string | Buffer, beforeReplace?: () => void) {
  const exists = fs.existsSync(filePath);
  const target = exists ? fs.realpathSync(filePath) : filePath;
  const stat = exists ? fs.statSync(target) : null;
  if (stat && (!stat.isFile() || stat.nlink > 1)) {
    throw new Error('Atomic write requires a regular file with one hard link; the original was preserved.');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, 'wx', stat ? stat.mode & 0o777 : 0o666);
    if (stat && process.platform !== 'win32') {
      fs.fchmodSync(fd, stat.mode & 0o777);
      if (stat.uid !== process.getuid?.() || stat.gid !== process.getgid?.()) fs.fchownSync(fd, stat.uid, stat.gid);
    }
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    beforeReplace?.();
    fs.renameSync(temporary, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
