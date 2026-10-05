// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/open-media-viewer', () => ({
  openMediaViewerForRef: vi.fn(),
}));

function postIframeMessage(iframe: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent('message', {
    origin: 'http://127.0.0.1:3210',
    source: iframe.contentWindow,
    data,
  }));
}

describe('PluginCardBlock knowledge graph desktop behavior', () => {
  beforeEach(async () => {
    const { useStore } = await import('../../stores');
    useStore.setState({
      serverPort: '3210',
      serverToken: 'desktop-token',
      serverConnections: {},
      activeServerConnectionId: null,
      activeServerConnection: null,
    });
    document.documentElement.dataset.theme = 'warm-paper';
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('data-theme');
  });

  it('renders knowledge graph cards with the desktop plugin route and a fixed 680px desktop height contract', async () => {
    const { PluginCardBlock } = await import('../../components/chat/PluginCardBlock');
    const { container } = render(
      <PluginCardBlock
        agentId="agent-1"
        card={{
          type: 'iframe',
          pluginId: 'knowledge-graph',
          route: '/card',
          title: 'Knowledge graph',
          description: 'Fallback text',
        }}
      />,
    );

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.contentWindow).toBeTruthy();
    expect(iframe.style.width).toBe('100%');
    expect(iframe.style.height).toBe('680px');
    expect(iframe.getAttribute('sandbox')).toContain('allow-modals');

    const src = iframe.getAttribute('src') || '';
    expect(src).toContain('http://127.0.0.1:3210/api/plugins/knowledge-graph/card?token=desktop-token');
    expect(src).toContain('agentId=agent-1');
    expect(src).toContain('gsap-theme=warm-paper');
    expect(src).toContain('gsap-css=');

    postIframeMessage(iframe, {
      type: 'resize-request',
      payload: { width: 120, height: 60 },
    });

    expect(iframe.style.width).toBe('100%');
    expect(iframe.style.height).toBe('680px');

    postIframeMessage(iframe, {
      type: 'resize-request',
      payload: { width: 1600, height: 1200 },
    });

    expect(iframe.style.width).toBe('100%');
    expect(iframe.style.height).toBe('680px');
  });

  it('keeps normal plugin cards responsive to trusted resize messages', async () => {
    const { PluginCardBlock } = await import('../../components/chat/PluginCardBlock');
    const { container } = render(
      <PluginCardBlock
        agentId="agent-1"
        card={{
          type: 'iframe',
          pluginId: 'chart-plugin',
          route: '/card',
          title: 'Chart',
          description: 'Fallback text',
        }}
      />,
    );

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe.style.width).toBe('400px');
    expect(iframe.style.height).toBe('300px');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-modals');

    postIframeMessage(iframe, {
      type: 'resize-request',
      payload: { width: 350, height: 420 },
    });

    await waitFor(() => {
      expect(iframe.style.width).toBe('350px');
      expect(iframe.style.height).toBe('420px');
    });
  });

  it('renders native chat surface plugin cards without an iframe', async () => {
    const sessionPath = '/sessions/plugin-private.jsonl';
    const { useStore } = await import('../../stores');
    useStore.setState({
      sessions: [{ path: sessionPath, agentId: 'agent-private' }] as any,
      chatSessions: {
        [sessionPath]: { items: [], hasMore: false, loadingMore: false },
      },
    } as any);

    const { PluginCardBlock } = await import('../../components/chat/PluginCardBlock');
    const { container, getByText } = render(
      <PluginCardBlock
        agentId="agent-1"
        card={{
          type: 'chat.surface',
          pluginId: 'demo',
          title: 'Private run',
          description: 'Fallback text',
          sessionId: 'sess_private',
          sessionPath,
        }}
      />,
    );

    expect(container.querySelector('iframe')).toBeNull();
    expect(getByText('Private run')).toBeTruthy();
  });

  it('renders mind map edit cards with the same wide desktop card contract', async () => {
    const { PluginCardBlock } = await import('../../components/chat/PluginCardBlock');
    const { container } = render(
      <PluginCardBlock
        agentId="agent-1"
        card={{
          type: 'iframe',
          pluginId: 'mind-map',
          route: '/card?path=C%3A%2Fwork%2Fplan.xmind',
          title: 'Mind Map',
          description: 'plan.xmind',
        }}
      />,
    );

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.style.width).toBe('100%');
    expect(iframe.style.height).toBe('680px');
    expect(iframe.getAttribute('sandbox')).toContain('allow-modals');
    expect(iframe.getAttribute('src') || '').toContain('/api/plugins/mind-map/card?path=C%3A%2Fwork%2Fplan.xmind');

    postIframeMessage(iframe, {
      type: 'resize-request',
      payload: { width: 500, height: 500 },
    });

    expect(iframe.style.width).toBe('100%');
    expect(iframe.style.height).toBe('680px');
  });

  it('widens the chat transcript for both visual plugin cards', async () => {
    const [assistantSource, areaSource, surfaceSource] = await Promise.all([
      import('../../components/chat/AssistantMessage?raw'),
      import('../../components/chat/ChatArea?raw'),
      import('../../components/chat/ChatMessageSurface?raw'),
    ]);

    for (const source of [assistantSource.default, areaSource.default, surfaceSource.default]) {
      expect(source).toContain("new Set(['knowledge-graph', 'mind-map'])");
    }
  });

  it('uses iframe tickets for remote plugin card surfaces', async () => {
    const remoteConnection = {
      connectionId: 'remote-1',
      kind: 'lan' as const,
      serverId: 'remote',
      studioId: 'studio',
      label: 'Remote G-SAP',
      baseUrl: 'http://remote.example',
      wsUrl: 'ws://remote.example',
      token: 'remote-token',
      authState: 'paired' as const,
      trustState: 'lan' as const,
      credentialKind: 'device_credential' as const,
      capabilities: ['chat'],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ticket: 'ticket-remote-card',
      expiresAt: '2026-06-05T00:00:00.000Z',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { useStore } = await import('../../stores');
    useStore.setState({
      serverPort: null,
      serverToken: null,
      serverConnections: { [remoteConnection.connectionId]: remoteConnection },
      activeServerConnectionId: remoteConnection.connectionId,
      activeServerConnection: remoteConnection,
    });

    const { PluginCardBlock } = await import('../../components/chat/PluginCardBlock');
    const { container } = render(
      <PluginCardBlock
        agentId="agent-remote"
        card={{
          type: 'iframe',
          pluginId: 'chart-plugin',
          route: '/card?view=main',
          title: 'Chart',
          description: 'Fallback text',
        }}
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://remote.example/api/plugins/iframe-ticket',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ routeUrl: '/api/plugins/chart-plugin/card?view=main' }),
        }),
      );
    });

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    await waitFor(() => {
      const src = iframe.getAttribute('src') || '';
      expect(src).toContain('http://remote.example/api/plugins/chart-plugin/card?view=main');
      expect(src).toContain('pluginIframeTicket=ticket-remote-card');
      expect(src).toContain('agentId=agent-remote');
    });
  });
});
