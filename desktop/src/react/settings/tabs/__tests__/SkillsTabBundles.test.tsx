/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../store';

type MockResponse = { json: () => Promise<unknown> };

const codiaFetchMock = vi.fn(async (_url: string, _opts?: RequestInit): Promise<MockResponse> => ({
  json: async () => ({}),
}));

vi.mock('../../api', () => ({
  codiaFetch: (url: string, opts?: RequestInit) => codiaFetchMock(url, opts),
}));

vi.mock('../../helpers', () => ({
  t: (key: string, vars?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      'settings.autoSaved': '已自动保存',
      'settings.saveFailed': '保存失败',
      'settings.skills.createBundleTitle': '新建技能包',
      'settings.skills.createBundleAriaLabel': '新建技能包',
      'settings.skills.createBundleBtn': '新建技能包',
      'settings.skills.renameBundleTitle': '重命名技能包',
      'settings.skills.renameBundleAriaLabel': '重命名 {name}',
      'settings.skills.exportBundleTitle': '导出技能包',
      'settings.skills.exportBundleAriaLabel': '导出 {name}',
      'settings.skills.dissolveBundleTitle': '打散技能包',
      'settings.skills.dissolveBundleAriaLabel': '打散 {name}',
      'settings.skills.expandBundleAriaLabel': '展开技能包',
      'settings.skills.collapseBundleAriaLabel': '收起技能包',
      'settings.skills.bundleSkillCount': '{count} 个技能',
      'settings.skills.emptyBundle': '空技能包',
      'settings.skills.skillNotFound': '这个技能已不存在',
      'settings.skills.removeFromBundleTitle': '移出技能包',
      'settings.skills.removeFromBundleAriaLabel': '将 {name} 移出技能包',
      'settings.skills.noLooseSkills': '没有散装技能',
      'settings.skills.dragToBundleTitle': '拖动到技能包',
      'settings.skills.enableSkillTitle': '启用技能',
      'settings.skills.disableSkillTitle': '关闭技能',
      'settings.skills.enableSkillAriaLabel': '启用 {name}',
      'settings.skills.disableSkillAriaLabel': '关闭 {name}',
      'settings.skills.enableBundleTitle': '启用整个技能包',
      'settings.skills.disableBundleTitle': '关闭整个技能包',
      'settings.skills.enableBundleAriaLabel': '启用 {name}',
      'settings.skills.disableBundleAriaLabel': '关闭 {name}',
      'settings.skills.bundleDialog.defaultName': '新建技能包',
      'settings.skills.bundleDialog.createTitle': '新建技能包',
      'settings.skills.bundleDialog.renameTitle': '重命名技能包',
      'settings.skills.bundleDialog.dissolveTitle': '打散技能包',
      'settings.skills.bundleDialog.closeAriaLabel': '关闭',
      'settings.skills.bundleDialog.bundleNameLabel': '技能包名称',
      'settings.skills.bundleDialog.dissolveConfirm': '打散 {name} 后，技能会保留并显示为散装技能。',
      'settings.skills.bundleDialog.cancelBtn': '取消',
      'settings.skills.bundleDialog.createBtn': '创建',
      'settings.skills.bundleDialog.saveBtn': '保存',
      'settings.skills.bundleDialog.dissolveBtn': '打散',
      'settings.skills.exported': '已导出 {fileName}',
      'settings.skills.exportedWithSkipped': '已导出 {fileName}，跳过 {count} 个缺失技能',
      'settings.skills.exportEmptyBundle': '请先添加至少一个已安装技能再导出。',
      'settings.skills.delete': '删除',
    };
    const template = translations[key] || key;
    if (!vars) return template;
    return Object.entries(vars).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      template,
    );
  },
}));

vi.mock('../skills/SkillCapabilities', () => ({
  SkillCapabilities: () => <div data-testid="skill-capabilities" />,
}));

vi.mock('../skills/CompatPathDrawer', () => ({
  CompatPathDrawer: () => <div data-testid="compat-path" />,
}));

vi.mock('../skills/LearnedSkillsBlock', () => ({
  LearnedSkillsBlock: () => <div data-testid="learned-skills" />,
}));

