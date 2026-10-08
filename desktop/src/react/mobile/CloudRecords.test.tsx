// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CloudRecords, type CloudRecord } from './CloudRecords';
import { createCloudWorkspaceClient, type CloudRun, type CloudHealth } from './cloud-workspace-api';

const baseRecord: CloudRecord = { id: 'record-1', kind: 'business', title: '项目讨论', currentVersion: 'version-1', data: { messages: [{ role: 'user', text: 'Hello' }] }, createdAt: '2026-10-07', updatedAt: '2026-10-07' };
let record: CloudRecord;
let writes: { path: string; method: string; body: Record<string, unknown> }[];
let conflict: boolean;
let activeRun: CloudRun | null;
const aiHealth: CloudHealth = { mode: 'local', database: 'sqlite', objectStore: 'local', executor: 'codia-agent', executorAvailable: true, productionReady: false };
const queuedRun: CloudRun = { id: 'agent-run-1', operation: 'agent-conversation', status: 'queued', input_version: 'version-2', created_at: '2026-10-07', updated_at: '2026-10-07' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function client() {
  return createCloudWorkspaceClient(async (path, init) => {
    if (init.method) {
      const body = JSON.parse(String(init.body));
      writes.push({ path, method: init.method, body });
      if (conflict) return json({ error: 'version_conflict' }, 409);
      if (path.endsWith('/messages')) {
        activeRun = queuedRun;
        record = { ...record, currentVersion: 'version-2', data: { messages: [...(record.data?.messages as unknown[] || []), { id: 'user-2', role: 'user', text: body.text }] } };
        return json({ record, run: activeRun });
      }
      record = { ...record, ...body, currentVersion: init.method === 'PUT' ? 'version-2' : 'version-1' };
      return json({ record });
    }
    if (path.includes('/records?')) return json({ records: [record] });
    if (activeRun) {
      activeRun = { ...activeRun, status: 'succeeded' };
      record = { ...record, data: { ...record.data, messages: [...(record.data?.messages as unknown[] || []), { id: 'assistant-2', role: 'assistant', text: 'Persisted AI answer' }] } };
      return json({ record, run: activeRun });
    }
    return json({ record });
  });
}
beforeEach(() => { record = { ...baseRecord }; writes = []; conflict = false; activeRun = null; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function ready(kind: 'business' | 'conversation' | 'workflow' = 'business', health: CloudHealth | null = null) {
  render(<CloudRecords workspaceId="workspace-1" client={client()} health={health} />);
  if (kind !== 'conversation') fireEvent.change(screen.getByLabelText('记录类型'), { target: { value: kind } });
  await screen.findByRole('button', { name: /项目讨论/ });
}

describe('cloud structured record editor', () => {
  it('creates structured records with chosen kind and guards repeated submit', async () => {
    await ready();
    fireEvent.change(screen.getByLabelText('记录类型'), { target: { value: 'business' } });
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '合同跟进' } });
    fireEvent.change(screen.getByLabelText('内容（JSON 对象）'), { target: { value: '{"status":"review","amount":20}' } });
    fireEvent.click(screen.getByRole('button', { name: '创建记录' }));
    fireEvent.click(screen.getByRole('button', { name: '正在处理…' }));
    await screen.findByText('云端记录已创建。');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ path: '/api/cloud/workspaces/workspace-1/records', method: 'POST', body: { kind: 'business', title: '合同跟进', data: { status: 'review', amount: 20 } } });
  });

  it('loads existing content and saves a new version with optimistic concurrency', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /项目讨论/ }));
    await waitFor(() => expect(screen.getByLabelText('标题')).toHaveValue('项目讨论'));
    expect((screen.getByLabelText('内容（JSON 对象）') as HTMLTextAreaElement).value).toContain('Hello');
    fireEvent.change(screen.getByLabelText('内容（JSON 对象）'), { target: { value: '{"messages":[]}' } });
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }));
    await screen.findByText('新版本已保存。');
    expect(writes[0]).toMatchObject({ method: 'PUT', path: '/api/cloud/records/record-1', body: { data: { messages: [] }, expectedVersion: 'version-1' } });
    expect(screen.getByText('版本 version-2')).toBeInTheDocument();
  });

  it('keeps unsaved text on conflicts and requires an explicit choice before replacing it', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /项目讨论/ }));
    await waitFor(() => expect(screen.getByLabelText('标题')).toHaveValue('项目讨论'));
    fireEvent.change(screen.getByLabelText('内容（JSON 对象）'), { target: { value: '{"draft":"keep me"}' } });
    conflict = true;
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }));
    expect((await screen.findByRole('alert')).textContent).toContain('记录已出现新版本');
    expect(screen.getByLabelText('内容（JSON 对象）')).toHaveValue('{"draft":"keep me"}');
    fireEvent.click(screen.getByRole('button', { name: '重新读取云端版本' }));
    fireEvent.click(screen.getByRole('button', { name: '返回编辑' }));
    expect(screen.getByLabelText('内容（JSON 对象）')).toHaveValue('{"draft":"keep me"}');
    fireEvent.click(screen.getByRole('button', { name: '重新读取云端版本' }));
    record = { ...record, currentVersion: 'version-other', data: { remote: true } };
    fireEvent.click(screen.getByRole('button', { name: '放弃更改' }));
    await waitFor(() => expect((screen.getByLabelText('内容（JSON 对象）') as HTMLTextAreaElement).value).toContain('remote'));
    expect(writes).toHaveLength(1);
  });

  it('rejects invalid or non-object JSON without a network write', async () => {
    await ready();
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Draft' } });
    fireEvent.change(screen.getByLabelText('内容（JSON 对象）'), { target: { value: '[1,2]' } });
    fireEvent.click(screen.getByRole('button', { name: '创建记录' }));
    expect(screen.getByRole('alert').textContent).toContain('有效的 JSON 对象');
    expect(writes).toHaveLength(0);
  });

  it('edits workflow instructions with a normal form and saves a structured definition', async () => {
    await ready('workflow');
    expect(screen.queryByLabelText('内容（JSON 对象）')).toBeNull();
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '每日总结' } });
    fireEvent.change(screen.getByLabelText('工作流指令'), { target: { value: '总结项目进展，列出阻碍与下一步' } });
    fireEvent.click(screen.getByRole('button', { name: '创建记录' }));
    await screen.findByText('云端记录已创建。');
    expect(writes[0].body).toMatchObject({ kind: 'workflow', data: { instruction: '总结项目进展，列出阻碍与下一步', steps: [] } });
  });

  it('sends a cloud conversation message once, pins its version, and recovers the persisted AI reply', async () => {
    record = { ...record, kind: 'conversation' };
    await ready('conversation', aiHealth);
    expect(screen.queryByLabelText('内容（JSON 对象）')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /项目讨论/ }));
    await waitFor(() => expect(screen.getByLabelText('标题')).toHaveValue('项目讨论'));
    expect(screen.getByRole('log').textContent).toContain('Hello');
    fireEvent.change(screen.getByLabelText('消息'), { target: { value: 'What is next?' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await screen.findByText('消息已保存，AI 回复会自动显示。');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: '/api/cloud/records/record-1/messages', body: { text: 'What is next?', expectedVersion: 'version-1' } });
    expect(typeof writes[0].body.requestKey).toBe('string');
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
    await screen.findByText('Persisted AI answer', {}, { timeout: 3500 });
  });

  it('resumes pendingRuns returned after reopening and reads the durable reply without resubmitting', async () => {
    let reads = 0;
    const pendingRecord = { ...baseRecord, kind: 'conversation' as const, pendingRuns: [queuedRun] };
    const transport = vi.fn(async (path: string) => {
      if (path.includes('/records?')) return json({ records: [pendingRecord] });
      reads += 1;
      return reads === 1 ? json({ record: pendingRecord }) : json({ record: { ...pendingRecord, pendingRuns: [], data: { messages: [{ id: 'answer', role: 'assistant', text: 'Recovered after reopen' }] } } });
    });
    render(<CloudRecords workspaceId="workspace-1" client={createCloudWorkspaceClient(transport)} health={aiHealth} />);
    fireEvent.click(await screen.findByRole('button', { name: /项目讨论/ }));
    expect(await screen.findByText(/AI 正在回复/)).toBeInTheDocument();
    expect(await screen.findByText('Recovered after reopen', {}, { timeout: 2500 })).toBeInTheDocument();
    expect(reads).toBe(2);
    expect(screen.queryByText(/AI 正在回复/)).toBeNull();
  });

  it('keeps cloud conversation sending unavailable without a configured model', async () => {
    record = { ...record, kind: 'conversation' };
    await ready('conversation', { ...aiHealth, executorAvailable: false });
    fireEvent.click(screen.getByRole('button', { name: /项目讨论/ }));
    await waitFor(() => expect(screen.getByLabelText('标题')).toHaveValue('项目讨论'));
    expect(screen.getByLabelText('消息')).toBeDisabled();
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
    expect(screen.getByText(/尚未配置可用的 AI/)).toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it('cancels kind changes without losing the draft', async () => {
    await ready();
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Draft' } });
    fireEvent.change(screen.getByLabelText('记录类型'), { target: { value: 'workflow' } });
    fireEvent.click(screen.getByRole('button', { name: '返回编辑' }));
    expect(screen.getByLabelText('标题')).toHaveValue('Draft');
    expect(screen.getByLabelText('记录类型')).toHaveValue('business');
    fireEvent.change(screen.getByLabelText('记录类型'), { target: { value: 'workflow' } });
    fireEvent.click(screen.getByRole('button', { name: '放弃更改' }));
    expect(screen.getByLabelText('标题')).toHaveValue('');
    expect(screen.getByLabelText('记录类型')).toHaveValue('workflow');
    expect(writes).toHaveLength(0);
  });
});
