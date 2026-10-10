// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StoreState = {
  showToast: ReturnType<typeof vi.fn>;
  getSettingsAgentId: () => string | null;
};

let storeState: StoreState;
const codiaFetchMock = vi.fn();

const useSettingsStoreMock = Object.assign(
  () => storeState,
  {
    getState: () => storeState,
  },
);

vi.mock('../../settings/store', () => ({
  useSettingsStore: useSettingsStoreMock,
}));

vi.mock('../../settings/api', () => ({
  codiaFetch: (...args: unknown[]) => codiaFetchMock(...args),
}));

describe('DiagnosticsTab', () => {
  beforeEach(() => {
    localStorage.clear();
    window.matchMedia = vi.fn(() => ({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as never;

    storeState = {
      showToast: vi.fn(),
      getSettingsAgentId: () => 'agent-1',
    };

    window.platform = {
      getRuntimeDiagnosticsState: vi.fn(async () => ({
        currentSessionPath: 'E:/sessions/session-1.jsonl',
        pendingNewSession: false,
        modelSwitching: false,
        currentSessionModel: {
          id: 'vision-model',
          name: 'Vision Model',
          provider: 'openai',
        },
      })),
    } as never;

    window.i18n = {
      locale: 'zh-CN',
      defaultName: '助手',
      _data: {},
      _agentOverrides: {},
      load: vi.fn(async () => {}),
      setAgentOverrides: vi.fn(),
      t: vi.fn((key: string) => key),
    };

    codiaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/models') {
        return {
          json: async () => ({
            activeModel: { id: 'vision-model', provider: 'openai' },
            models: [
              { id: 'vision-model', name: 'Vision Model', provider: 'openai', vision: true, reasoning: true, isCurrent: true },
              { id: 'text-model', name: 'Text Model', provider: 'openai', vision: false, reasoning: false },
            ],
          }),
        };
      }
      if (url === '/api/system/health') {
        return {
          json: async () => ({
            generatedAt: '2026-05-16T01:00:00.000Z',
            localHealth: {
              available: true,
              ok: true,
              finishedAt: '2026-05-16T00:59:00.000Z',
              checks: { total: 8, failed: 0 },
            },
            plugins: {
              summary: { total: 1, ok: 1, warn: 0, error: 0 },
            },
            tasks: {
              total: 2,
              aborted: 1,
              schedules: 1,
            },
            deferred: {
              total: 3,
              pending: 1,
              resolved: 1,
              failed: 1,
              aborted: 0,
              delivered: 1,
              undelivered: 1,
            },
            recovery: { attention: 1, failed: 1, aborted: 0, undelivered: 1 },
            media: {
              byType: {
                image: { models: 1, providers: 1 },
                audio: { models: 0, providers: 0 },
                music: { models: 0, providers: 0 },
                video: { models: 1, providers: 1 },
              },
              providers: [{ id: 'openai', name: 'OpenAI' }],
            },
          }),
        };
      }
      if (url === '/api/system/ops-overview') {
        return {
          json: async () => ({
            schemaVersion: 1,
            generatedAt: '2026-05-16T01:00:00.000Z',
            modules: [
              {
                id: 'system-health-center',
                title: '系统健康中心',
                status: 'ok',
                description: '授权、插件、媒体、模型、任务和源树检查的运行状态。',
                items: [
                  { id: 'local-health', label: '本地健康检查', value: '0/8 failed', status: 'ok', detail: 'ready' },
                ],
              },
              {
                id: 'provider-debugger',
                title: 'Provider 调试器',
                status: 'warn',
                description: '只显示密钥来源和模型能力，不暴露真实 API Key。',
                items: [
                  { id: 'provider-openai', label: 'OpenAI', value: 'runtime secret; 2 models', status: 'ok', detail: 'chat 1, image 1', providerId: 'openai', testModelId: 'chat' },
                  { id: 'provider-empty', label: 'Empty', value: 'missing; 0 models', status: 'error', detail: 'chat 0' },
                ],
              },
              {
                id: 'workflow-audit',
                title: '工作流执行审计',
                status: 'ok',
                description: '汇总工作流、子助手和可恢复任务的执行状态。',
                items: [
                  { id: 'workflow-running', label: '运行中', value: '1', status: 'ok', detail: '' },
                ],
              },
              {
                id: 'release-preflight',
                title: '发布前检查面板',
                status: 'ok',
                description: '展示最近一次安全检查结果，不自动打包、不自动提交。',
                checks: [
                  { id: 'typecheck', label: 'typecheck', status: 'ok', detail: '100ms' },
                  { id: 'lint-quiet', label: 'lint --quiet', status: 'ok', detail: '80ms' },
                ],
                items: [
                  { id: 'typecheck', label: 'typecheck', value: '100ms', status: 'ok', detail: '' },
                ],
              },
            ],
          }),
        };
      }
      if (url === '/api/system/task-recovery') {
        return {
          json: async () => ({
            summary: { attention: 1, failed: 1, aborted: 0, undelivered: 1 },
            items: [
              {
                source: 'deferred-result',
                taskId: 'task-1',
                type: 'image',
                status: 'failed',
                sessionPath: 'E:/sessions/session-1.jsonl',
                failureReason: 'boom',
                retrySupported: false,
              },
            ],
          }),
        };
      }
      if (url === '/api/diagnostics/runtime') {
        return {
          json: async () => ({
            ok: true,
            records: [
              {
                id: 'runtime-record-1',
                timestamp: '2026-05-21T00:00:00.000Z',
                severity: 'error',
                category: 'model',
                title: '模型调用失败，已保留诊断信息',
                detail: 'trace trace-model-1',
                traceId: 'trace-model-1',
                sessionPath: 'E:/sessions/session-1.jsonl',
                model: { provider: 'openai', id: 'vision-model' },
              },
              {
                id: 'runtime-record-2',
                timestamp: '2026-05-21T00:01:00.000Z',
                severity: 'info',
                category: 'tool',
                title: '工具调用完成',
                detail: 'read ok',
                sessionPath: 'E:/sessions/session-2.jsonl',
                agentId: 'agent-2',
                tool: { name: 'read' },
              },
            ],
            diagnostics: [],
          }),
        };
      }
      if (url === '/api/models/health') {
        return { json: async () => ({ ok: true, status: 200 }) };
      }
      if (url === '/api/providers/test') {
        return { json: async () => ({ ok: true }) };
      }
      if (url === '/api/models/routing') {
        return {
          json: async () => ({
            ok: true,
            routes: [
              {
                slot: 'active',
                id: 'vision-model',
                provider: 'openai',
                api: 'openai-responses',
                endpointKind: 'responses',
                baseHost: 'api.openai.com',
                input: ['text', 'image'],
                imageTransport: 'openai-input-image',
                videoTransport: 'none',
                thinkingFormat: null,
                reasoningProfile: null,
                roleNormalization: true,
                candidates: [
                  {
                    slot: 'active',
                    ref: 'relay/text-only',
                    status: 'rejected',
                    reason: 'missing_capability',
                    requiredCapability: 'image',
                  },
                ],
                trace: [
                  'slot active resolved from active session model',
                  'credentials resolved without exposing secrets',
                ],
              },
              {
                slot: 'utility',
                id: 'utility-model',
                provider: 'relay',
                api: 'openai-completions',
                endpointKind: 'chat-completions',
                baseHost: 'relay.example.com',
                input: ['text'],
                imageTransport: 'none',
                videoTransport: 'none',
                thinkingFormat: 'qwen',
                reasoningProfile: null,
                roleNormalization: true,
                fallbackPath: ['utility -> chat'],
                trace: [
                  'slot utility resolved from shared model preferences',
                  'thinking format selected from model capabilities',
                ],
              },
            ],
          }),
        };
      }
      if (url === '/api/plugins/health?includeHidden=1') {
        return {
          json: async () => ({
            plugins: [
              { id: 'knowledge-graph', name: 'Knowledge Graph', status: 'loaded', health: 'ok' },
            ],
          }),
        };
      }
      if (url === '/api/agents/agent-1/config') {
        return { json: async () => ({ availableTools: ['hermes_agent'] }) };
      }
      if (url === '/api/bridge/status') {
        return {
          json: async () => ({
            wechat: { configured: true, status: 'connected' },
            qq: { configured: true, status: 'connected' },
            whatsapp: { configured: true, status: 'disconnected', error: 'qr required' },
            telegram: { configured: false, status: 'disconnected' },
          }),
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {}),
      },
    });
    URL.createObjectURL = vi.fn(() => 'blob:diagnostics');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('renders operations, model, runtime and bridge diagnostics', async () => {
    const { DiagnosticsTab } = await import('../../settings/tabs/DiagnosticsTab');
    render(React.createElement(DiagnosticsTab));

    expect(await screen.findByText('运维总览')).toBeTruthy();
    expect(screen.getByText('系统健康中心')).toBeTruthy();
    expect(screen.getByText('Provider 调试器')).toBeTruthy();
    expect(screen.getByText('工作流执行审计')).toBeTruthy();
    expect(screen.getByText('发布前检查面板')).toBeTruthy();
    expect(screen.getByText((content) => content.includes('runtime secret') && content.includes('2 models'))).toBeTruthy();
    expect(screen.getByText((content) => content.includes('不自动打包'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '测试当前模型' }));
    await waitFor(() => {
      expect(codiaFetchMock).toHaveBeenCalledWith('/api/providers/test', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'openai', modelId: 'chat' }),
      }));
    });

    expect(screen.getByText('当前模型连通性')).toBeTruthy();
    expect(screen.getByText('支持图片识别的模型')).toBeTruthy();
    expect(screen.getByText('视频生成')).toBeTruthy();
    expect(screen.getByText('长任务恢复队列')).toBeTruthy();
    expect(screen.getByText('active: openai/vision-model')).toBeTruthy();
    expect(screen.getByText((content) => content.includes('responses') && content.includes('openai-input-image'))).toBeTruthy();
    expect(screen.getByText((content) => content.includes('why: slot active resolved from active session model'))).toBeTruthy();
    expect(screen.getByText((content) => content.includes('skipped: relay/text-only missing_capability'))).toBeTruthy();
    expect(screen.getByText((content) => content.includes('fallback: utility -> chat'))).toBeTruthy();
    expect(screen.getByText('Hermes Agent 工具')).toBeTruthy();
    expect(screen.getByText('微信')).toBeTruthy();
    expect(screen.getByText('QQ')).toBeTruthy();
    expect(screen.getByText('WhatsApp')).toBeTruthy();
    expect(screen.getByText('系统健康')).toBeTruthy();
    expect(screen.getByText('本地检查')).toBeTruthy();
    expect(screen.getByText('后台任务')).toBeTruthy();
    expect(screen.getByText('可恢复任务')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '复制报告' }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Codia Professional 诊断报告'));
    });

    fireEvent.click(screen.getByRole('button', { name: '导出 JSON' }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '运行记录' }));
    expect(await screen.findByText('模型调用失败，已保留诊断信息')).toBeTruthy();
    expect(screen.getByText('工具调用完成')).toBeTruthy();
    expect(screen.getByText((content) => content.includes('trace-model-1'))).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出运行记录' })).toBeTruthy();
  });
});
