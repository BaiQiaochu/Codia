/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../settings/store';

type MockResponse = { json: () => Promise<unknown> };

const codiaFetchMock = vi.fn(async (_url?: string, _opts?: RequestInit): Promise<MockResponse> => ({
  json: async () => ({ models: [] }),
}));

vi.mock('../../settings/api', () => ({
  codiaFetch: (url: string, opts?: RequestInit) => codiaFetchMock(url, opts),
  codiaUrl: (path: string) => path,
  yuanFallbackAvatar: (yuan: string) => `/fallback-${yuan}.png`,
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string, params?: Record<string, string>) => {
    const strings: Record<string, string> = {
      'settings.agent.title': '助手',
      'settings.agent.modelUnavailable': `不可用模型：${params?.model || ''}`,
      'settings.agent.modelUnavailableHint': '当前模型不在可用模型列表中，请重新选择。',
      'settings.agent.chatModel': 'Ta 的模型',
      'settings.agent.chatModelHint': 'Ta 在对话与工作中使用的模型',
      'settings.agent.agentNameHint': 'Ta 叫什么',
      'settings.agent.changeAvatar': '更换',
      'settings.agent.setActive': '设为当前助手',
      'settings.agent.setPrimary': '设为主助手',
      'settings.agent.deleteBtn': '删除助手',
      'settings.agent.yuanHint': '选择助手的先天思维方式',
      'settings.about.title': '关于 Ta',
      'settings.agent.identity': '身份',
      'settings.agent.identityHint': '身份说明',
      'settings.agent.ishiki': '意识',
      'settings.agent.ishikiHint': '意识说明',
      'settings.save': '保存',
      'settings.api.selectModel': '选择模型',
      'settings.experience.title': '经验',
      'settings.experience.toggleLabel': '启用经验',
      'settings.experience.toggleHint': '允许助手沉淀经验',
      'settings.experience.paused': '经验已暂停',
      'settings.experience.empty': '暂无经验',
    };
    return strings[key] || key;
  },
  autoSaveConfig: vi.fn(async () => true),
}));

vi.mock('../../settings/actions', () => ({
  browseAgent: vi.fn(),
  setPrimaryAgent: vi.fn(),
  loadSettingsConfig: vi.fn(async () => {}),
  loadAgents: vi.fn(async () => {}),
}));

vi.mock('../../settings/tabs/agent/YuanSelector', () => ({
  YuanSelector: () => <div data-testid="yuan-selector" />,
}));

vi.mock('../../settings/tabs/agent/AgentMemory', () => ({
  MemorySection: () => <div data-testid="agent-memory" />,
}));

vi.mock('../../settings/tabs/agent/AgentToolsSection', () => ({
  AgentToolsSection: () => <div data-testid="agent-tools" />,
}));

vi.mock('../../settings/tabs/agent/AgentExperience', () => ({
  parseExperience: () => [],
  ExperienceBlock: () => null,
  putExperience: vi.fn(),
}));

describe('AgentTab assistant options', () => {
  beforeEach(() => {
    codiaFetchMock.mockImplementation(async (url: string): Promise<MockResponse> => {
      if (url === '/api/models') return { json: async () => ({ models: [] }) };
      return { json: async () => ({ ok: true }) };
    });
    (window as unknown as { platform?: unknown }).platform = {};
    useSettingsStore.setState({
      agents: [
        { id: 'agent-a', name: 'Codia Writer', yuan: 'codia', isPrimary: true },
        { id: 'agent-b', name: 'Review Partner', yuan: 'logic', isPrimary: false },
      ],
      currentAgentId: null,
      settingsAgentId: null,
      settingsConfig: {
        agent: { name: 'Codia Writer', yuan: 'codia' },
        models: { chat: { provider: 'legacy', id: 'writer-chat' } },
        memory: { enabled: true },
      },
      currentPins: [],
      globalModelsConfig: { models: { utility: { id: 'u' }, utility_large: { id: 'ul' } } },
      showToast: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    document.body.innerHTML = '';
    delete (window as unknown as { platform?: unknown }).platform;
  });

  it('shows the primary assistant controls when current agent state is still resolving', async () => {
    const { AgentTab } = await import('../../settings/tabs/AgentTab');
    const { container } = render(<AgentTab />);

    expect(screen.getByText('Codia Writer')).toBeInTheDocument();
    expect(screen.getByText('Review Partner')).toBeInTheDocument();
    expect(container.querySelector('[data-add-btn="1"]')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '导出助手' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除助手' })).not.toBeInTheDocument();

    await waitFor(() => expect(codiaFetchMock.mock.calls.some(([url]) => url === '/api/models')).toBe(true));
    expect(screen.getByText('不可用模型：legacy/writer-chat')).toBeInTheDocument();
    expect(screen.getByText('当前模型不在可用模型列表中，请重新选择。')).toBeInTheDocument();
  });
});