vi.mock('../bridge/AgentSelect', () => ({
  AgentSelect: ({ value }: { value: string | null }) => <div data-testid="agent-select">{value}</div>,
}));

describe('SkillsTab skill bundles', () => {
  beforeEach(() => {
    codiaFetchMock.mockImplementation(async (url: string, opts?: RequestInit): Promise<MockResponse> => {
      if (url.startsWith('/api/skills?')) {
        return {
          json: async () => ({
            skills: [
              { name: 'writer', description: 'Write', enabled: false, source: 'user' },
              { name: 'reader', description: 'Read', enabled: false, source: 'user' },
              { name: 'loose', description: 'Loose', enabled: true, source: 'user' },
            ],
          }),
        };
      }
      if (url.startsWith('/api/skills/bundles?')) {
        return {
          json: async () => ({
            bundles: [
              {
                id: 'writing-bundle',
                name: 'Writing bundle',
                skillNames: ['writer', 'reader'],
                skills: [
                  { name: 'writer', enabled: false, source: 'user' },
                  { name: 'reader', enabled: false, source: 'user' },
                ],
              },
            ],
          }),
        };
      }
      if (url === '/api/skills/external-paths') {
        return { json: async () => ({ configured: [], discovered: [] }) };
      }
      if (url === '/api/agents/agent-a/skills' && opts?.method === 'PUT') {
        return { json: async () => ({ ok: true }) };
      }
      if (url === '/api/skills/translate') {
        return { json: async () => ({}) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    useSettingsStore.setState({
      currentAgentId: 'agent-a',
      settingsConfig: { capabilities: { learn_skills: {} } },
      showToast: vi.fn(),
    });
    (window as unknown as { platform?: unknown }).platform = {};
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    delete (window as unknown as { platform?: unknown }).platform;
  });

  it('toggles all skills in a bundle for the selected assistant', async () => {
    const { SkillsTab } = await import('../SkillsTab');
    render(<SkillsTab />);

    fireEvent.click(await screen.findByTestId('skill-bundle-toggle-writing-bundle'));

    await waitFor(() => {
      const putCall = codiaFetchMock.mock.calls.find(([url, opts]) => (
        url === '/api/agents/agent-a/skills' && opts?.method === 'PUT'
      ));
      expect(putCall).toBeTruthy();
      expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
        enabled: ['writer', 'reader', 'loose'],
      });
    });
  });

  it('exports a skill bundle from the manage tree', async () => {
    const showInFinder = vi.fn();
    const showToast = vi.fn();
    (window as unknown as { platform?: unknown }).platform = { showInFinder };
    useSettingsStore.setState({ showToast });

    codiaFetchMock.mockImplementation(async (url: string, opts?: RequestInit): Promise<MockResponse> => {
      if (url === '/api/skills/external-paths') {
        return { json: async () => ({ configured: [], discovered: [] }) };
      }
      if (url.includes('/api/skills/bundles/writing-bundle/export')) {
        expect(opts).toMatchObject({ method: 'POST' });
        return {
          json: async () => ({
            ok: true,
            filePath: 'E:/tmp/writing-bundle-skillbundle.zip',
            fileName: 'writing-bundle-skillbundle.zip',
            warnings: [],
          }),
        };
      }
      if (url.startsWith('/api/skills/bundles?')) {
        return {
          json: async () => ({
            bundles: [
              {
                id: 'writing-bundle',
                name: 'Writing bundle',
                skillNames: ['writer', 'reader'],
                skills: [
                  { name: 'writer', enabled: false, source: 'user' },
                  { name: 'reader', enabled: false, source: 'user' },
                ],
              },
            ],
          }),
        };
      }
      if (url.startsWith('/api/skills?')) {
        return {
          json: async () => ({
            skills: [
              { name: 'writer', description: 'Write', enabled: false, source: 'user' },
              { name: 'reader', description: 'Read', enabled: false, source: 'user' },
            ],
          }),
        };
      }
      if (url === '/api/skills/translate') {
        return { json: async () => ({}) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { SkillsTab } = await import('../SkillsTab');
    render(<SkillsTab />);

    fireEvent.click(await screen.findByRole('button', { name: '导出 Writing bundle' }));

    await waitFor(() => {
      expect(codiaFetchMock).toHaveBeenCalledWith(
        '/api/skills/bundles/writing-bundle/export?agentId=agent-a',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(showInFinder).toHaveBeenCalledWith('E:/tmp/writing-bundle-skillbundle.zip');
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('writing-bundle-skillbundle.zip'),
        'success',
      );
    });
  });

  it('exports a learned-skill bundle for the selected assistant', async () => {
    const showToast = vi.fn();
    useSettingsStore.setState({ showToast });

    codiaFetchMock.mockImplementation(async (url: string, opts?: RequestInit): Promise<MockResponse> => {
      if (url === '/api/skills/external-paths') {
        return { json: async () => ({ configured: [], discovered: [] }) };
      }
      if (url === '/api/skills/bundles/learned-bundle/export?agentId=agent-a') {
        expect(opts).toMatchObject({ method: 'POST' });
        return {
          json: async () => ({
            ok: true,
            filePath: 'E:/tmp/learned-bundle-skillbundle.zip',
            fileName: 'learned-bundle-skillbundle.zip',
            warnings: [],
          }),
        };
      }
      if (url.startsWith('/api/skills/bundles?')) {
        return {
          json: async () => ({
            bundles: [
              {
                id: 'learned-bundle',
                name: 'Learned bundle',
                skillNames: ['learned-note'],
                skills: [
                  { name: 'learned-note', enabled: true, source: 'learned' },
                ],
              },
            ],
          }),
        };
      }
      if (url.startsWith('/api/skills?')) {
        return {
          json: async () => ({
            skills: [
              { name: 'learned-note', description: 'Learned', enabled: true, source: 'learned' },
            ],
          }),
        };
      }
      if (url === '/api/skills/translate') {
        return { json: async () => ({}) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { SkillsTab } = await import('../SkillsTab');
    render(<SkillsTab />);

    const [learnedHeader] = await screen.findAllByTestId('skill-bundle-header-learned-bundle');
    fireEvent.click(within(learnedHeader).getByTitle('导出技能包'));

    await waitFor(() => {
      expect(codiaFetchMock).toHaveBeenCalledWith(
        '/api/skills/bundles/learned-bundle/export?agentId=agent-a',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('learned-bundle-skillbundle.zip'),
        'success',
      );
    });
  });

  it('does not call the bundle export route for an empty skill bundle', async () => {
    const showToast = vi.fn();
    useSettingsStore.setState({ showToast });

    codiaFetchMock.mockImplementation(async (url: string): Promise<MockResponse> => {
      if (url === '/api/skills/external-paths') {
        return { json: async () => ({ configured: [], discovered: [] }) };
      }
      if (url.startsWith('/api/skills/bundles?')) {
        return {
          json: async () => ({
            bundles: [
              {
                id: 'empty-bundle',
                name: 'Empty bundle',
                skillNames: [],
                skills: [],
              },
            ],
          }),
        };
      }
      if (url.startsWith('/api/skills?')) {
        return {
          json: async () => ({
            skills: [
              { name: 'writer', description: 'Write', enabled: false, source: 'user' },
            ],
          }),
        };
      }
      if (url === '/api/skills/translate') {
        return { json: async () => ({}) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { SkillsTab } = await import('../SkillsTab');
    render(<SkillsTab />);

    fireEvent.click(await screen.findByRole('button', { name: '导出 Empty bundle' }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('请先添加至少一个已安装技能再导出。', 'error');
    });
    expect(codiaFetchMock.mock.calls.some(([url]) => String(url).includes('/export'))).toBe(false);
  });

  it('renders the bundle disband action as a visible bundle header button', async () => {
    const { SkillBundleTree } = await import('../skills/SkillBundleTree');
    const onDeleteBundle = vi.fn();
    const bundle = {
      id: 'writing-bundle',
      name: 'Writing bundle',
      skillNames: ['writer'],
    };

    render(
      <SkillBundleTree
        mode="manage"
        bundles={[bundle]}
        skills={[
          { name: 'writer', description: 'Write', enabled: true, source: 'user' },
        ]}
        nameHints={{}}
        emptyText="No skills"
        onDeleteBundle={onDeleteBundle}
      />,
    );

    const disbandButton = screen.getByTitle('打散技能包');
    expect(disbandButton).toHaveAccessibleName('打散 Writing bundle');
    expect(disbandButton.className).toContain('skill-bundle-icon-button');
    expect(disbandButton.className).not.toContain('skill-card-delete');

    fireEvent.click(disbandButton);

    expect(onDeleteBundle).toHaveBeenCalledWith(bundle);
  });

  it('shows skill bundle controls with readable Chinese labels', async () => {
    const { SkillsTab } = await import('../SkillsTab');
    render(<SkillsTab />);

    const createButton = await screen.findByRole('button', { name: '新建技能包' });
    fireEvent.click(createButton);

    expect(screen.getByRole('dialog', { name: '新建技能包' })).toBeInTheDocument();
    expect(screen.getByLabelText('技能包名称')).toHaveValue('新建技能包');
    const mojibakeText = new RegExp(
      [
        '\\u93c2\\u677f\\u7f13',
        '\\u93b6\\u20ac\\u9473',
        '\\u9359\\u6828\\u6d88',
        '\\u93b5\\u64b4\\u668e',
        '乱码',
      ].join('|'),
    );
    expect(screen.queryByText(mojibakeText)).not.toBeInTheDocument();
  });

  it('lets a loose skill be dragged onto the whole bundle body', async () => {
    const { SkillBundleTree } = await import('../skills/SkillBundleTree');
    const onMoveSkillToBundle = vi.fn();
    const bundle = {
      id: 'empty-bundle',
      name: 'Empty bundle',
      skillNames: [],
    };
    const dragData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn((type: string, value: string) => dragData.set(type, value)),
      getData: vi.fn((type: string) => dragData.get(type) || ''),
    } as unknown as DataTransfer;

    render(
      <SkillBundleTree
        mode="manage"
        bundles={[bundle]}
        skills={[
          { name: 'loose', description: 'Loose skill', enabled: true, source: 'user' },
        ]}
        nameHints={{}}
        emptyText="No skills"
        onMoveSkillToBundle={onMoveSkillToBundle}
      />,
    );

    const source = screen.getByText('loose').closest('[draggable="true"]') as HTMLElement;
    expect(screen.getByTestId('skill-drag-handle-loose')).toBeInTheDocument();
    fireEvent.dragStart(source, { dataTransfer });
    const bundleDropZone = screen.getByTestId('skill-bundle-drop-zone-empty-bundle');
    fireEvent.dragOver(bundleDropZone, { dataTransfer });
    fireEvent.drop(bundleDropZone, { dataTransfer });

    expect(onMoveSkillToBundle).toHaveBeenCalledWith('loose', bundle, undefined);
  });

  it('lets skills be organized from the agent switch list', async () => {
    const { SkillsTab } = await import('../SkillsTab');
    const dragData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn((type: string, value: string) => dragData.set(type, value)),
      getData: vi.fn((type: string) => dragData.get(type) || ''),
    } as unknown as DataTransfer;

    render(<SkillsTab />);

    const agentLooseToggle = await screen.findByRole('button', { name: '关闭 loose' });
    const agentLooseRow = agentLooseToggle.closest('[draggable="true"]') as HTMLElement;
    expect(agentLooseRow).toBeTruthy();
    expect(screen.getAllByTestId('skill-drag-handle-loose').length).toBeGreaterThanOrEqual(2);

    fireEvent.dragStart(agentLooseRow, { dataTransfer });
    const agentBundleDropZone = screen.getAllByTestId('skill-bundle-drop-zone-writing-bundle')[1];
    fireEvent.dragOver(agentBundleDropZone, { dataTransfer });
    fireEvent.drop(agentBundleDropZone, { dataTransfer });

    await waitFor(() => {
      expect(codiaFetchMock).toHaveBeenCalledWith(
        '/api/skills/bundles/writing-bundle?agentId=agent-a',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ skillNames: ['writer', 'reader', 'loose'] }),
        }),
      );
    });
  });
});
