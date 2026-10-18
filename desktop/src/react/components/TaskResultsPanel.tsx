import { useEffect, useRef, useState } from 'react';
import { codiaFetch, codiaUrl } from '../hooks/use-codia-fetch';
import { openFileRefPreview } from '../utils/remote-file-preview';
import { inferKindByExt } from '../utils/file-kind';
import { useStore } from '../stores';
import { resolveFileRefUrl } from '../services/resource-url';
import { resolveServerConnection } from '../services/server-connection';
import type { FileRef } from '../types/file-ref';

type ArtifactRecord = { id: string; filePath?: string; displayName?: string; ext?: string; status?: string; size?: number; origin?: string; isDirectory?: boolean; version?: FileRef['version']; resource?: FileRef['resource']; snapshots?: Snapshot[] };
type Snapshot = { id: string; sourceFileId: string; parentId: string | null; sequence: number; sha256: string; size: number; createdAt: number; file: ArtifactRecord };
type Comparison = { identical: boolean; sizeDelta: number; kind: 'text' | 'metadata'; reason?: string; lines?: { kind: 'equal' | 'added' | 'removed'; text: string }[] };
const name = (file: ArtifactRecord) => file.displayName || file.filePath?.split(/[\\/]/).pop() || file.id;
const usable = (file: ArtifactRecord) => !file.isDirectory && (!file.status || file.status === 'available');
function url(file: ArtifactRecord) {
  if (!file.resource?.links.content || !usable(file)) return null;
  try {
    return resolveFileRefUrl({ id: file.id, fileId: file.id, path: file.filePath || '', name: name(file), kind: 'other', source: 'session-registry', resource: file.resource, version: file.version }, {
      connection: resolveServerConnection(useStore.getState()), preferLocalFile: false, resourceContentUrl: codiaUrl,
    }).url;
  } catch { return null; }
}
const errors: Record<string, string> = {
  snapshot_platform_unsupported: '当前服务平台缺少安全文件句柄校验，内容快照暂不可用；原文件预览和历史元数据仍保留。',
  snapshot_file_too_large: '文件超过 5 MiB，无法保存快照。',
  snapshot_version_limit: '该产物已达到 10 个历史版本上限；现有版本已保留。',
  snapshot_count_limit: '该会话已达到 50 个快照上限；现有版本已保留。',
  snapshot_storage_limit: '该会话已达到 50 MiB 快照空间上限；现有版本已保留。',
  snapshot_source_changed: '读取时文件发生变化，请待写入完成后重试。',
  snapshot_path_changed: '文件路径发生变化，已停止读取。',
  snapshot_integrity_failed: '历史快照校验失败，不能显示可信比较。',
  snapshot_not_found: '找不到属于该会话和产物的历史快照。',
};
async function readResponse(response: Response, fallback: string) {
  const data = await response.json();
  if (!response.ok) throw new Error(errors[data.error] || fallback);
  return data;
}
export function TaskResultsPanel({ sessionPath }: { sessionPath: string }) {
  const [snapshotAvailable, setSnapshotAvailable] = useState(false);
  const [snapshotPlatform, setSnapshotPlatform] = useState('未知');
  const [files, setFiles] = useState<ArtifactRecord[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [selection, setSelection] = useState({ fileId: '', before: '', after: '' });
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const currentSession = useRef(sessionPath);
  const requestVersion = useRef(0);
  currentSession.current = sessionPath;
  useEffect(() => {
    let active = true;
    requestVersion.current++;
    setSnapshotAvailable(false); setSnapshotPlatform('未知');
    setFiles([]); setSelection({ fileId: '', before: '', after: '' }); setError(''); setNotice(''); setComparison(null); setBusy(''); setLoading(true);
    void codiaFetch(`/api/task-artifacts?sessionPath=${encodeURIComponent(sessionPath)}`).then(response => readResponse(response, '无法读取登记产物')).then(data => {
      if (active) {
        setFiles(data.files || []);
        setSnapshotAvailable(data.capabilities?.snapshotAvailable === true);
        setSnapshotPlatform(data.capabilities?.platform || '未知');
      }
    }).catch(err => { if (active) setError(String(err instanceof Error ? err.message : err)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionPath]);
  const capture = async (file: ArtifactRecord) => {
    if (!snapshotAvailable) return;
    const session = sessionPath;
    setBusy(file.id); setError(''); setNotice('');
    try {
      const response = await codiaFetch(`/api/task-artifacts/${encodeURIComponent(file.id)}/snapshots?sessionPath=${encodeURIComponent(session)}`, { method: 'POST' });
      const data = await readResponse(response, '保存快照失败，请重试。');
      if (currentSession.current !== session) return;
      setFiles(current => current.map(entry => entry.id === file.id ? { ...entry, snapshots: [...(entry.snapshots || []).filter(snapshot => snapshot.id !== data.snapshot.id), data.snapshot] } : entry));
      setNotice(data.created ? '已保存独立内容快照。之后修改原文件不会改变此版本。' : '内容与最新快照一致，未重复保存。');
    } catch (err) { if (currentSession.current === session) setError(String(err instanceof Error ? err.message : err)); }
    finally { if (currentSession.current === session) setBusy(''); }
  };
  const choose = (fileId: string, key: 'before' | 'after', value: string) => {
    requestVersion.current++;
    setComparison(null);
    setSelection(current => ({ ...(current.fileId === fileId ? current : { before: '', after: '' }), fileId, [key]: value }));
  };
  const compare = async () => {
    if (!snapshotAvailable) return;
    const session = sessionPath;
    const version = ++requestVersion.current;
    setError(''); setComparison(null); setBusy('compare');
    try {
      const query = new URLSearchParams({ sessionPath: session, before: selection.before, after: selection.after });
      const data = await readResponse(await codiaFetch(`/api/task-artifacts/${encodeURIComponent(selection.fileId)}/compare?${query}`), '读取历史内容比较失败。');
      if (currentSession.current === session && requestVersion.current === version) setComparison(data);
    } catch (err) { if (currentSession.current === session && requestVersion.current === version) setError(String(err instanceof Error ? err.message : err)); }
    finally { if (currentSession.current === session) setBusy(''); }
  };
  const preview = (file: ArtifactRecord) => void openFileRefPreview({ id: file.id, fileId: file.id, path: '', name: name(file), ext: file.ext, kind: inferKindByExt(file.ext || ''), source: 'session-registry', resource: file.resource, version: file.version, status: file.status }, { origin: 'session', sessionPath });
  return <section aria-label="已登记产物"><h4>已登记产物与版本</h4>
    <p>手动保存内容快照后才有历史版本。每份文件最多 5 MiB，每个产物最多 10 版，每个会话最多 50 个快照、50 MiB。达到上限后拒绝新增，不自动删除历史或原文件。</p>
    {!loading && !snapshotAvailable && <p role="note">当前服务平台（{snapshotPlatform}）尚未提供安全内容快照能力。保存、快照预览/导出和内容比较暂不可用；原文件预览、导出及历史版本元数据仍保留。</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading ? <p>正在读取产物…</p> : !error && !files.length && <p>尚无已登记文件。</p>}
    <ul>{files.map(file => {
      const snapshots = file.snapshots || [];
      const selected = selection.fileId === file.id;
      return <li key={file.id}>
        <h5>{name(file)}</h5>
        <p>来源：{file.origin || '原会话'} · 当前大小：{file.size ?? file.version?.size ?? '未知'} bytes</p>
        {usable(file) ? <>
          <button type="button" onClick={() => preview(file)}>预览</button>
          {url(file) && <a href={url(file)!} download={name(file)}>导出文件</a>}
          <button type="button" disabled={!!busy || !snapshotAvailable} onClick={() => void capture(file)} aria-label={`保存 ${name(file)} 的内容快照`}>{!snapshotAvailable ? '内容快照不可用' : busy === file.id ? '正在保存…' : '保存内容快照'}</button>
        </> : <span>文件不可用，无法预览、导出或保存新快照</span>}
        {!snapshots.length && <p>尚未保存历史快照。</p>}
        {snapshots.length > 0 && <ul aria-label={`${name(file)} 的历史快照`}>{snapshots.map(snapshot => <li key={snapshot.id}>
          <p>版本 {snapshot.sequence} · {new Date(snapshot.createdAt).toISOString()} · {snapshot.size} bytes</p>
          <p style={{ overflowWrap: 'anywhere' }}>SHA-256：{snapshot.sha256}</p>
          <p>来源文件：{snapshot.sourceFileId} · 前一版本：{snapshot.parentId || '首个快照'}</p>
          {snapshotAvailable && usable(snapshot.file) ? <>
            <button type="button" onClick={() => preview(snapshot.file)} aria-label={`预览 ${name(file)} 版本 ${snapshot.sequence}`}>预览快照</button>
            {url(snapshot.file) && <a href={url(snapshot.file)!} download={`${snapshot.sequence}-${name(file)}`}>导出版本 {snapshot.sequence}</a>}
          </> : <span>{snapshotAvailable ? '快照文件不可用' : '仅显示历史版本元数据'}</span>}
        </li>)}</ul>}
        {snapshots.length >= 2 && <fieldset><legend>{name(file)} 历史内容比较</legend>
          <label>旧版本<select aria-label={`${name(file)} 旧版本`} value={selected ? selection.before : ''} onChange={e => choose(file.id, 'before', e.target.value)}><option value="">选择版本</option>{snapshots.map(s => <option key={s.id} value={s.id}>版本 {s.sequence}</option>)}</select></label>
          <label>新版本<select aria-label={`${name(file)} 新版本`} value={selected ? selection.after : ''} onChange={e => choose(file.id, 'after', e.target.value)}><option value="">选择版本</option>{snapshots.map(s => <option key={s.id} value={s.id}>版本 {s.sequence}</option>)}</select></label>
          <button type="button" disabled={!snapshotAvailable || !!busy || !selected || !selection.before || !selection.after || selection.before === selection.after} onClick={() => void compare()}>比较历史内容</button>
        </fieldset>}
      </li>;
    })}</ul>
    {comparison && <section aria-label="产物版本比较"><h4>历史快照内容比较</h4>
      <p>{comparison.identical ? '保存的内容完全一致' : '保存的内容不同'}</p><p>大小差：{comparison.sizeDelta} bytes</p>
      {comparison.kind === 'text' ? <><p>UTF-8 文本逐行比较。空行显示为 ↵，回车显示为 ␍；不是文档语义比较。</p><pre aria-label="文本差异" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 400, overflow: 'auto' }}>{comparison.lines?.map((line, index) => <span key={index} style={{ display: 'block' }}>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}{line.text ? line.text.replace(/\r/g, '␍') : '↵'}</span>)}</pre></> : <p>{comparison.reason === 'binary_or_non_utf8' ? '二进制或非 UTF-8 文件：' : '文本超过 64 KiB 或 300 行比较上限：'}仅比较保存字节的 SHA-256 和大小，未提供语义差异。</p>}
    </section>}
  </section>;
}
