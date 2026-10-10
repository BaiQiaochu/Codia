// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('knowledge graph plugin page sandbox behavior', () => {
  beforeEach(async () => {
    const { useStore } = await import('../../stores');
    useStore.setState({
      serverPort: '3210',
      serverToken: 'desktop-token',
      currentAgentId: 'agent-1',
      pluginPages: [
        {
          pluginId: 'knowledge-graph',
          title: 'Knowledge graph',
          icon: null,
          routeUrl: '/api/plugins/knowledge-graph/page',
          hostCapabilities: [],
        },
        {
          pluginId: 'chart-plugin',
          title: 'Chart',
          icon: null,
          routeUrl: '/api/plugins/chart/page',
          hostCapabilities: [],
        },
        {
          pluginId: 'mind-map',
          title: 'Mind Map',
          icon: null,
          routeUrl: '/api/plugins/mind-map/page',
          hostCapabilities: [],
        },
      ],
      pluginWidgets: [
        {
          pluginId: 'knowledge-graph',
          title: 'Knowledge graph',
          icon: null,
          routeUrl: '/api/plugins/knowledge-graph/widget',
          hostCapabilities: [],
        },
        {
          pluginId: 'chart-plugin',
          title: 'Chart',
          icon: null,
          routeUrl: '/api/plugins/chart/widget',
          hostCapabilities: [],
        },
      ],
    });
    document.documentElement.dataset.theme = 'warm-paper';
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-theme');
  });

  it('allows confirmation modals on the knowledge graph page iframe', async () => {
    const { PluginPageView } = await import('../../components/plugin/PluginPageView');
    const { container } = render(<PluginPageView pluginId="knowledge-graph" />);

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute('sandbox')).toContain('allow-modals');

    const src = iframe.getAttribute('src') || '';
    expect(src).toContain('http://127.0.0.1:3210/api/plugins/knowledge-graph/page?token=desktop-token');
    expect(src).toContain('agentId=agent-1');
    expect(src).toContain('codia-theme=warm-paper');
  });

  it('does not grant modal permission to normal plugin pages', async () => {
    const { PluginPageView } = await import('../../components/plugin/PluginPageView');
    const { container } = render(<PluginPageView pluginId="chart-plugin" />);

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-modals');
  });

  it('keeps plain plugin pages visible after the iframe compatibility timeout', async () => {
    const source = await import('../../components/plugin/PluginPageView?raw');

    expect(source.default).toContain('readyOnTimeout: true');
  });

  it('renders the localized missing-plugin fallback', async () => {
    const { PluginPageView } = await import('../../components/plugin/PluginPageView');
    const { container } = render(<PluginPageView pluginId="missing-plugin" />);

    expect(container.textContent).toContain('\u63d2\u4ef6\u672a\u627e\u5230');
  });

  it('does not contain mojibake in plugin page fallback text', async () => {
    const source = await import('../../components/plugin/PluginPageView?raw');

    expect(source.default).not.toMatch(/\u9396\u63bb|\u9354\u72b1|\u95b2\u5d8b|\u6f76\u8fab|\u93c8\ue045\u58d8/);
  });

  it('allows confirmation modals on the mind map page iframe', async () => {
    const { PluginPageView } = await import('../../components/plugin/PluginPageView');
    const { container } = render(<PluginPageView pluginId="mind-map" />);

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute('sandbox')).toContain('allow-modals');
    expect(iframe.getAttribute('src') || '').toContain('http://127.0.0.1:3210/api/plugins/mind-map/page?token=desktop-token');
  });

  it('also allows confirmation modals for knowledge graph widgets', async () => {
    const { PluginWidgetView } = await import('../../components/plugin/PluginWidgetView');
    const { container } = render(<PluginWidgetView pluginId="knowledge-graph" />);

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute('sandbox')).toContain('allow-modals');
  });
});
