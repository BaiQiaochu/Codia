import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { gsapFetch } from '../api';
import { SettingsButton } from '../components/SettingsButton';
import { useSettingsStore } from '../store';
import styles from '../Settings.module.css';
import { settingsCopy } from './settings-copy';

type CheckState = 'ok' | 'warn' | 'error' | 'loading';

interface DiagnosticCheck {
  id: string;
  title: string;
  status: CheckState;
  detail: string;
  suggestion?: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}

interface DiagnosticGroup {
  id: string;
  title: string;
  checks: DiagnosticCheck[];
}

interface ModelsPayload {
  models?: Array<{
    id: string;
    name?: string;
    provider?: string;
    isCurrent?: boolean;
    input?: ('text' | 'image' | 'video' | 'audio')[];
    vision?: boolean;
    reasoning?: boolean;
  }>;
  activeModel?: { id?: string; provider?: string } | null;
}

interface ModelRoutingPayload {
  routes?: Array<{
    slot?: string;
    status?: string;
    id?: string;
    provider?: string;
    api?: string;
    endpointKind?: string;
    baseHost?: string;
    input?: string[];
    imageTransport?: string;
    fallbackPath?: string[];
    trace?: string[];
    candidates?: Array<{
      ref?: string;
      status?: string;
      reason?: string;
      requiredCapability?: string;
    }>;
    error?: string;
  }>;
}

interface OpsOverviewPayload {
  generatedAt?: string;
  modules?: Array<{
    id: string;
    title: string;
    status?: string;
    description?: string;
    items?: Array<{
      id: string;
      label: string;
      value?: string;
      detail?: string;
      status?: string;
      providerId?: string;
      testModelId?: string;
      actionTab?: string;
    }>;
    checks?: Array<{
      id: string;
      label: string;
      detail?: string;
      status?: string;
    }>;
  }>;
}

interface SystemHealthPayload {
  localHealth?: {
    available?: boolean;
    ok?: boolean;
    finishedAt?: string;
    checks?: { total?: number; failed?: number };
  };
  plugins?: { summary?: { total?: number; ok?: number; warn?: number; error?: number } };
  tasks?: { total?: number; aborted?: number; schedules?: number };
  deferred?: { total?: number; pending?: number; failed?: number; aborted?: number; undelivered?: number };
  recovery?: { attention?: number; failed?: number; aborted?: number; undelivered?: number };
  media?: {
    byType?: Record<string, { models?: number; providers?: number }>;
    providers?: Array<{ id?: string; name?: string }>;
  };
}

interface LongTaskRecoveryPayload {
  summary?: { attention?: number; failed?: number; aborted?: number; undelivered?: number };
  items?: Array<{
    source?: string;
    taskId?: string;
    type?: string;
    status?: string;
    sessionPath?: string;
    parentSessionPath?: string;
    failureReason?: string;
    retrySupported?: boolean;
  }>;
}

interface RuntimeDiagnosticRecord {
  id: string;
  timestamp?: string;
  severity?: string;
  category?: string;
  title: string;
  detail?: string;
  traceId?: string;
  sessionPath?: string;
  agentId?: string;
  model?: { provider?: string; id?: string; name?: string };
  tool?: { name?: string; category?: string };
  media?: { kind?: string; provider?: string; model?: string };
}

interface RuntimeDiagnosticsPayload {
  records?: RuntimeDiagnosticRecord[];
}

function normalizeCheckState(status?: string | null): CheckState {
  if (status === 'ok' || status === 'warn' || status === 'error' || status === 'loading') return status;
  if (status === 'failed') return 'error';
  if (status === 'running' || status === 'pending') return 'loading';
  return 'warn';
}

function statusLabel(status: CheckState): string {
  if (status === 'ok') return settingsCopy('diagnostics.status.ok');
  if (status === 'warn') return settingsCopy('diagnostics.status.warn');
  if (status === 'loading') return settingsCopy('diagnostics.status.loading');
  return settingsCopy('diagnostics.status.error');
}

function statusStyle(status: CheckState): React.CSSProperties {
  if (status === 'ok') return { color: 'var(--success)', background: 'color-mix(in srgb, var(--success) 12%, transparent)' };
  if (status === 'warn') return { color: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 12%, transparent)' };
  if (status === 'loading') return { color: 'var(--text-muted)', background: 'var(--overlay-light)' };
  return { color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 12%, transparent)' };
}

