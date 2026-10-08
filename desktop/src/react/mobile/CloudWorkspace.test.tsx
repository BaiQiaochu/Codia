// @vitest-environment jsdom
import React from 'react';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CloudWorkspace } from './CloudWorkspace';
import { CLOUD_UPLOAD_LIMIT, cloudContentUrl, cloudJson, fileContentBase64, inspectCloudContent, type CloudHealth } from './cloud-workspace-api';

const workspace = { id: 'workspace-1', name: '研究项目', created_at: '2026-10-07T12:00:00Z' };
const version = { id: 'version-1', size: 25, sha256: 'a'.repeat(64), created_at: '2026-10-07T12:00:00Z' };
const file = { name: '研究材料.txt', current_version: version.id, version_count: 1, ...version, id: 'file-1' };
const run = { id: 'run-1', status: 'succeeded', operation: 'document-summary', input_version: version.id, created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z' };
const artifact = { id: 'artifact-1', file_id: 'file-2', version_id: 'version-output', name: '检查摘要.txt', size: 42 };
const defaultHealth: CloudHealth = { mode: 'local', database: 'sqlite-local', objectStore: 'local', executor: 'fixed-document-transform', productionReady: false };
let health: CloudHealth;
let sourceContent: Uint8Array;
let savedFiles = [file];
let savedRuns: typeof run[] = [];
let mutations: { path: string; method: string; body: Record<string, unknown> }[] = [];
let requestHeaders: Headers[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function installApi() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = String(input).replace('/api/cloud', '');
    if (init.method === 'POST') {
      mutations.push({ path, method: init.method, body: JSON.parse(String(init.body)) });
      requestHeaders.push(new Headers(init.headers));
      if (path === '/workspaces') return json({ workspace: { ...workspace, id: 'workspace-2', name: '新研究' } });
      if (path.endsWith('/runs')) { savedRuns = [run]; return json({ run }, 202); }
      if (path.endsWith('/versions')) {
        const nextVersion = { ...version, id: 'version-2' };
        const nextFile = { ...file, current_version: nextVersion.id, version_count: 2 };
        savedFiles = [nextFile];
        return json({ file: nextFile, version: nextVersion }, 201);
      }
    }
    if (path === '/health') return json(health);
    if (path === '/workspaces') return json({ workspaces: [workspace] });
    if (path.endsWith('/files')) return json({ files: savedFiles });
    if (path.endsWith('/runs')) return json({ runs: savedRuns });
    if (path.includes('/records?')) return json({ records: [] });
    if (path.endsWith('/task-plans')) return json({ plans: [] });
    if (path.endsWith('/schedules')) return json({ schedules: [] });
    if (path.includes('/events?')) return json({ events: [], cursor: 0 });
    if (path === '/files/file-1/versions') return json({ versions: [version, ...(savedFiles[0].version_count > 1 ? [{ ...version, id: 'version-2' }] : [])] });
    if (path === '/runs/run-1') return json({ run, events: [{ id: 1, kind: 'run.succeeded', payload: {}, created_at: run.created_at }], artifacts: [artifact] });
    if (/^\/versions\/version-[12]\/content$/.test(path)) return new Response(sourceContent as BodyInit);
    if (path === '/versions/version-output/content') return new Response('摘要：<script>window.injected = true</script>');
    throw new Error(`Unexpected request: ${path}`);
  }));
}

