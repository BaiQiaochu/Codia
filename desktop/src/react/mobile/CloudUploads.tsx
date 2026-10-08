import { useEffect, useRef, useState } from 'react';
import {
  CLOUD_RESUMABLE_UPLOAD_LIMIT, CLOUD_UPLOAD_LIMIT, cloudUploadAvailable, cloudUtcDate, continueCloudUpload,
  fileContentBase64, readCloudUploadFile,
  type CloudFile, type CloudHealth, type CloudUploadResult, type CloudUploadSession, type CloudVersion, type CloudWorkspaceClient,
} from './cloud-workspace-api';

const errorText = (error: unknown) => error instanceof Error ? error.message : '上传未完成，请重试。';
const bytesLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const stateLabel = (state: CloudUploadSession['state']) => ({ uploading: '等待继续', completing: '正在完成', completed: '已保存', cancelled: '已取消', expired: '已过期' })[state];
interface Props {
  workspaceId: string; client: CloudWorkspaceClient; health: CloudHealth | null; files: CloudFile[]; disabled?: boolean;
  onSaved: (file: CloudFile, version: CloudVersion, existing: boolean) => void;
}

/** A keyed workspace boundary owns volatile File objects and aborts every old operation. */
export function CloudUploads(props: Props) { return <CloudUploadsPanel key={props.workspaceId} {...props} />; }
function CloudUploadsPanel({ workspaceId, client, health, files, disabled, onSaved }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [uploads, setUploads] = useState<CloudUploadSession[]>([]);
  const [selected, setSelected] = useState<CloudUploadSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const revision = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pending = useRef<{ fingerprint: string; key: string; payload: { name: string; size: number; sha256: string; fileId?: string; expectedVersion?: string } } | null>(null);
  const resumable = cloudUploadAvailable(health, client);
  const limit = resumable ? Math.min(health?.resumableUploadLimit || CLOUD_RESUMABLE_UPLOAD_LIMIT, CLOUD_RESUMABLE_UPLOAD_LIMIT) : Math.min(health?.uploadLimit || CLOUD_UPLOAD_LIMIT, CLOUD_UPLOAD_LIMIT);
  const remember = (upload: CloudUploadSession) => {
    if (!alive.current) return;
    setSelected(upload);
    setUploads(current => [upload, ...current.filter(item => item.id !== upload.id)]);
  };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; controllerRef.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!resumable) return;
    const controller = new AbortController();
    const started = revision.current;
    client.json<{ uploads: CloudUploadSession[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/uploads`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted || busyRef.current || revision.current !== started) return;
        setUploads(result.uploads.filter(item => item.workspace_id === workspaceId));
        setSelected(current => current ? result.uploads.find(item => item.id === current.id) || null : null);
      }).catch(err => { if (!controller.signal.aborted) setError(errorText(err)); });
    return () => controller.abort();
  }, [workspaceId, client, resumable, reload]);

  async function saved(result: CloudUploadResult, signal: AbortSignal) {
    let savedFile = result.file;
    let savedVersion = result.version;
    // A completed session read recovers a lost completion reply without POSTing again.
    if (!savedFile || !savedVersion) {
      const listed = await client.json<{ files: CloudFile[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/files`, { signal });
      savedFile = listed.files.find(item => item.id === result.upload.file_id);
      if (!savedFile || !result.upload.version_id) throw new Error('文件已完成上传，请刷新文件列表查看保存结果。');
      const versions = await client.json<{ versions: CloudVersion[] }>(`/files/${encodeURIComponent(savedFile.id)}/versions`, { signal });
      savedVersion = versions.versions.find(item => item.id === result.upload.version_id);
      if (!savedVersion) throw new Error('文件已完成上传，请刷新文件列表查看保存版本。');
    }
    signal.throwIfAborted();
    if (!alive.current) return;
    onSaved(savedFile, savedVersion, Boolean(result.upload.expected_version));
    setFile(null); setPhase('文件已保存。'); pending.current = null;
    if (inputRef.current) inputRef.current.value = '';
  }

  async function start() {
    if (busyRef.current || disabled || !file) return;
    const controller = new AbortController(); controllerRef.current = controller;
    const { signal } = controller;
    busyRef.current = true; revision.current += 1; setBusy(true); setError(''); setPhase(resumable ? '正在校验原始文件…' : '正在保存…');
    try {
      if (file.size > limit) throw new Error(`请选择不超过 ${bytesLabel(limit)} 的文件。`);
      if (!resumable) {
        const target = files.find(item => item.name === file.name);
        const contentBase64 = await fileContentBase64(file);
        signal.throwIfAborted();
        const result = await client.json<{ file: CloudFile; version: CloudVersion }>(target ? `/files/${encodeURIComponent(target.id)}/versions` : `/workspaces/${encodeURIComponent(workspaceId)}/files`, {
          method: 'POST', signal, body: JSON.stringify(target ? { contentBase64, expectedVersion: target.current_version } : { name: file.name, contentBase64 }),
        });
        signal.throwIfAborted();
        if (alive.current) { onSaved(result.file, result.version, Boolean(target)); setFile(null); setPhase('文件已保存。'); if (inputRef.current) inputRef.current.value = ''; }
        return;
      }
      const { bytes, sha256 } = await readCloudUploadFile(file, limit, signal);
      let upload = selected;
      if (upload) {
        if (upload.size !== bytes.length || upload.sha256 !== sha256) throw new Error('所选文件与原始上传内容不一致。请重新选择原始文件；文件名与大小相同也不能替代 SHA-256 校验。');
      } else {
        const target = files.find(item => item.name === file.name);
        const payload = { name: file.name, size: bytes.length, sha256, ...(target ? { fileId: target.id, expectedVersion: target.current_version } : {}) };
        const fingerprint = JSON.stringify({ name: file.name, size: bytes.length, sha256 });
        if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID(), payload };
        upload = (await client.json<{ upload: CloudUploadSession }>(`/workspaces/${encodeURIComponent(workspaceId)}/uploads`, {
          method: 'POST', signal, body: JSON.stringify({ ...pending.current!.payload, requestKey: pending.current!.key }),
        })).upload;
        signal.throwIfAborted();
        remember(upload);
      }
      if (upload.workspace_id !== workspaceId) throw new Error('上传会话不属于当前工作空间。');
      setPhase('正在上传…');
      const result = await continueCloudUpload(client, upload, bytes, signal, next => { if (!signal.aborted && alive.current) remember(next); });
      await saved(result, signal);
    } catch (err) {
      if (alive.current) { if (signal.aborted) setPhase('已暂停。服务器保留已收到的分块，可继续上传。'); else { setError(errorText(err)); setPhase('操作结果待核对，请刷新服务器记录或继续此上传。'); } }
    } finally {
      if (alive.current) { busyRef.current = false; revision.current += 1; setBusy(false); }
    }
  }
  async function cancel() {
    if (!selected || busyRef.current || disabled) return;
    const controller = new AbortController(); controllerRef.current = controller;
    busyRef.current = true; revision.current += 1; setBusy(true); setError(''); setPhase('正在取消上传…');
    try {
      const result = await client.json<{ upload: CloudUploadSession }>(`/uploads/${encodeURIComponent(selected.id)}/cancel`, { method: 'POST', signal: controller.signal, body: '{}' });
      if (!controller.signal.aborted && alive.current) {
        remember(result.upload);
        if (result.upload.state === 'completed') {
          await saved({ upload: result.upload }, controller.signal);
          if (alive.current && !controller.signal.aborted) setPhase('上传已完成并保存，取消未更改此文件版本。');
        } else {
          setPhase(result.upload.state === 'cancelled' ? '上传已取消。已保存的文件版本不受影响。' : result.upload.state === 'expired' ? '上传已过期，请重新开始上传。' : '上传状态已变化，请刷新上传列表后核对。');
          if (result.upload.state === 'cancelled' || result.upload.state === 'expired') { setFile(null); pending.current = null; if (inputRef.current) inputRef.current.value = ''; }
        }
      }
    } catch (err) { if (!controller.signal.aborted && alive.current) { setError(errorText(err)); setPhase('操作结果待核对，请刷新上传列表。'); } }
    finally { if (alive.current) { busyRef.current = false; revision.current += 1; setBusy(false); } }
  }
  const canResume = selected?.state === 'uploading' || selected?.state === 'completing';
  return <div className="cw-uploads" data-testid="cloud-uploads">
    <label className={`cw-upload-zone${file ? ' cw-upload-ready' : ''}`} htmlFor="cloud-file-input"><span className="cw-upload-icon" aria-hidden="true">↑</span><strong>{file ? file.name : canResume ? `重新选择 ${selected.name}` : '选择一份工作材料'}</strong><small>{file ? `${bytesLabel(file.size)} · 准备上传` : `所有文件格式 · 原始字节保存 · 最大 ${bytesLabel(limit)}`}</small><input id="cloud-file-input" ref={inputRef} type="file" data-testid="file-input" onChange={event => { setFile(event.target.files?.[0] || null); setSelected(current => current && !['uploading', 'completing'].includes(current.state) ? null : current); setError(''); setPhase(''); }} disabled={busy || disabled} /></label>
    {file && <button className="cw-button cw-button-primary cw-full-width" type="button" data-testid="upload-file" disabled={busy || disabled || Boolean(selected && !canResume)} onClick={() => void start()}>{busy ? phase : canResume ? '校验并继续上传' : files.some(item => item.name === file.name) ? '保存为新版本' : '上传并保存'}</button>}
    {error && <p className="cw-run-error" role="alert">{error}</p>}
    {phase && <p className="cw-helper" role="status">{phase}</p>}
    <p className="cw-helper">上传同名文件会新增版本，历史版本不会被覆盖。{resumable ? '每块 1 MiB；刷新后从服务器恢复进度，需要重新选择并校验原始文件。浏览器不持久保存文件字节。' : '当前服务未提供断点上传，使用单次上传。'}</p>
    {selected && <div className="cw-upload-progress" data-testid="upload-progress"><strong>{selected.name} · {stateLabel(selected.state)}</strong><progress aria-label="已保存上传进度" max={selected.size || 1} value={selected.state === 'completed' && !selected.size ? 1 : selected.received_bytes} /><span>{bytesLabel(selected.received_bytes)} / {bytesLabel(selected.size)} · {Math.round(selected.size ? selected.received_bytes / selected.size * 100 : selected.state === 'completed' ? 100 : 0)}%</span><small>有效期至 {cloudUtcDate(selected.expires_at)}</small></div>}
    <div className="cw-upload-actions">
      {busy && resumable && phase !== '正在取消上传…' && <button type="button" className="cw-record-action" onClick={() => controllerRef.current?.abort()}>暂停上传</button>}
      {canResume && !busy && <button type="button" className="cw-record-action" disabled={disabled} onClick={() => void cancel()}>取消此上传</button>}
      {selected && !busy && <button type="button" className="cw-record-action" onClick={() => { setSelected(null); setFile(null); setPhase(''); setError(''); pending.current = null; if (inputRef.current) inputRef.current.value = ''; }}>选择其他文件</button>}
      {resumable && <button type="button" className="cw-record-action" disabled={busy || disabled} onClick={() => { setError(''); setReload(value => value + 1); }}>刷新上传列表</button>}
    </div>
    {resumable && uploads.length > 0 && <div className="cw-upload-sessions" aria-label="服务器上传记录"><h3>上传记录</h3>{uploads.map(upload => <button type="button" className={`cw-upload-session${selected?.id === upload.id ? ' cw-selected' : ''}`} key={upload.id} disabled={busy || disabled || upload.state === 'cancelled' || upload.state === 'expired' || upload.state === 'completed'} onClick={() => { setSelected(upload); setFile(null); setError(''); setPhase('请重新选择原始文件。完整 SHA-256 校验通过后，只补传缺失分块。'); if (inputRef.current) inputRef.current.value = ''; }}><strong>{upload.name}</strong><span>{stateLabel(upload.state)} · {bytesLabel(upload.received_bytes)} / {bytesLabel(upload.size)}</span></button>)}</div>}
  </div>;
}
