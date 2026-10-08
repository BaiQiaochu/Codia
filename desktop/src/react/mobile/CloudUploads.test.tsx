// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CloudUploads } from './CloudUploads';
import { CLOUD_RESUMABLE_UPLOAD_LIMIT, CLOUD_UPLOAD_CHUNK_SIZE, createCloudWorkspaceClient, readCloudUploadFile, type CloudHealth, type CloudUploadSession } from './cloud-workspace-api';
const stamp = '2026-10-09T00:00:00Z';
const health: CloudHealth = { mode: 'local', database: 'sqlite', objectStore: 'local', executor: 'fixed-document-transform', productionReady: false, uploadSession: true, resumableUploadLimit: CLOUD_RESUMABLE_UPLOAD_LIMIT, uploadChunkSize: CLOUD_UPLOAD_CHUNK_SIZE };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
function testFile(bytes: Uint8Array, name = '材料.bin'): File {
  const file = new File([bytes as BlobPart], name);
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
  return file;
}
function makeSession(bytes: Uint8Array): CloudUploadSession {
  return { id: 'upload-1', workspace_id: 'ws-1', name: '材料.bin', size: bytes.length, sha256: hash(bytes), state: 'uploading', chunk_size: CLOUD_UPLOAD_CHUNK_SIZE, received_chunks: [], received_bytes: 0, expires_at: stamp, revision: 1, file_id: 'file-1', version_id: 'v1' };
}
function fixture(bytes = new Uint8Array([0, 255, 1, 2, 3]), initiallySaved = false) {
  let session = makeSession(bytes);
  let listed = initiallySaved;
  let loseCreate = false, loseComplete = false, loseChunk = false;
  let cancelState: CloudUploadSession['state'] = 'cancelled';
  let chunkWait: ((init: RequestInit) => Promise<void>) | null = null;
  let createWait: ((init: RequestInit) => Promise<void>) | null = null;
  let completeWait: ((init: RequestInit) => Promise<void>) | null = null;
  const calls: { path: string; init: RequestInit }[] = [];
  const file = { id: 'file-1', name: session.name, current_version: 'v1', version_count: 1, size: bytes.length, sha256: session.sha256, created_at: stamp };
  const version = { id: 'v1', size: bytes.length, sha256: session.sha256, created_at: stamp };
  const client = createCloudWorkspaceClient(async (fullPath, init) => {
    const path = fullPath.replace('/api/cloud', ''); calls.push({ path, init });
    if (path.endsWith('/uploads') && !init.method) return json({ uploads: listed ? [session] : [] });
    if (path.endsWith('/uploads') && init.method === 'POST') {
      listed = true;
      if (createWait) await createWait(init);
      if (loseCreate) { loseCreate = false; throw new TypeError('Create response lost'); }
      return json({ upload: session });
    }
    if (path === '/uploads/upload-1' && !init.method) return json({ upload: session });
    if (path.includes('/chunks/')) {
      const index = Number(path.split('/').at(-1));
      const chunk = new Uint8Array(init.body as ArrayBuffer);
      if (!session.received_chunks.includes(index)) session = { ...session, received_chunks: [...session.received_chunks, index], received_bytes: session.received_bytes + chunk.byteLength, revision: session.revision + 1 };
      if (chunkWait) await chunkWait(init);
      if (loseChunk) { loseChunk = false; throw new TypeError('Chunk response lost'); }
      return json({ upload: session });
    }
    if (path.endsWith('/complete')) {
      session = { ...session, state: 'completed' };
      if (completeWait) await completeWait(init);
      if (loseComplete) { loseComplete = false; throw new TypeError('Complete response lost'); }
      return json({ upload: session, file, version });
    }
    if (path.endsWith('/cancel')) { session = { ...session, state: cancelState, ...(cancelState === 'completed' ? { received_bytes: bytes.length } : {}) }; return json({ upload: session }); }
    if (path.endsWith('/files')) return json({ files: [file] });
    if (path.endsWith('/versions')) return json({ versions: [version] });
    throw new Error(`Unexpected request ${path}`);
  });
  return { bytes, calls, client, file, version, getSession: () => session,
    cancelReturns: (state: CloudUploadSession['state']) => { cancelState = state; },
    loseCreate: () => { loseCreate = true; }, loseComplete: () => { loseComplete = true; }, loseChunk: () => { loseChunk = true; },
    holdComplete: (wait: typeof completeWait) => { completeWait = wait; },
    holdChunk: (wait: typeof chunkWait) => { chunkWait = wait; }, holdCreate: (wait: typeof createWait) => { createWait = wait; },
  };
}
function mount(f: ReturnType<typeof fixture>, overrides: Partial<React.ComponentProps<typeof CloudUploads>> = {}) {
  const onSaved = vi.fn(); const props = { workspaceId: 'ws-1', client: f.client, health, files: [], onSaved, ...overrides };
  const result = render(<CloudUploads {...props} />);
  return { ...result, props, onSaved };
}
function selectFile(file: File) { fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } }); }
function start() { fireEvent.click(screen.getByTestId('upload-file')); }
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('durable browser upload sessions', () => {
  it('sends binary chunks and checksums through the existing authenticated transport, once on repeated clicks', async () => {
    const bytes = new Uint8Array(CLOUD_UPLOAD_CHUNK_SIZE + 3).fill(255); bytes[0] = 0;
    const f = fixture(bytes); const view = mount(f);
    selectFile(testFile(bytes)); start(); start();
    await waitFor(() => expect(view.onSaved).toHaveBeenCalledTimes(1));
    const creates = f.calls.filter(call => call.path.endsWith('/uploads') && call.init.method);
    expect(creates).toHaveLength(1);
    expect(JSON.parse(String(creates[0].init.body))).toMatchObject({ size: bytes.length, sha256: hash(bytes), requestKey: expect.any(String) });
    const chunks = f.calls.filter(call => call.path.includes('/chunks/'));
    expect(chunks).toHaveLength(2); expect(chunks.map(call => (call.init.body as Uint8Array).byteLength)).toEqual([CLOUD_UPLOAD_CHUNK_SIZE, 3]);
    expect([...chunks[0].init.body as Uint8Array].slice(0, 2)).toEqual([0, 255]);
    for (const chunk of chunks) {
      const headers = new Headers(chunk.init.headers);
      expect(headers.get('Content-Type')).toBe('application/octet-stream');
      expect(headers.get('X-Requested-With')).toBe('cloud-studio');
      expect(headers.get('X-Chunk-SHA256')).toBe(hash(chunk.init.body as Uint8Array));
    }
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', String(bytes.length));
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });

  it('allows selecting another file directly after a completed upload', async () => {
    const f = fixture(); const view = mount(f); selectFile(testFile(f.bytes)); start();
    await waitFor(() => expect(view.onSaved).toHaveBeenCalledTimes(1));
    selectFile(testFile(f.bytes, '另一份材料.bin'));
    expect(screen.getByTestId('upload-file')).toBeEnabled();
    expect(screen.getByTestId('upload-file')).toHaveTextContent('上传并保存');
  });

  it('completes an empty file without emitting invalid empty chunks', async () => {
    const f = fixture(new Uint8Array()); const view = mount(f); selectFile(testFile(f.bytes)); start();
    await waitFor(() => expect(view.onSaved).toHaveBeenCalledTimes(1));
    expect(f.calls.filter(call => call.path.includes('/chunks/'))).toHaveLength(0);
    expect(f.calls.filter(call => call.path.endsWith('/complete'))).toHaveLength(1);
  });

  it('keeps the same creation request key and pinned target across an uncertain reply', async () => {
    const f = fixture(); f.loseCreate(); const view = mount(f, { files: [f.file] }); selectFile(testFile(f.bytes)); start();
    await screen.findByRole('alert');
    view.rerender(<CloudUploads {...view.props} files={[{ ...f.file, current_version: 'newer-v2' }]} />);
    start(); await waitFor(() => expect(view.onSaved).toHaveBeenCalledTimes(1));
    const writes = f.calls.filter(call => call.path.endsWith('/uploads') && call.init.method);
    expect(writes).toHaveLength(2); expect(writes[0].init.body).toBe(writes[1].init.body);
    expect(JSON.parse(String(writes[0].init.body)).expectedVersion).toBe('v1');
  });

  it('reconciles a lost chunk response and resumes only missing indices', async () => {
    const f = fixture(new Uint8Array(CLOUD_UPLOAD_CHUNK_SIZE + 2).fill(7)); f.loseChunk(); const view = mount(f);
    selectFile(testFile(f.bytes)); start(); await screen.findByRole('alert'); start();
    await waitFor(() => expect(view.onSaved).toHaveBeenCalledTimes(1));
    expect(f.calls.filter(call => call.path.includes('/chunks/')).map(call => call.path)).toEqual(['/uploads/upload-1/chunks/0', '/uploads/upload-1/chunks/1']);
    expect(f.calls.filter(call => call.path.endsWith('/uploads') && call.init.method)).toHaveLength(1);
  });

  it('queries the same session after a lost complete response and never repeats completion or creates another version', async () => {
    const f = fixture(); f.loseComplete(); const view = mount(f); selectFile(testFile(f.bytes)); start();
    await waitFor(() => expect(view.onSaved).toHaveBeenCalledTimes(1));
    const index = f.calls.findIndex(call => call.path.endsWith('/complete'));
    expect(f.calls[index + 1].path).toBe('/uploads/upload-1');
    expect(f.calls.filter(call => call.path.endsWith('/complete'))).toHaveLength(1);
    expect(f.calls.filter(call => call.path.endsWith('/uploads') && call.init.method)).toHaveLength(1);
  });

  it('aborts a paused transfer then reconciles accepted bytes before continuing', async () => {
    const f = fixture(new Uint8Array(CLOUD_UPLOAD_CHUNK_SIZE + 4).fill(9));
    f.holdChunk(init => new Promise<void>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })));
    const view = mount(f); selectFile(testFile(f.bytes)); start();
    await waitFor(() => expect(f.calls.some(call => call.path.includes('/chunks/'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '暂停上传' }));
    await screen.findByText(/已暂停。服务器保留/);
    expect(f.calls.find(call => call.path.includes('/chunks/'))?.init.signal?.aborted).toBe(true);
    f.holdChunk(null); start(); await waitFor(() => expect(view.onSaved).toHaveBeenCalledTimes(1));
    expect(f.calls.filter(call => call.path.includes('/chunks/'))).toHaveLength(2);
  });

  it('recovers a completion committed while its request was paused without repeating the POST', async () => {
    const f = fixture(); f.holdComplete(init => new Promise<void>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })));
    const view = mount(f); selectFile(testFile(f.bytes)); start();
    await waitFor(() => expect(f.calls.some(call => call.path.endsWith('/complete'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '暂停上传' })); await screen.findByText(/已暂停。服务器保留/);
    f.holdComplete(null); start(); await waitFor(() => expect(view.onSaved).toHaveBeenCalledTimes(1));
    expect(f.calls.filter(call => call.path.endsWith('/complete'))).toHaveLength(1);
  });

  it('reloads authorized sessions without storing bytes and requires reselecting the original content', async () => {
    const f = fixture(); f.loseChunk(); const first = mount(f); selectFile(testFile(f.bytes)); start(); await screen.findByRole('alert'); first.unmount();
    const view = mount(f);
    fireEvent.click(await screen.findByRole('button', { name: /材料.bin.*等待继续/ }));
    expect(screen.queryByTestId('upload-file')).not.toBeInTheDocument();
    const wrong = f.bytes.slice(); wrong[0] = 3; selectFile(testFile(wrong)); start();
    expect(await screen.findByRole('alert')).toHaveTextContent('SHA-256');
    expect(f.calls.filter(call => call.path.includes('/chunks/'))).toHaveLength(1);
    selectFile(testFile(f.bytes)); start(); await waitFor(() => expect(view.onSaved).toHaveBeenCalledTimes(1));
    expect(f.calls.filter(call => call.path.endsWith('/uploads') && call.init.method)).toHaveLength(1);
  });

  it('fences late creation replies after changing workspace and aborts on unmount', async () => {
    const f = fixture(); let release = () => {};
    f.holdCreate(() => new Promise<void>(resolve => { release = resolve; }));
    const view = mount(f); selectFile(testFile(f.bytes)); start();
    await waitFor(() => expect(f.calls.some(call => call.init.method === 'POST')).toBe(true));
    const write = f.calls.find(call => call.init.method === 'POST')!;
    view.rerender(<CloudUploads {...view.props} workspaceId="ws-2" />);
    expect(write.init.signal?.aborted).toBe(true);
    await act(async () => release());
    expect(view.onSaved).not.toHaveBeenCalled();
    expect(f.calls.filter(call => call.path.includes('/chunks/'))).toHaveLength(0);
    expect(screen.queryByTestId('upload-progress')).not.toBeInTheDocument();
    view.unmount(); expect(f.calls.every(call => call.init.signal?.aborted)).toBe(true);
  });

  it('does not publish a late completion after unmount even if the transport ignores abort', async () => {
    const f = fixture(); let release = () => {};
    f.holdChunk(() => new Promise<void>(resolve => { release = resolve; }));
    const view = mount(f); selectFile(testFile(f.bytes)); start();
    await waitFor(() => expect(f.calls.some(call => call.path.includes('/chunks/'))).toBe(true));
    view.unmount(); await act(async () => release());
    expect(view.onSaved).not.toHaveBeenCalled(); expect(f.calls.some(call => call.path.endsWith('/complete'))).toBe(false);
  });

  it('cancels an existing pending session once without deleting file versions', async () => {
    const f = fixture(undefined, true); mount(f);
    fireEvent.click(await screen.findByRole('button', { name: /材料.bin.*等待继续/ }));
    const cancel = screen.getByRole('button', { name: '取消此上传' }); fireEvent.click(cancel); fireEvent.click(cancel);
    await screen.findByText('上传已取消。已保存的文件版本不受影响。');
    expect(f.calls.filter(call => call.init.method)).toHaveLength(1); expect(f.getSession().state).toBe('cancelled');
    expect(screen.queryByRole('button', { name: '取消此上传' })).not.toBeInTheDocument();
  });

  it('reconciles a completed version when completion wins the cancellation race', async () => {
    const f = fixture(undefined, true); f.cancelReturns('completed'); const view = mount(f);
    fireEvent.click(await screen.findByRole('button', { name: /材料.bin.*等待继续/ }));
    fireEvent.click(screen.getByRole('button', { name: '取消此上传' }));
    await screen.findByText('上传已完成并保存，取消未更改此文件版本。');
    expect(view.onSaved).toHaveBeenCalledWith(f.file, f.version, false);
    expect(screen.queryByText('上传已取消。已保存的文件版本不受影响。')).not.toBeInTheDocument();
    expect(f.calls.filter(call => call.path.endsWith('/complete'))).toHaveLength(0);
  });

  it('reports expiry rather than claiming cancellation when the session has expired', async () => {
    const f = fixture(undefined, true); f.cancelReturns('expired'); const view = mount(f);
    fireEvent.click(await screen.findByRole('button', { name: /材料.bin.*等待继续/ }));
    fireEvent.click(screen.getByRole('button', { name: '取消此上传' }));
    await screen.findByText('上传已过期，请重新开始上传。');
    expect(view.onSaved).not.toHaveBeenCalled(); expect(screen.queryByText('上传已取消。已保存的文件版本不受影响。')).not.toBeInTheDocument();
  });

  it('bounds full-file hashing at 32 MiB before reading any bytes', async () => {
    const arrayBuffer = vi.fn();
    await expect(readCloudUploadFile({ size: CLOUD_RESUMABLE_UPLOAD_LIMIT + 1, arrayBuffer } as unknown as File)).rejects.toThrow('32 MiB');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('keeps the 2 MiB legacy path when a server lacks the resumable capability', async () => {
    const f = fixture(); mount(f, { health: { ...health, uploadSession: undefined } });
    expect(screen.getByText(/当前服务未提供断点上传/)).toBeInTheDocument();
    selectFile(testFile(new Uint8Array(2 * 1024 * 1024 + 1))); start();
    expect(await screen.findByRole('alert')).toHaveTextContent('2.0 MiB');
    expect(f.calls).toHaveLength(0);
  });

  it('does not call raw routes through a legacy custom transport without chunk support', () => {
    const f = fixture(); mount(f, { client: { ...f.client, uploadChunk: undefined } });
    expect(screen.queryByRole('button', { name: '刷新上传列表' })).not.toBeInTheDocument();
    expect(screen.getByText(/最大 2.0 MiB/)).toBeInTheDocument();
  });
});
