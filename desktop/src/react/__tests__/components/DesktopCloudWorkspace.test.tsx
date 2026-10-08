// @vitest-environment jsdom
import React from 'react';
import fs from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopCloudClient } from '../../components/DesktopCloudWorkspace';
import { AIUnavailableNotice } from '../../components/AIUnavailableNotice';
import { createLocalServerConnection } from '../../services/server-connection';
import { normalizeSavedTab } from '../../utils/saved-tab';
import { useStore } from '../../stores';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('desktop cloud workspace', () => {
  it('uses the actual authorized server for requests, retaining JSON and CSRF headers', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init: RequestInit) => new Response(JSON.stringify({ workspace: { id: 'one' } })));
    vi.stubGlobal('fetch', fetch);
    const connection = createLocalServerConnection({ serverPort: 14500, serverToken: 'existing-secret' })!;
    const client = createDesktopCloudClient(connection);
    await client.json('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Files' }) });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:14500/api/cloud/workspaces', expect.anything());
    const headers = new Headers(fetch.mock.calls[0][1].headers);
    expect(headers.get('Authorization')).toBe('Bearer existing-secret');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Requested-With')).toBe('cloud-studio');
    expect(client.contentUrl('version 1', true)).toBe('http://127.0.0.1:14500/api/cloud/versions/version%201/content?download=1');
    expect(client.contentUrl('version 1', true)).not.toContain('existing-secret');
    await client.content('version 1');
    expect(fetch).toHaveBeenLastCalledWith('http://127.0.0.1:14500/api/cloud/versions/version%201/content', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer existing-secret' }) }));
  });

  it('downloads through authenticated fetch without navigating to credential-bearing URLs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('real bytes')));
    const createObjectURL = vi.fn(() => 'blob:test-download');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const client = createDesktopCloudClient(createLocalServerConnection({ serverPort: 14500, serverToken: 'existing-secret' })!);
    await client.download!('immutable-version', 'output.txt');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a')).toBeNull();
  });

  it('registers the main desktop page and restores cloud navigation across restart', () => {
    const source = fs.readFileSync('desktop/src/react/App.tsx', 'utf8');
    expect(source).toContain('data-testid="desktop-cloud-nav"');
    expect(source).toContain("currentTab === 'cloud' && (");
    expect(source).toContain('<DesktopCloudWorkspace />');
    expect(normalizeSavedTab('cloud')).toBe('cloud');
  });

  it('explains unavailable chat and opens genuine provider settings', () => {
    useStore.setState({ settingsModal: { open: false, activeTab: 'agent' } });
    render(<AIUnavailableNotice />);
    expect(screen.getByRole('status').textContent).toContain('还没有可用的 AI 模型');
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '配置 AI' }));
    expect(useStore.getState().settingsModal).toMatchObject({ open: true, activeTab: 'providers' });
  });
});
