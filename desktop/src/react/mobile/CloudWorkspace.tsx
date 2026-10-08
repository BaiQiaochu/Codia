import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CloudRecords } from './CloudRecords';
import { CloudTasks, CloudTaskRunDetail } from './CloudTasks';
import type { MobilePrincipal } from './mobile-init';
import {
  cloudStatusLabel, cloudUtcDate, fileContentBase64, isActiveCloudRun, webCloudWorkspaceClient, cloudOperationAvailable, cloudOperationLabel, inspectCloudContent,
  type CloudArtifact, type CloudEvent, type CloudFile, type CloudHealth, type CloudOperation, type CloudWorkspaceClient, type CloudContentInspection,
  type CloudRun, type CloudRunDetail, type CloudVersion, type CloudWorkspaceRecord,
} from './cloud-workspace-api';

function CloudIcon({ kind = 'cloud', size = 20 }: { kind?: 'cloud' | 'file' | 'arrow' | 'check' | 'upload' | 'activity' | 'folder'; size?: number }) {
  const paths = {
    cloud: <path d="M7 18a5 5 0 1 1 1-9.9 6 6 0 0 1 11.6 2.1A4 4 0 0 1 19 18H7Z" />,
    file: <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    check: <path d="m5 12 4 4L19 6" />,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v4h16v-4" /></>,
    activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
    folder: <path d="M3 7V5h6l2 2h10v13H3V7Z" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

function formatBytes(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function shortDate(value: string): string {
  return cloudUtcDate(value);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '操作未完成，请重试。'; }
function savedValue(key: string): string { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
function saveValue(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* Selection persistence is optional. */ } }
function eventLabel(kind: string): string {
  return ({ 'run.queued': '任务已进入队列', 'run.started': '开始处理固定版本', 'run.running': '正在处理文档', 'run.completed': '处理完成', 'run.succeeded': '处理完成', 'run.failed': '任务失败', 'artifact.created': '产物已保存', 'file.created': '文件已保存', 'file.version.created': '新版本已保存', 'file.version_ready': '文件版本已保存', 'workspace.created': '工作空间已创建' } as Record<string, string>)[kind] || kind;
}

export function CloudWorkspace({ principal, client = webCloudWorkspaceClient, desktop = false, onConfigureAI }: {
  principal: MobilePrincipal | null;
  client?: CloudWorkspaceClient;
  desktop?: boolean;
  onConfigureAI?: () => void;
}): React.ReactElement {
  const { json: cloudJson, contentUrl: cloudContentUrl } = client;
  const [operation, setOperation] = useState<CloudOperation>('document-summary');
  const storageKey = `gsap-cloud-workspace:${principal?.userId || principal?.credentialId || 'session'}`;
  const [health, setHealth] = useState<CloudHealth | null>(null);
  const [workspaces, setWorkspaces] = useState<CloudWorkspaceRecord[]>([]);
  const [workspaceId, setWorkspaceId] = useState(() => savedValue(storageKey));
  const [workspaceName, setWorkspaceName] = useState('');
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [fileId, setFileId] = useState('');
  const [versions, setVersions] = useState<CloudVersion[]>([]);
  const [versionId, setVersionId] = useState('');
  const [inputContent, setInputContent] = useState<{ version: string; value: CloudContentInspection } | null>(null);
  const [upload, setUpload] = useState<File | null>(null);
  const [runs, setRuns] = useState<CloudRun[]>([]);
  const [runId, setRunId] = useState('');
  const [detail, setDetail] = useState<CloudRunDetail | null>(null);
  const [events, setEvents] = useState<CloudEvent[]>([]);
  const [artifact, setArtifact] = useState<CloudArtifact | null>(null);
  const [preview, setPreview] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const actionRef = useRef(false);
  const recordDirtyRef = useRef(false);
  const taskDirtyRef = useRef(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const onTaskDirtyChange = useCallback((dirty: boolean) => { taskDirtyRef.current = dirty; }, []);
  const onRecordDirtyChange = useCallback((dirty: boolean) => { recordDirtyRef.current = dirty; }, []);
  const dataRevisionRef = useRef(0);
  const headingRef = useRef<HTMLDivElement>(null);
  const taskSectionRef = useRef<HTMLElement>(null);
  const cloudTaskSectionRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<{ workspace: string; version: string; operation: CloudOperation; key: string } | null>(null);
  const versionFileRef = useRef('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workspaceInputRef = useRef<HTMLInputElement>(null);
  const selectedFile = files.find(file => file.id === fileId);
  const selectedFileId = selectedFile?.id;
  const currentFileVersion = selectedFile?.current_version;
  const artifactVersionId = artifact?.version_id;
  const inputInspection = inputContent?.version === versionId ? inputContent.value : null;
  const inputTextReady = inputInspection?.kind === 'text';
  const selectedWorkspace = workspaces.find(workspace => workspace.id === workspaceId);
  const activeRuns = runs.filter(run => isActiveCloudRun(run.status)).length;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      cloudJson<CloudHealth>('/health', { signal: controller.signal }),
      cloudJson<{ workspaces: CloudWorkspaceRecord[] }>('/workspaces', { signal: controller.signal }),
    ]).then(([nextHealth, result]) => {
      if (controller.signal.aborted) return;
      setHealth(nextHealth);
      setWorkspaces(result.workspaces);
      setWorkspaceId(current => result.workspaces.some(item => item.id === current) ? current : result.workspaces[0]?.id || '');
      setError('');
    }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload, cloudJson]);

  useEffect(() => { saveValue(storageKey, workspaceId); }, [storageKey, workspaceId]);

  useEffect(() => {
    setFiles([]); setFileId(''); setVersions([]); setVersionId(''); setRuns([]); setRunId(''); setDetail(null); setArtifact(null); setEvents([]); setUpload(null); setNotice('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!workspaceId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor: number | string = 0;
    setWorkspaceLoading(true);
    const refresh = async () => {
      let delay = 5000;
      const revision = dataRevisionRef.current;
      try {
        const [fileResult, runResult, eventResult] = await Promise.all([
          cloudJson<{ files: CloudFile[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/files`, { signal: controller.signal }),
          cloudJson<{ runs: CloudRun[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/runs`, { signal: controller.signal }),
          cloudJson<{ events: CloudEvent[]; cursor: number | string }>(`/workspaces/${encodeURIComponent(workspaceId)}/events?after=${encodeURIComponent(cursor)}`, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        // Ignore reads begun before an upload/task mutation changed the visible data.
        if (revision !== dataRevisionRef.current || actionRef.current) { delay = 1000; return; }
        setFiles(fileResult.files);
        setFileId(current => fileResult.files.some(file => file.id === current) ? current : fileResult.files[0]?.id || '');
        setRuns(runResult.runs);
        setRunId(current => runResult.runs.some(run => run.id === current) ? current : runResult.runs[0]?.id || '');
        setEvents(current => [...current, ...eventResult.events.filter(event => !current.some(existing => existing.id === event.id))].slice(-60));
        cursor = eventResult.cursor;
        delay = runResult.runs.some(run => isActiveCloudRun(run.status)) ? 1000 : 5000;
      } catch (err) { if (!controller.signal.aborted) setError(errorMessage(err)); }
      finally {
        if (!controller.signal.aborted) { setWorkspaceLoading(false); timer = setTimeout(() => void refresh(), delay); }
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [workspaceId, reload, cloudJson]);

  useEffect(() => {
    const changedFile = versionFileRef.current !== selectedFileId;
    versionFileRef.current = selectedFileId || '';
    setVersions([]);
    if (changedFile) setVersionId('');
    if (!selectedFileId || !currentFileVersion) return;
    const controller = new AbortController();
    const currentVersion = currentFileVersion;
    cloudJson<{ versions: CloudVersion[] }>(`/files/${encodeURIComponent(selectedFileId)}/versions`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setVersions(result.versions); setVersionId(current => !changedFile && result.versions.some(version => version.id === current) ? current : currentVersion); } })
      .catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); });
    return () => controller.abort();
  }, [selectedFileId, currentFileVersion, cloudJson]);

  useEffect(() => {
    setInputContent(null);
    if (!versionId) return;
    const controller = new AbortController();
    client.content(versionId, { signal: controller.signal }).then(inspectCloudContent)
      .then(value => { if (!controller.signal.aborted) setInputContent({ version: versionId, value }); })
      .catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); });
    return () => controller.abort();
  }, [versionId, client]);

  useEffect(() => {
    setDetail(null); setArtifact(null); setPreview('');
    if (!runId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const revision = dataRevisionRef.current;
        const result = await cloudJson<CloudRunDetail>(`/runs/${encodeURIComponent(runId)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (revision !== dataRevisionRef.current) { timer = setTimeout(() => void refresh(), 1000); return; }
        setDetail(result);
        setRuns(current => current.map(run => run.id === result.run.id ? result.run : run));
        setArtifact(current => result.artifacts.find(item => item.id === current?.id) || result.artifacts[0] || null);
        if (isActiveCloudRun(result.run.status)) timer = setTimeout(() => void refresh(), 1000);
      } catch (err) {
        if (!controller.signal.aborted) { setError(errorMessage(err)); timer = setTimeout(() => void refresh(), 5000); }
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [runId, reload, cloudJson]);

  useEffect(() => {
    setPreview('');
    if (!artifactVersionId) { setPreviewLoading(false); return; }
    const controller = new AbortController();
    setPreviewLoading(true);
    client.content(artifactVersionId, { signal: controller.signal })
      .then(inspectCloudContent)
      .then(value => { if (!controller.signal.aborted) setPreview(value.kind === 'text' ? value.text : value.kind === 'empty' ? '文件为空，可下载原文件。' : '此文件不可文本预览，可通过下载按钮保存原文件。'); })
      .catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setPreviewLoading(false); });
    return () => controller.abort();
  }, [artifactVersionId, client]);

  const action = useCallback(async (name: string, work: () => Promise<void>) => {
    if (actionRef.current) return;
    actionRef.current = true; dataRevisionRef.current += 1; setBusy(name); setError(''); setNotice('');
    try { await work(); }
    catch (err) { setError(errorMessage(err)); }
    finally { dataRevisionRef.current += 1; actionRef.current = false; setBusy(''); }
  }, []);

  const createWorkspace = (event: React.FormEvent) => {
    event.preventDefault();
    const name = workspaceName.trim();
    if (!name) return;
    if ((recordDirtyRef.current || taskDirtyRef.current) && !window.confirm('新建工作空间将放弃当前记录或任务中未保存的更改，继续吗？')) return;
    void action('workspace', async () => {
      const result = await cloudJson<{ workspace: CloudWorkspaceRecord }>('/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
      setWorkspaces(current => [result.workspace, ...current]); setWorkspaceId(result.workspace.id); setWorkspaceName('');
      setNotice('工作空间已创建。现在可以上传第一个文件。');
    });
  };

  const uploadFile = () => {
    if (!upload || !workspaceId) return;
    const targetWorkspace = workspaceId;
    const targetFile = files.find(file => file.name === upload.name);
    void action('upload', async () => {
      const contentBase64 = await fileContentBase64(upload);
      const result = await cloudJson<{ file: CloudFile; version: CloudVersion }>(targetFile ? `/files/${encodeURIComponent(targetFile.id)}/versions` : `/workspaces/${encodeURIComponent(targetWorkspace)}/files`, {
        method: 'POST', body: JSON.stringify(targetFile ? { contentBase64, expectedVersion: targetFile.current_version } : { name: upload.name, contentBase64 }),
      });
      setFiles(current => [result.file, ...current.filter(file => file.id !== result.file.id)]);
      setFileId(result.file.id); setVersionId(result.version.id); setUpload(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setNotice(targetFile ? '新版本已保存，原版本仍可读取。' : '文件已保存；文本文件可开始处理。');
    });
  };

  const submitRun = () => {
    if (!workspaceId || !versionId || !selectedFile || !inputTextReady || !cloudOperationAvailable(health, operation)) return;
    void action('run', async () => {
      if (!requestRef.current || requestRef.current.workspace !== workspaceId || requestRef.current.version !== versionId || requestRef.current.operation !== operation) {
        requestRef.current = { workspace: workspaceId, version: versionId, operation, key: crypto.randomUUID() };
      }
      const result = await cloudJson<{ run: CloudRun }>(`/workspaces/${encodeURIComponent(workspaceId)}/runs`, { method: 'POST', body: JSON.stringify({ inputVersion: versionId, operation, requestKey: requestRef.current.key }) });
      requestRef.current = null;
      setRuns(current => [result.run, ...current.filter(run => run.id !== result.run.id)]); setRunId(result.run.id);
      setNotice('任务已提交。可离开此页面，返回后继续查看结果。');
    });
  };

  const download = (event: React.MouseEvent<HTMLAnchorElement>, version: string, name: string) => {
    if (!client.download) return;
    event.preventDefault();
    void action('download', () => client.download!(version, name));
  };
  const localMode = health?.mode === 'local' || !health?.productionReady;
  const agentAvailable = cloudOperationAvailable(health, 'agent-summary');
  const operationAvailable = cloudOperationAvailable(health, operation);
  return (
    <section className={`cloud-studio${desktop ? ' desktop-cloud-studio' : ''}`} data-byoung-chat-color-scope="" data-testid="cloud-workspace" aria-label="云工作空间">
      <header className="cw-header">
        <div className="cw-brand"><span className="cw-brand-icon"><CloudIcon size={23} /></span><div><strong>云工作空间</strong><span>CODIA / WORKSPACE</span></div></div>
        <div className="cw-runtime"><span className={`cw-dot${health ? ' cw-dot-ready' : ''}`} />{health ? localMode ? '开发验证 · 本地持久化' : health.mode : '正在连接服务'}<span className="cw-runtime-divider" />{desktop ? '当前服务连接' : '当前登录身份'}</div>
      </header>
      <div className="cw-layout">
        <aside className="cw-sidebar" aria-label="工作空间管理">
          <div className="cw-section-label">工作空间 <span>{workspaces.length.toString().padStart(2, '0')}</span></div>
          <label className="cw-sr-only" htmlFor="cloud-workspace-select">选择工作空间</label>
          <select id="cloud-workspace-select" className="cw-select" data-testid="workspace-select" value={workspaceId} onChange={event => { if ((!recordDirtyRef.current && !taskDirtyRef.current) || window.confirm('切换工作空间将放弃记录或任务中未保存的更改，继续吗？')) setWorkspaceId(event.target.value); }} disabled={loading || Boolean(busy || taskBusy)}>
            {!workspaces.length && <option value="">{loading ? '正在读取…' : '还没有工作空间'}</option>}
            {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <form className="cw-create-form" onSubmit={createWorkspace}>
            <label htmlFor="cloud-workspace-name">新建工作空间</label>
            <div className="cw-inline-input"><input id="cloud-workspace-name" ref={workspaceInputRef} data-testid="workspace-name" value={workspaceName} maxLength={80} placeholder="给项目起个名字" onChange={event => setWorkspaceName(event.target.value)} disabled={Boolean(busy || taskBusy)} /><button type="submit" className="cw-icon-button" data-testid="create-workspace" disabled={!workspaceName.trim() || Boolean(busy || taskBusy) || loading} aria-label="创建工作空间">{busy === 'workspace' ? '…' : '+'}</button></div>
          </form>
          <div className="cw-sidebar-divider" />
          <div className="cw-sidebar-navigation"><button type="button" className="cw-nav-active" onClick={() => headingRef.current?.scrollIntoView({ block: 'start' })}><CloudIcon kind="folder" size={17} />项目概览<span className="cw-nav-mark" /></button><button type="button" onClick={() => taskSectionRef.current?.scrollIntoView({ block: 'start' })}><CloudIcon kind="activity" size={17} />任务记录<b>{runs.length}</b></button><button type="button" onClick={() => cloudTaskSectionRef.current?.scrollIntoView({ block: 'start' })}><CloudIcon kind="activity" size={17} />任务与定时</button></div>
          <div className="cw-storage-card"><span className="cw-small-icon"><CloudIcon kind="check" size={17} /></span><strong>每一步都有记录</strong><p>文件按版本保存，任务绑定确定版本。刷新页面后，工作仍在这里。</p><div className="cw-storage-line"><span>文件</span><strong>{files.length}</strong></div><div className="cw-storage-line"><span>处理中</span><strong>{activeRuns}</strong></div></div>
          <div className="cw-sidebar-foot"><span className="cw-dot cw-dot-ready" />{desktop ? '使用已授权的服务连接' : '基于现有登录会话'}<br /><small>权限与当前账号保持一致</small></div>
        </aside>
        <div className="cw-main">
          <div className="cw-page-heading" ref={headingRef}><div><div className="cw-eyebrow">从文件到成果，保留完整过程</div><h1>{selectedWorkspace?.name || '让工作，有一个归处'}</h1><p>{selectedWorkspace ? '上传材料、保存任务计划、定时执行并查看可追溯的产物。' : '创建一个工作空间，开始保存文件和处理任务。'}</p></div><button className="cw-button cw-button-ghost" type="button" data-testid="refresh-workspace" onClick={() => setReload(current => current + 1)} disabled={loading || Boolean(busy || taskBusy)}>↻ 刷新</button></div>
          {error && <div className="cw-alert cw-alert-error" role="alert"><span>{error}</span><button type="button" aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
          {notice && <div className="cw-alert cw-alert-success" role="status"><CloudIcon kind="check" size={16} /><span>{notice}</span></div>}
          <div className="cw-development-note"><CloudIcon kind="activity" size={16} /><span>{agentAvailable ? 'AI 摘要通过已配置的 Codia 模型执行；文档检查仅提取文本与元数据。' : '文档检查仅提取文本与元数据，尚未接入 AI 模型。文件与工作空间仍可正常使用。'}{localMode && ' 数据保存在当前服务端本机。'}</span>{!agentAvailable && onConfigureAI && <button type="button" className="cw-configure-ai" onClick={onConfigureAI}>配置 AI</button>}</div>
          {loading ? <div className="cw-initial-loading" role="status"><span className="cw-spinner" />正在读取工作空间…</div> : !workspaceId ? <div className="cw-welcome"><span className="cw-welcome-icon"><CloudIcon kind="folder" size={38} /></span><h2>从你的第一个项目开始</h2><p>一个工作空间，收纳文件版本、处理记录和最终产物。</p><button type="button" className="cw-button cw-button-primary" onClick={() => workspaceInputRef.current?.focus()}>创建工作空间 <CloudIcon kind="arrow" size={16} /></button><div className="cw-welcome-steps"><span>01 上传文件</span><i /> <span>02 运行流程</span><i /> <span>03 保存成果</span></div></div> : <div className="cw-board" aria-busy={workspaceLoading}>
            <section className="cw-card cw-files-card" aria-labelledby="cw-files-title"><div className="cw-card-heading"><div><span className="cw-step">01</span><h2 id="cw-files-title">文件与版本</h2></div><span className="cw-count">{files.length}</span></div><div className="cw-file-content">
              <label className={`cw-upload-zone${upload ? ' cw-upload-ready' : ''}`} htmlFor="cloud-file-input"><span className="cw-upload-icon"><CloudIcon kind="upload" size={23} /></span><strong>{upload ? upload.name : '选择一份工作材料'}</strong><small>{upload ? `${formatBytes(upload.size)} · 准备上传` : '所有文件格式 · 原始字节保存 · 最大 2 MiB'}</small><input id="cloud-file-input" ref={fileInputRef} type="file" data-testid="file-input" onChange={event => { setUpload(event.target.files?.[0] || null); setError(''); }} disabled={Boolean(busy || taskBusy)} /></label>
              {upload && <button className="cw-button cw-button-primary cw-full-width" type="button" data-testid="upload-file" disabled={Boolean(busy || taskBusy)} onClick={uploadFile}>{busy === 'upload' ? '正在保存…' : files.some(file => file.name === upload.name) ? '保存为新版本' : '上传并保存'}<CloudIcon kind="arrow" size={15} /></button>}
              <p className="cw-helper">上传同名文件会新增版本，历史版本不会被覆盖。</p>
              <div className="cw-file-list" aria-label="已保存文件">{workspaceLoading && !files.length ? <p className="cw-empty-small">正在读取文件…</p> : !files.length ? <div className="cw-empty-small"><CloudIcon kind="file" size={25} /><p>还没有文件<br /><small>先上传一份材料，再开始处理</small></p></div> : files.map(file => <button type="button" data-testid="file-select" className={`cw-file-row${fileId === file.id ? ' cw-selected' : ''}`} key={file.id} onClick={() => setFileId(file.id)} aria-pressed={fileId === file.id} disabled={Boolean(busy || taskBusy)}><span className="cw-file-icon"><CloudIcon kind="file" size={18} /></span><span><strong>{file.name}</strong><small>{formatBytes(file.size)} · {file.version_count} 个版本</small></span><span className="cw-selection-dot" /></button>)}</div>
              {selectedFile && <div className="cw-version-details"><label htmlFor="cloud-version">处理版本</label><select className="cw-select" id="cloud-version" data-testid="version-select" value={versionId} onChange={event => setVersionId(event.target.value)} disabled={!versions.length || Boolean(busy || taskBusy)}>{!versions.length && <option value="">读取版本…</option>}{versions.map(version => <option key={version.id} value={version.id}>{version.id === selectedFile.current_version ? '最新版本' : `历史版本 ${version.id.slice(0, 8)}`} · {shortDate(version.created_at)}</option>)}</select><div className="cw-version-meta"><span>SHA-256</span><code title={versions.find(version => version.id === versionId)?.sha256}>{versions.find(version => version.id === versionId)?.sha256.slice(0, 16) || '—'}…</code></div>{versionId && <a className="cw-text-link" href={cloudContentUrl(versionId, true)} download={selectedFile.name} onClick={event => download(event, versionId, selectedFile.name)}>下载此版本 ↗</a>}{versionId && <details className="cw-input-preview"><summary>文件预览</summary>{!inputInspection ? <p role="status">正在检查文件内容…</p> : inputInspection.kind === 'text' ? <pre data-testid="input-file-preview">{inputInspection.text.slice(0, 20000)}{inputInspection.text.length > 20000 ? '\n…预览已截断，可下载完整文件。' : ''}</pre> : <p data-testid="input-binary-note">{inputInspection.kind === 'empty' ? '文件为空。' : '此文件不可文本预览。'}可下载原文件；文档检查与 AI 摘要仅支持 UTF-8 文本。</p>}</details>}</div>}
            </div></section>
            <section ref={taskSectionRef} className="cw-card cw-task-card" aria-labelledby="cw-task-title"><div className="cw-card-heading"><div><span className="cw-step">02</span><h2 id="cw-task-title">任务工作台</h2></div><span className="cw-subtle-label">版本锁定</span></div><div className="cw-task-composer"><div className="cw-operation-heading"><span className="cw-operation-icon"><CloudIcon kind="activity" size={22} /></span><div><h3>{cloudOperationLabel(operation)}</h3><span>版本锁定 · 可追溯执行</span></div></div><label className="cw-operation-label" htmlFor="cloud-operation">处理方式</label><select id="cloud-operation" data-testid="operation-select" className="cw-select cw-operation-select" value={operation} onChange={event => setOperation(event.target.value as CloudOperation)} disabled={Boolean(busy || taskBusy)}><option value="document-summary">文档检查与摘要（无需 AI）</option><option value="agent-summary">AI 文档摘要</option></select>{operation === 'agent-summary' && !agentAvailable && <p className="cw-ai-unavailable" role="status">{health?.executorUnavailableReason === 'model_not_configured' ? '尚未配置模型，请在设置中添加 AI 服务商和模型后刷新。' : 'AI 执行器暂不可用，请检查服务配置后刷新。'}文档检查仍可使用。</p>}<label className="cw-sr-only" htmlFor="cloud-task-description">流程任务说明</label><textarea id="cloud-task-description" data-testid="task-prompt" readOnly value={operation === 'agent-summary' ? '使用已配置的 AI 模型阅读选定文件版本，生成摘要并保存为独立产物。文件文本会发送给你配置的模型服务商。' : '读取选定文件版本，统计文档元数据并提取文本摘要，将结果保存为独立产物。'} /><div className="cw-task-input"><CloudIcon kind="file" size={14} /><span>{selectedFile ? `${selectedFile.name} · ${versionId === selectedFile.current_version ? '最新版本' : '历史版本'}` : '等待选择输入文件'}</span></div><button className="cw-button cw-button-primary cw-full-width" type="button" data-testid="submit-task" onClick={submitRun} disabled={!versionId || !selectedFile || !inputTextReady || Boolean(busy || taskBusy) || !operationAvailable}>{busy === 'run' ? '正在提交…' : '开始处理'}<CloudIcon kind="arrow" size={17} /></button>{versionId && !inputInspection && <p className="cw-composer-note" role="status">正在检查选定版本的文件内容…</p>}{inputInspection && inputInspection.kind !== 'text' && <p className="cw-ai-unavailable">选定文件不可进行文本处理；仍可保存版本和下载原文件。</p>}<p className="cw-composer-note">仅可处理 UTF-8 文本；文件后续更新不会改变任务输入。</p></div>
              <div className="cw-runs-heading"><h3>运行记录</h3><span>{runs.length} 次</span></div><div className="cw-runs-list">{!runs.length ? <div className="cw-empty-small"><CloudIcon kind="activity" size={26} /><p>准备好时，开始第一个任务<br /><small>进度和结果会自动出现在这里</small></p></div> : runs.map(run => <button type="button" className={`cw-run-row${runId === run.id ? ' cw-selected' : ''}`} data-testid="task-select" key={run.id} onClick={() => setRunId(run.id)} aria-pressed={runId === run.id}><span className={`cw-run-dot cw-state-${run.status}`} /><span><strong>{cloudOperationLabel(run.operation)}</strong><small>{shortDate(run.created_at)} · {run.id.slice(0, 8)}</small></span><span className={`cw-status cw-state-${run.status}`}>{cloudStatusLabel(run.error === 'cancelled' ? 'cancelled' : run.status)}</span></button>)}</div>
              {detail && <div className="cw-run-detail"><div className="cw-detail-label">执行轨迹 <span>{detail.events.length} 条事件</span></div>{detail.run.error && detail.run.error !== 'cancelled' && <p className="cw-run-error" role="alert">{detail.run.error}</p>}<ol className="cw-timeline">{detail.events.map(event => <li key={event.id}><span className="cw-timeline-dot" /><div><strong>{eventLabel(event.kind)}</strong><time>{shortDate(event.created_at)}</time></div></li>)}</ol><CloudTaskRunDetail run={detail.run} client={client} onRunUpdated={nextRun => { dataRevisionRef.current += 1; setDetail(current => current?.run.id === nextRun.id ? { ...current, run: nextRun } : current); setRuns(current => current.map(run => run.id === nextRun.id ? nextRun : run)); }} /></div>}
            </section>
            <section className="cw-card cw-artifact-card" aria-labelledby="cw-artifact-title"><div className="cw-card-heading"><div><span className="cw-step">03</span><h2 id="cw-artifact-title">产物预览</h2></div><span className="cw-subtle-label">TEXT</span></div>{artifact ? <><div className="cw-artifact-meta"><span className="cw-file-icon"><CloudIcon kind="file" size={18} /></span><div><strong>{artifact.name}</strong><small>{formatBytes(artifact.size)} · 独立版本</small></div><a className="cw-download" data-testid="artifact-download" href={cloudContentUrl(artifact.version_id, true)} download={artifact.name} onClick={event => download(event, artifact.version_id, artifact.name)} aria-label={`下载 ${artifact.name}`}>↓</a></div>{detail && detail.artifacts.length > 1 && <select className="cw-select cw-artifact-select" aria-label="选择产物" value={artifact.id} onChange={event => setArtifact(detail.artifacts.find(item => item.id === event.target.value) || null)}>{detail.artifacts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}<pre className="cw-artifact-preview" data-testid="artifact-preview" aria-busy={previewLoading}>{previewLoading ? '正在读取产物…' : preview}</pre><div className="cw-artifact-foot"><CloudIcon kind="check" size={14} />已保存到工作空间</div></> : <div className="cw-artifact-empty"><div className="cw-document-illustration"><CloudIcon kind="file" size={44} /><span /><span /><span /></div><h3>{detail && isActiveCloudRun(detail.run.status) ? '正在准备你的结果' : '成果，即将就位'}</h3><p>{detail?.run.status === 'failed' ? '任务未完成，请查看执行轨迹中的错误信息。' : '任务完成后，结果会保存在这里，随时预览和下载。'}</p><span className="cw-empty-tag">可追溯 · 可下载 · 持久保存</span></div>}</section>
          </div>}
          {workspaceId && <div ref={cloudTaskSectionRef} className="cw-cloud-task-anchor"><CloudTasks workspaceId={workspaceId} client={client} health={health} files={files} runs={runs} onConfigureAI={onConfigureAI} onDirtyChange={onTaskDirtyChange} onBusyChange={setTaskBusy} onRunCreated={nextRun => { dataRevisionRef.current += 1; setRuns(current => [nextRun, ...current.filter(run => run.id !== nextRun.id)]); setRunId(nextRun.id); taskSectionRef.current?.scrollIntoView({ block: 'start' }); }} onSelectRun={id => { setRunId(id); taskSectionRef.current?.scrollIntoView({ block: 'start' }); }} /></div>}
          {workspaceId && <CloudRecords key={workspaceId} workspaceId={workspaceId} client={client} health={health} onConfigureAI={onConfigureAI} onDirtyChange={onRecordDirtyChange} />}
          {workspaceId && <details className="cw-events"><summary><span><CloudIcon kind="activity" size={15} />工作空间事件</span><span>最近 {events.length} 条</span></summary><ol>{events.slice().reverse().map(event => <li key={event.id}><time>{shortDate(event.created_at)}</time><span>{eventLabel(event.kind)}</span></li>)}</ol>{!events.length && <p>暂时没有事件。</p>}</details>}
          <footer className="cw-footer"><span>CODIA WORKSPACE</span><span>文件版本 / 持久任务 / 结果产物</span></footer>
        </div>
      </div>
    </section>
  );
}