function worstStatus(statuses: CheckState[]): CheckState {
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warn')) return 'warn';
  if (statuses.includes('loading')) return 'loading';
  return 'ok';
}

async function safeJson<T>(promise: Promise<Response>, fallback: T): Promise<T> {
  try {
    const res = await promise;
    return await res.json() as T;
  } catch {
    return fallback;
  }
}

function buildReport(groups: DiagnosticGroup[], lastRun: string): string {
  const lines = [
    settingsCopy('diagnostics.reportTitle'),
    settingsCopy('diagnostics.reportGeneratedAt', { value: new Date().toISOString() }),
    lastRun ? settingsCopy('diagnostics.reportLastRun', { value: lastRun }) : '',
    '',
  ].filter(Boolean);

  for (const group of groups) {
    lines.push(`## ${group.title}`);
    for (const check of group.checks) {
      lines.push(`- [${statusLabel(check.status)}] ${check.title}: ${check.detail}`);
      if (check.suggestion && check.status !== 'ok') {
        lines.push(`  ${settingsCopy('diagnostics.reportSuggestion', { value: check.suggestion })}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  // eslint-disable-next-line no-restricted-syntax -- export requires a temporary download anchor.
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function captureUiSnapshot() {
  return {
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
    location: window.location.href,
    title: document.title,
    activeElement: document.activeElement?.tagName || null,
  };
}

function captureDocumentPng(): Promise<{ mimeType: string; base64: string } | null> {
  return Promise.resolve(null);
}

function compactPath(value?: string | null): string {
  if (!value) return '-';
  return value.split(/[\\/]/).pop() || value;
}

function runtimeRecordStatus(record: RuntimeDiagnosticRecord): CheckState {
  if (record.severity === 'error') return 'error';
  if (record.severity === 'warn') return 'warn';
  return 'ok';
}

function runtimeRecordDetail(record: RuntimeDiagnosticRecord): string {
  const model = record.model?.provider || record.model?.id
    ? `${record.model?.provider || '-'}/${record.model?.id || record.model?.name || '-'}`
    : '';
  const tool = record.tool?.name ? `tool: ${record.tool.name}` : '';
  const trace = record.traceId ? `trace: ${record.traceId}` : '';
  const session = record.sessionPath ? `session: ${compactPath(record.sessionPath)}` : '';
  return [record.detail, trace, model, tool, session].filter(Boolean).join(' | ');
}

function buildSystemChecks(payload: SystemHealthPayload): DiagnosticCheck[] {
  const local = payload.localHealth || {};
  const pluginSummary = payload.plugins?.summary || {};
  const tasks = payload.tasks || {};
  const deferred = payload.deferred || {};
  const recovery = payload.recovery || {};

  return [
    {
      id: 'local-health',
      title: settingsCopy('diagnostics.system.localHealth'),
      status: local.available === false ? 'warn' : local.ok === false ? 'error' : 'ok',
      detail: local.available === false
        ? settingsCopy('diagnostics.system.localHealthUnavailable')
        : settingsCopy('diagnostics.system.localHealthDetail', {
            total: local.checks?.total ?? 0,
            failed: local.checks?.failed ?? 0,
            finishedAt: local.finishedAt || '-',
          }),
      suggestion: local.available === false || local.ok === false
        ? settingsCopy('diagnostics.system.localHealthSuggestion')
        : undefined,
    },
    {
      id: 'plugin-summary',
      title: settingsCopy('diagnostics.system.pluginSummary'),
      status: (pluginSummary.error ?? 0) > 0 ? 'error' : (pluginSummary.warn ?? 0) > 0 ? 'warn' : 'ok',
      detail: settingsCopy('diagnostics.system.pluginSummaryDetail', {
        total: pluginSummary.total ?? 0,
        ok: pluginSummary.ok ?? 0,
        warn: pluginSummary.warn ?? 0,
        error: pluginSummary.error ?? 0,
      }),
    },
    {
      id: 'background-tasks',
      title: settingsCopy('diagnostics.system.backgroundTasks'),
      status: (tasks.aborted ?? 0) > 0 ? 'warn' : 'ok',
      detail: settingsCopy('diagnostics.system.backgroundTaskDetail', {
        total: tasks.total ?? 0,
        aborted: tasks.aborted ?? 0,
        schedules: tasks.schedules ?? 0,
      }),
      suggestion: (tasks.aborted ?? 0) > 0 ? settingsCopy('diagnostics.system.backgroundTaskSuggestion') : undefined,
    },
    {
      id: 'deferred-tasks',
      title: settingsCopy('diagnostics.system.deferredTasks'),
      status: ((deferred.failed ?? 0) + (deferred.aborted ?? 0)) > 0 ? 'warn' : 'ok',
      detail: settingsCopy('diagnostics.system.deferredTaskDetail', {
        total: deferred.total ?? 0,
        pending: deferred.pending ?? 0,
        failed: deferred.failed ?? 0,
        aborted: deferred.aborted ?? 0,
        undelivered: deferred.undelivered ?? 0,
      }),
      suggestion: (deferred.failed ?? 0) > 0 ? settingsCopy('diagnostics.system.deferredTaskSuggestion') : undefined,
    },
    {
      id: 'recovery-queue',
      title: settingsCopy('diagnostics.system.recoveryQueue'),
      status: (recovery.attention ?? 0) > 0 ? 'warn' : 'ok',
      detail: settingsCopy('diagnostics.system.recoveryQueueDetail', {
        attention: recovery.attention ?? 0,
        failed: recovery.failed ?? 0,
        aborted: recovery.aborted ?? 0,
        undelivered: recovery.undelivered ?? 0,
      }),
      suggestion: (recovery.attention ?? 0) > 0 ? settingsCopy('diagnostics.system.recoveryQueueSuggestion') : undefined,
    },
  ];
}

function buildMediaChecks(payload: SystemHealthPayload): DiagnosticCheck[] {
  const byType = payload.media?.byType || {};
  const image = byType.image?.models ?? 0;
  const audio = byType.audio?.models ?? 0;
  const music = byType.music?.models ?? 0;
  const video = byType.video?.models ?? 0;
  const providers = payload.media?.providers?.length ?? 0;

  return [
    {
      id: 'media-summary',
      title: settingsCopy('diagnostics.media.providerSummary'),
      status: image + audio + music + video > 0 ? 'ok' : 'warn',
      detail: settingsCopy('diagnostics.media.providerSummaryDetail', { image, audio, music, video, providers }),
      suggestion: image + audio + music + video > 0 ? undefined : settingsCopy('diagnostics.media.providerSummarySuggestion'),
    },
    {
      id: 'video-generation',
      title: settingsCopy('diagnostics.media.videoGeneration'),
      status: video > 0 ? 'ok' : 'warn',
      detail: settingsCopy('diagnostics.media.videoGenerationDetail'),
      suggestion: video > 0 ? undefined : settingsCopy('diagnostics.media.providerSummarySuggestion'),
    },
  ];
}

function buildModelChecks(modelsPayload: ModelsPayload, routingPayload: ModelRoutingPayload): DiagnosticCheck[] {
  const models = modelsPayload.models || [];
  const active = models.find(model => model.isCurrent)
    || models.find(model => model.id === modelsPayload.activeModel?.id && model.provider === modelsPayload.activeModel?.provider)
    || null;
  const visionCount = models.filter(model => model.vision || model.input?.includes('image')).length;
  const reasoningCount = models.filter(model => model.reasoning).length;
  const routingChecks = (routingPayload.routes || []).map((route, index): DiagnosticCheck => {
    const status = normalizeCheckState(route.status);
    const detail = route.error
      || [
        `api: ${route.api || '-'}`,
        `endpoint: ${route.endpointKind || '-'}`,
        `host: ${route.baseHost || '-'}`,
        `input: ${(route.input || ['text']).join('/')}`,
        `image: ${route.imageTransport || 'none'}`,
      ].join(' | ');
    const why = route.trace?.length ? `why: ${route.trace[0]}` : '';
    const skipped = route.candidates?.map(candidate => {
      const ref = candidate.ref || 'candidate';
      return `skipped: ${ref} ${candidate.reason || candidate.status || 'unknown'}${candidate.requiredCapability ? ` ${candidate.requiredCapability}` : ''}`;
    }).join(' | ');
    const fallback = route.fallbackPath?.length ? `fallback: ${route.fallbackPath.join(' -> ')}` : '';
    return {
      id: `route-${route.slot || index}`,
      title: `${route.slot || 'route'}: ${route.provider || '-'}/${route.id || '-'}`,
      status,
      detail: [detail, why, skipped, fallback].filter(Boolean).join(' | '),
    };
  });

  return [
    {
      id: 'active-model',
      title: settingsCopy('diagnostics.model.connectivity'),
      status: active ? 'ok' : 'warn',
      detail: active ? `${active.provider}/${active.id}` : settingsCopy('diagnostics.model.noActiveModel'),
    },
    {
      id: 'vision-models',
      title: settingsCopy('diagnostics.model.visionCapable'),
      status: visionCount > 0 ? 'ok' : 'warn',
      detail: settingsCopy('diagnostics.model.visionDetail', { count: visionCount, total: models.length }),
      suggestion: visionCount > 0 ? undefined : settingsCopy('diagnostics.model.visionSuggestion'),
    },
    {
      id: 'reasoning-models',
      title: settingsCopy('diagnostics.model.reasoningCapable'),
      status: reasoningCount > 0 ? 'ok' : 'warn',
      detail: settingsCopy('diagnostics.model.reasoningDetail', { count: reasoningCount, total: models.length }),
      suggestion: reasoningCount > 0 ? undefined : settingsCopy('diagnostics.model.reasoningSuggestion'),
    },
    ...routingChecks,
  ];
}

function buildLongTaskChecks(payload: LongTaskRecoveryPayload): DiagnosticCheck[] {
  const items = payload.items || [];
  if (items.length === 0) {
    return [{
      id: 'long-tasks-empty',
      title: settingsCopy('diagnostics.longTasks.queue'),
      status: 'ok',
      detail: settingsCopy('diagnostics.longTasks.empty'),
    }];
  }

  return items.map((item, index) => ({
    id: `long-task-${item.taskId || index}`,
    title: item.taskId || `${item.source || 'task'}-${index + 1}`,
    status: normalizeCheckState(item.status),
    detail: settingsCopy('diagnostics.longTasks.item', {
      status: item.status || 'unknown',
      type: item.type || item.source || 'task',
      session: compactPath(item.parentSessionPath || item.sessionPath),
    }),
    suggestion: item.failureReason || (!item.retrySupported ? settingsCopy('diagnostics.longTasks.retryUnsupported') : undefined),
  } satisfies DiagnosticCheck));
}

function buildBridgeChecks(payload: Record<string, { configured?: boolean; status?: string; error?: string | null } | undefined>): DiagnosticCheck[] {
  const platforms = ['wechat', 'feishu', 'qq', 'whatsapp', 'telegram'] as const;
  return platforms.map((platform) => {
    const item = payload[platform] || {};
    const configured = item.configured === true;
    const connected = item.status === 'connected' || item.status === 'authenticated';
    return {
      id: `bridge-${platform}`,
      title: settingsCopy(`diagnostics.bridge.${platform}`),
      status: !configured ? 'warn' : connected ? 'ok' : 'warn',
      detail: configured
        ? settingsCopy('diagnostics.bridge.configuredStatus', { status: item.status || 'unknown' })
        : settingsCopy('diagnostics.bridge.notConfigured'),
      suggestion: item.error || (!configured
        ? settingsCopy('diagnostics.bridge.configureSuggestion', { platform })
        : connected ? undefined : settingsCopy('diagnostics.bridge.reconnectSuggestion', { platform })),
    } satisfies DiagnosticCheck;
  });
}

export function DiagnosticsTab() {
  const { showToast, getSettingsAgentId, set } = useSettingsStore();
  const [groups, setGroups] = useState<DiagnosticGroup[]>([]);
  const [opsOverview, setOpsOverview] = useState<OpsOverviewPayload | null>(null);
  const [runtimeRecords, setRuntimeRecords] = useState<RuntimeDiagnosticRecord[]>([]);
  const [view, setView] = useState<'overview' | 'runtime'>('overview');
  const [loading, setLoading] = useState(false);
  const [diagnosticPackageLoading, setDiagnosticPackageLoading] = useState(false);
  const [lastRun, setLastRun] = useState('');

  const opsOverviewStatus = useMemo(() => {
    const statuses = (opsOverview?.modules || []).map(module => normalizeCheckState(module.status));
    return statuses.length ? worstStatus(statuses) : 'warn';
  }, [opsOverview]);

  const copyReport = useCallback(async () => {
    await navigator.clipboard.writeText(buildReport(groups, lastRun));
    showToast(settingsCopy('diagnostics.copySuccess'), 'success');
  }, [groups, lastRun, showToast]);

  const exportJson = useCallback(() => {
    downloadJson(`gsap-diagnostics-${Date.now()}.json`, {
      generatedAt: new Date().toISOString(),
      lastRun,
      groups,
      runtimeRecords,
    });
    showToast(settingsCopy('diagnostics.exportSuccess'), 'success');
  }, [groups, lastRun, runtimeRecords, showToast]);

  const exportDiagnosticPackage = useCallback(async () => {
    setDiagnosticPackageLoading(true);
    try {
      const [uiSnapshot, uiScreenshot] = await Promise.all([
        captureUiSnapshot(),
        captureDocumentPng(),
      ]);
      const res = await gsapFetch('/api/system/diagnostic-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uiSnapshot,
          uiScreenshot,
          lastRun,
          groups,
          runtimeRecords: runtimeRecords
            .filter(record => record.severity === 'error' || record.severity === 'warn')
            .slice(0, 50),
        }),
        timeout: 12_000,
      });
      const data = await res.json();
      if (data.error) throw new Error(String(data.error));
      downloadJson(`gsap-diagnostic-package-${Date.now()}.json`, data);
      showToast(settingsCopy('diagnostics.opsOverview.packageExported'), 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(settingsCopy('diagnostics.opsOverview.packageExportFailed', { message }), 'error');
    } finally {
      setDiagnosticPackageLoading(false);
    }
  }, [groups, lastRun, runtimeRecords, showToast]);

  const testProviderModel = useCallback(async (item: NonNullable<NonNullable<OpsOverviewPayload['modules']>[number]['items']>[number]) => {
    if (!item.providerId) return;
    try {
      const res = await gsapFetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: item.providerId, modelId: item.testModelId || null }),
      });
      const data = await res.json();
      showToast(data?.ok ? 'Provider test passed' : `Provider test failed: ${data?.error || 'unknown error'}`, data?.ok ? 'success' : 'error');
    } catch (err: unknown) {
      showToast(`Provider test failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [showToast]);

  const runDiagnostics = useCallback(async () => {
    setLoading(true);
    try {
      const [
        systemHealth,
        opsPayload,
        longTasks,
        runtimePayload,
        modelsPayload,
        routingPayload,
        bridgePayload,
        agentConfig,
      ] = await Promise.all([
        safeJson<SystemHealthPayload>(gsapFetch('/api/system/health', { timeout: 8_000 }), {}),
        safeJson<OpsOverviewPayload>(gsapFetch('/api/system/ops-overview', { timeout: 8_000 }), {}),
        safeJson<LongTaskRecoveryPayload>(gsapFetch('/api/system/task-recovery', { timeout: 8_000 }), {}),
        safeJson<RuntimeDiagnosticsPayload>(gsapFetch('/api/diagnostics/runtime', { timeout: 8_000 }), {}),
        safeJson<ModelsPayload>(gsapFetch('/api/models'), { models: [] }),
        safeJson<ModelRoutingPayload>(gsapFetch('/api/models/routing', { timeout: 8_000 }), {}),
        safeJson<Record<string, { configured?: boolean; status?: string; error?: string | null }>>(gsapFetch('/api/bridge/status', { timeout: 8_000 }), {}),
        safeJson<{ availableTools?: string[] }>(
          gsapFetch(`/api/agents/${encodeURIComponent(getSettingsAgentId?.() || 'default')}/config`, { timeout: 8_000 }),
          {},
        ),
      ]);

      setOpsOverview(opsPayload);
      setRuntimeRecords(runtimePayload.records || []);
      setGroups([
        {
          id: 'system',
          title: settingsCopy('diagnostics.groups.system'),
          checks: buildSystemChecks(systemHealth),
        },
        {
          id: 'models',
          title: settingsCopy('diagnostics.groups.models'),
          checks: buildModelChecks(modelsPayload, routingPayload),
        },
        {
          id: 'media',
          title: settingsCopy('diagnostics.groups.media'),
          checks: buildMediaChecks(systemHealth),
        },
        {
          id: 'long-tasks',
          title: settingsCopy('diagnostics.groups.longTasks'),
          checks: buildLongTaskChecks(longTasks),
        },
        {
          id: 'agent',
          title: settingsCopy('diagnostics.groups.agent'),
          checks: [{
            id: 'hermes-agent',
            title: settingsCopy('diagnostics.agent.hermes'),
            status: agentConfig.availableTools?.includes('hermes_agent') ? 'ok' : 'warn',
            detail: agentConfig.availableTools?.includes('hermes_agent')
              ? settingsCopy('diagnostics.agent.hermesFound')
              : settingsCopy('diagnostics.agent.hermesMissing'),
            suggestion: agentConfig.availableTools?.includes('hermes_agent') ? undefined : settingsCopy('diagnostics.agent.hermesSuggestion'),
          }],
        },
        {
          id: 'bridge',
          title: settingsCopy('diagnostics.groups.bridge'),
          checks: buildBridgeChecks(bridgePayload),
        },
      ]);
      setLastRun(new Date().toLocaleString());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(settingsCopy('diagnostics.failed', { message }), 'error');
    } finally {
      setLoading(false);
    }
  }, [getSettingsAgentId, showToast]);

  useEffect(() => {
    void runDiagnostics();
  }, [runDiagnostics]);

  return (
    <div className={`${styles['settings-tab-content']} ${styles.active}`} data-tab="diagnostics">
      <section className={styles['settings-section']}>
        <div className={styles['settings-section-header']}>
          <h2 className={styles['settings-section-title']}>{settingsCopy('diagnostics.title')}</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <SettingsButton variant="secondary" onClick={() => setView('overview')}>
              {settingsCopy('diagnostics.opsOverview.overview')}
            </SettingsButton>
            <SettingsButton variant="secondary" onClick={() => setView('runtime')}>
              {settingsCopy('diagnostics.opsOverview.runtimeRecords')}
            </SettingsButton>
            <SettingsButton variant="secondary" onClick={copyReport} disabled={loading || groups.length === 0}>
              {settingsCopy('diagnostics.copyReport')}
            </SettingsButton>
            <SettingsButton variant="secondary" onClick={exportJson} disabled={loading || groups.length === 0}>
              {settingsCopy('diagnostics.exportJson')}
            </SettingsButton>
            <SettingsButton variant="secondary" onClick={exportDiagnosticPackage} disabled={diagnosticPackageLoading}>
              {diagnosticPackageLoading
                ? settingsCopy('diagnostics.opsOverview.exporting')
                : settingsCopy('diagnostics.opsOverview.diagnosticPackage')}
            </SettingsButton>
            <SettingsButton variant="secondary" onClick={runDiagnostics} disabled={loading}>
              {loading ? settingsCopy('diagnostics.running') : settingsCopy('diagnostics.run')}
            </SettingsButton>
          </div>
        </div>

        <p className={styles['settings-desc']}>
          {settingsCopy('diagnostics.intro')}
          {lastRun ? ` ${settingsCopy('diagnostics.lastRun', { time: lastRun })}` : ''}
        </p>

        {view === 'overview' && (
          <>
            {Array.isArray(opsOverview?.modules) && opsOverview.modules.length > 0 && (
              <div
                className={styles['ops-overview']}
                aria-label={settingsCopy('diagnostics.opsOverview.title')}
              >
                <div className={styles['ops-overview-header']}>
                  <div>
                    <div className={styles['pv-list-section-title']}>
                      {settingsCopy('diagnostics.opsOverview.title')}
                    </div>
                    <div className={styles['ops-overview-meta']}>
                      {opsOverview.generatedAt
                        ? `${settingsCopy('diagnostics.opsOverview.lastSync')}: ${new Date(opsOverview.generatedAt).toLocaleString()}`
                        : settingsCopy('diagnostics.opsOverview.waiting')}
                    </div>
                  </div>
                  <span className={styles['oauth-status-badge']} style={statusStyle(opsOverviewStatus)}>
                    {statusLabel(opsOverviewStatus)}
                  </span>
                </div>
                <div className={styles['ops-overview-grid']}>
                  {opsOverview.modules.map((module) => {
                    const moduleStatus = normalizeCheckState(module.status);
                    const rows: Array<{
                      id: string;
                      label: string;
                      value?: string;
                      detail?: string;
                      status?: string;
                      providerId?: string;
                      testModelId?: string;
                      actionTab?: string;
                    }> = Array.isArray(module.items) && module.items.length > 0
                      ? module.items
                      : (module.checks || []).map(item => ({ ...item, value: item.detail }));
                    return (
                      <article className={styles['ops-overview-card']} data-status={moduleStatus} key={module.id}>
                        <div className={styles['ops-overview-card-head']}>
                          <h3>{module.title}</h3>
                          <span className={styles['oauth-status-badge']} style={statusStyle(moduleStatus)}>
                            {statusLabel(moduleStatus)}
                          </span>
                        </div>
                        {module.description && <p className={styles['ops-overview-desc']}>{module.description}</p>}
                        <div className={styles['ops-overview-items']}>
                          {rows.slice(0, 5).map((item) => {
                            const itemStatus = normalizeCheckState(item.status);
                            return (
                              <div className={styles['ops-overview-item']} data-status={itemStatus} key={item.id}>
                                <div className={styles['ops-overview-item-main']}>
                                  <span className={styles['ops-overview-item-label']}>{item.label}</span>
                                  <span className={styles['ops-overview-item-value']}>{item.value || item.detail || '-'}</span>
                                </div>
                                {'providerId' in item && item.providerId && (
                                  <button
                                    className={styles['ops-overview-action']}
                                    type="button"
                                    onClick={() => { void testProviderModel(item); }}
                                  >
                                    {settingsCopy('diagnostics.opsOverview.testModel')}
                                  </button>
                                )}
                                {'actionTab' in item && item.actionTab && (
                                  <button
                                    className={styles['ops-overview-action']}
                                    type="button"
                                    onClick={() => set({ activeTab: item.actionTab })}
                                  >
                                    {settingsCopy('diagnostics.opsOverview.open')}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            )}

            {groups.map((group) => (
              <div key={group.id} className={styles['skills-list-block']} style={{ marginBottom: 14 }}>
                <div className={styles['pv-list-section-title']} style={{ marginBottom: 8 }}>{group.title}</div>
                {group.checks.map((check) => (
                  <div className={styles['skills-list-item']} key={check.id}>
                    <div className={styles['skills-list-info']}>
                      <span className={styles['skills-list-name']}>{check.title}</span>
                      <span className={styles['skills-list-desc']}>{check.detail}</span>
                      {check.status !== 'ok' && check.suggestion && (
                        <span className={styles['skills-list-desc']} style={{ color: 'var(--warning)' }}>
                          {settingsCopy('diagnostics.fixLabel', { value: check.suggestion })}
                        </span>
                      )}
                      {check.actionLabel && check.onAction && (
                        <button
                          className={styles['settings-save-btn-sm']}
                          type="button"
                          onClick={() => { void check.onAction?.(); }}
                        >
                          {check.actionLabel}
                        </button>
                      )}
                    </div>
                    <span className={styles['oauth-status-badge']} style={statusStyle(check.status)}>
                      {statusLabel(check.status)}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}

        {view === 'runtime' && (
          <div className={styles['skills-list-block']} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <div className={styles['pv-list-section-title']}>
                {settingsCopy('diagnostics.opsOverview.runtimeRecords')}
              </div>
              <SettingsButton
                variant="secondary"
                onClick={() => {
                  downloadJson(`gsap-runtime-records-${Date.now()}.json`, {
                    generatedAt: new Date().toISOString(),
                    records: runtimeRecords,
                  });
                  showToast(settingsCopy('diagnostics.exportSuccess'), 'success');
                }}
                disabled={runtimeRecords.length === 0}
              >
                {settingsCopy('diagnostics.opsOverview.exportRuntimeRecords')}
              </SettingsButton>
            </div>
            {runtimeRecords.length === 0 ? (
              <div className={styles['skills-list-item']}>
                <div className={styles['skills-list-info']}>
                  <span className={styles['skills-list-name']}>No runtime records</span>
                  <span className={styles['skills-list-desc']}>No model, tool, media or plugin runtime issues were recorded recently.</span>
                </div>
                <span className={styles['oauth-status-badge']} style={statusStyle('ok')}>{statusLabel('ok')}</span>
              </div>
            ) : runtimeRecords.map((record) => (
              <div className={styles['skills-list-item']} key={record.id}>
                <div className={styles['skills-list-info']}>
                  <span className={styles['skills-list-name']}>{record.title}</span>
                  <span className={styles['skills-list-desc']}>{runtimeRecordDetail(record)}</span>
                  <span className={styles['skills-list-desc']}>
                    {[record.category, record.severity, record.timestamp].filter(Boolean).join(' | ')}
                  </span>
                </div>
                <span className={styles['oauth-status-badge']} style={statusStyle(runtimeRecordStatus(record))}>
                  {statusLabel(runtimeRecordStatus(record))}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