beforeEach(() => { localStorage.clear(); health = { ...defaultHealth }; sourceContent = new TextEncoder().encode('研究材料 UTF-8 text'); savedFiles = [file]; savedRuns = []; mutations = []; requestHeaders = []; installApi(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function ready() {
  render(<CloudWorkspace principal={{ userId: 'alice' }} />);
  await waitFor(() => expect((screen.getByTestId('submit-task') as HTMLButtonElement).disabled).toBe(false));
}

describe('Cloud workspace UI', () => {
  it('loads API contract data, restores workspace selection, and explains the local fixed workflow', async () => {
    localStorage.setItem('gsap-cloud-workspace:alice', workspace.id);
    await ready();
    expect((screen.getByTestId('workspace-select') as HTMLSelectElement).value).toBe(workspace.id);
    expect(screen.getByText(/开发验证 · 本地持久化/)).toBeTruthy();
    expect(screen.getByText(/尚未接入 AI 模型/)).toBeTruthy();
    expect((screen.getByTestId('task-prompt') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.getByText('下载此版本 ↗').getAttribute('href')).toBe('/api/cloud/versions/version-1/content?download=1');
  });

  it('guards repeated submissions, pins the input version, and previews artifact text safely', async () => {
    await ready();
    const submit = screen.getByTestId('submit-task');
    fireEvent.click(submit); fireEvent.click(submit);
    await waitFor(() => expect(screen.getByTestId('artifact-preview').textContent).toContain('<script>'));
    const submitted = mutations.filter(item => item.path.endsWith('/runs'));
    expect(submitted).toHaveLength(1);
    expect(submitted[0].body).toMatchObject({ inputVersion: version.id, operation: 'document-summary' });
    expect(typeof submitted[0].body.requestKey).toBe('string');
    expect(requestHeaders[0].get('X-Requested-With')).toBe('cloud-studio');
    expect(screen.getByTestId('artifact-preview').querySelector('script')).toBeNull();
    expect(screen.getByTestId('artifact-download').getAttribute('href')).toBe('/api/cloud/versions/version-output/content?download=1');
  });

  it('saves same-name uploads as a new immutable version with concurrency protection', async () => {
    await ready();
    const upload = new File(['新版本'], file.name, { type: 'text/plain' });
    Object.defineProperty(upload, 'arrayBuffer', { value: async () => new TextEncoder().encode('新版本').buffer });
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [upload] } });
    fireEvent.click(screen.getByTestId('upload-file'));
    await waitFor(() => expect(screen.getByText('新版本已保存，原版本仍可读取。')).toBeTruthy());
    expect(screen.getByTestId('file-select').textContent).toContain('2 个版本');
    expect(screen.getByTestId('file-select').textContent).not.toContain('NaN');
    expect(mutations[0].path).toBe('/files/file-1/versions');
    expect(mutations[0].body.expectedVersion).toBe('version-1');
    await waitFor(() => expect((screen.getByTestId('version-select') as HTMLSelectElement).value).toBe('version-2'));
  });

  it('uploads binary bytes losslessly, keeps downloads, and disables text-only operations by content', async () => {
    await ready();
    sourceContent = new Uint8Array([0, 255, 13, 10, 1, 2, 80, 75]);
    const upload = new File([sourceContent as BlobPart], file.name, { type: 'application/octet-stream' });
    Object.defineProperty(upload, 'arrayBuffer', { value: async () => sourceContent.slice().buffer });
    expect(screen.getByTestId('file-input').hasAttribute('accept')).toBe(false);
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [upload] } });
    fireEvent.click(screen.getByTestId('upload-file'));
    await screen.findByText('新版本已保存，原版本仍可读取。');
    await screen.findByTestId('input-binary-note');
    expect((screen.getByTestId('submit-task') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('下载此版本 ↗').getAttribute('href')).toContain('version-2/content?download=1');
    const persistedBytes = Buffer.from(mutations[0].body.contentBase64 as string, 'base64');
    expect([...persistedBytes]).toEqual([...sourceContent]);
    expect(createHash('sha256').update(persistedBytes).digest('hex')).toBe(createHash('sha256').update(sourceContent).digest('hex'));
    expect(mutations.filter(item => item.path.endsWith('/runs'))).toHaveLength(0);
  });

  it('creates a workspace once on repeated form submission', async () => {
    await ready();
    fireEvent.change(screen.getByTestId('workspace-name'), { target: { value: '新研究' } });
    const button = screen.getByTestId('create-workspace');
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect((screen.getByTestId('workspace-select') as HTMLSelectElement).value).toBe('workspace-2'));
    expect(mutations.filter(item => item.path === '/workspaces')).toHaveLength(1);
  });

  it('cancelling file selection clears the pending upload without mutating data', async () => {
    await ready();
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [new File(['content'], 'new.txt')] } });
    expect(screen.getByTestId('upload-file')).toBeTruthy();
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [] } });
    expect(screen.queryByTestId('upload-file')).toBeNull();
    expect(mutations).toHaveLength(0);
  });

  it('pins an explicitly selected historical version and defaults to latest after refresh', async () => {
    savedFiles = [{ ...file, current_version: 'version-2', version_count: 2 }];
    await ready();
    expect((screen.getByTestId('version-select') as HTMLSelectElement).value).toBe('version-2');
    fireEvent.change(screen.getByTestId('version-select'), { target: { value: 'version-1' } });
    await waitFor(() => expect((screen.getByTestId('submit-task') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('submit-task'));
    await waitFor(() => expect(mutations.some(item => item.path.endsWith('/runs'))).toBe(true));
    expect(mutations.find(item => item.path.endsWith('/runs'))?.body.inputVersion).toBe('version-1');
    await waitFor(() => expect((screen.getByTestId('refresh-workspace') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('refresh-workspace'));
    await waitFor(() => expect((screen.getByTestId('version-select') as HTMLSelectElement).value).toBe('version-2'));
  });

  it('aborts old requests on leaving the view and ignores responses after remount', async () => {
    const realFetch = fetch;
    const signals: AbortSignal[] = [];
    let resolveHealth: (value: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init: RequestInit = {}) => {
      if (init.signal) signals.push(init.signal);
      if (String(input).endsWith('/health')) return new Promise<Response>(resolve => { resolveHealth = resolve; });
      return realFetch(input, init);
    }));
    const first = render(<CloudWorkspace principal={{ userId: 'alice' }} />);
    await waitFor(() => expect(signals.length).toBeGreaterThan(0));
    first.unmount();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    installApi();
    await ready();
    await act(async () => resolveHealth(json({ mode: 'stale-server', productionReady: true })));
    expect(screen.queryByText('stale-server')).toBeNull();
    expect(screen.getByText(/开发验证 · 本地持久化/)).toBeTruthy();
  });

  it('gates unavailable agent-summary honestly while keeping document processing usable', async () => {
    health = { ...defaultHealth, executor: 'codia-agent', supportedOperations: ['document-summary', 'agent-summary'], executorAvailable: false, executorUnavailableReason: 'model_not_configured' };
    await ready();
    fireEvent.change(screen.getByTestId('operation-select'), { target: { value: 'agent-summary' } });
    expect((screen.getByTestId('submit-task') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/尚未配置模型，请在设置中添加/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('submit-task'));
    expect(mutations.filter(item => item.path.endsWith('/runs'))).toHaveLength(0);
    fireEvent.change(screen.getByTestId('operation-select'), { target: { value: 'document-summary' } });
    expect((screen.getByTestId('submit-task') as HTMLButtonElement).disabled).toBe(false);
  });

  it('submits genuine agent-summary with a pinned version and discloses the configured model destination', async () => {
    health = { ...defaultHealth, executor: 'codia-agent', supportedOperations: ['document-summary', 'agent-summary'], executorAvailable: true };
    await ready();
    fireEvent.change(screen.getByTestId('operation-select'), { target: { value: 'agent-summary' } });
    expect((screen.getByTestId('task-prompt') as HTMLTextAreaElement).value).toContain('发送给你配置的模型服务商');
    fireEvent.click(screen.getByTestId('submit-task'));
    await waitFor(() => expect(mutations.some(item => item.path.endsWith('/runs'))).toBe(true));
    expect(mutations.find(item => item.path.endsWith('/runs'))?.body).toMatchObject({ operation: 'agent-summary', inputVersion: 'version-1' });
    expect(screen.queryByText(/尚未接入 AI 模型/)).toBeNull();
  });

  it('enables AI after a health refresh without replacing the workspace data', async () => {
    health = { ...defaultHealth, executor: 'codia-agent', supportedOperations: ['document-summary', 'agent-summary'], executorAvailable: false };
    await ready();
    fireEvent.change(screen.getByTestId('operation-select'), { target: { value: 'agent-summary' } });
    expect((screen.getByTestId('submit-task') as HTMLButtonElement).disabled).toBe(true);
    health = { ...health, executorAvailable: true };
    fireEvent.click(screen.getByTestId('refresh-workspace'));
    await waitFor(() => expect((screen.getByTestId('submit-task') as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByTestId('operation-select') as HTMLSelectElement).value).toBe('agent-summary');
    expect(screen.getByTestId('file-select').textContent).toContain(file.name);
  });

  it('keeps AI processing at 128 KiB even when larger stored text remains previewable', async () => {
    health = { ...defaultHealth, executor: 'codia-agent', executorAvailable: true, agentInputLimit: 128 * 1024, supportedOperations: ['document-summary', 'agent-summary'] };
    sourceContent = new TextEncoder().encode('a'.repeat(128 * 1024 + 1));
    const oldVersionSize = version.size;
    version.size = sourceContent.length;
    try {
      await ready();
      fireEvent.change(screen.getByTestId('operation-select'), { target: { value: 'agent-summary' } });
      expect((screen.getByTestId('submit-task') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/选定版本超过当前处理上限/)).toBeTruthy();
      expect(screen.getByTestId('input-file-preview').textContent?.length).toBeLessThan(21000);
      expect(screen.getByText('下载此版本 ↗')).toBeTruthy();
      fireEvent.change(screen.getByTestId('operation-select'), { target: { value: 'document-summary' } });
      expect((screen.getByTestId('submit-task') as HTMLButtonElement).disabled).toBe(false);
    } finally { version.size = oldVersionSize; }
  });

  it('keeps files above 2 MiB stored and downloadable without permitting document processing', async () => {
    sourceContent = new TextEncoder().encode('a'.repeat(CLOUD_UPLOAD_LIMIT + 1));
    render(<CloudWorkspace principal={{ userId: 'alice' }} />);
    await screen.findByTestId('input-binary-note');
    expect((screen.getByTestId('submit-task') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('下载此版本 ↗')).toBeTruthy();
    expect(screen.queryByTestId('input-file-preview')).toBeNull();
    expect(mutations).toHaveLength(0);
  });

  it('shows an actionable expired-session error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unauthorized' }, 401)));
    render(<CloudWorkspace principal={{ userId: 'alice' }} />);
    expect((await screen.findByRole('alert')).textContent).toContain('登录已失效');
  });
});

describe('Cloud API boundaries', () => {
  it('encodes identifiers, preserves binary bytes, and rejects oversized uploads', async () => {
    expect(cloudContentUrl('../bad/id', true)).toBe('/api/cloud/versions/..%2Fbad%2Fid/content?download=1');
    const binary = { size: 2, arrayBuffer: async () => new Uint8Array([0, 1]).buffer } as File;
    await expect(fileContentBase64(binary)).resolves.toBe('AAE=');
    await expect(fileContentBase64({ size: CLOUD_UPLOAD_LIMIT + 1 } as File)).rejects.toThrow('2 MiB');
  });

  it('inspects bounded content instead of extensions and never interprets markup as HTML', async () => {
    expect(await inspectCloudContent(new Response('%PDF-1.5 ascii-only PDF'))).toEqual({ kind: 'binary' });
    expect(await inspectCloudContent(new Response(new Uint8Array([255, 254])))).toEqual({ kind: 'binary' });
    expect(await inspectCloudContent(new Response(''))).toEqual({ kind: 'empty' });
    expect(await inspectCloudContent(new Response('<script>alert(1)</script>'))).toEqual({ kind: 'text', text: '<script>alert(1)</script>' });
    expect(await inspectCloudContent(new Response('short', { headers: { 'Content-Length': String(CLOUD_UPLOAD_LIMIT + 1) } }))).toEqual({ kind: 'too-large' });
  });

  it('translates version conflicts into an explicit refresh instruction', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'version_conflict' }, 409)));
    await expect(cloudJson('/files/file-1/versions', { method: 'POST', body: '{}' })).rejects.toThrow('文件已出现新版本');
  });
});
