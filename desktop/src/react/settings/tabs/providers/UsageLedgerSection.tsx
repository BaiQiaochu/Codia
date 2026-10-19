import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { UsageBudgetSettings } from './UsageBudgetSettings';
import { SettingsSection } from '../../components/SettingsSection';
import { useI18n } from '../../../hooks/use-i18n';
import styles from '../../Settings.module.css';
import { loadLlmUsageReport, type UsageCompleteness, type UsageLedgerEntry } from './usage-ledger-actions';
import { DailyBars, ModelOrbit, RequestLedger, SplitRing, UsageLegend } from './UsageLedgerCharts';
import { usageT } from './usage-ledger-i18n';
import {
  USAGE_VIEW_ORDER,
  aggregateEntries,
  categoryKey,
  categoryLabel,
  formatCompactNumber,
  formatCost,
  formatPercent,
  groupDateWindowEntries,
  groupDailyEntries,
  groupEntries,
  modelKey,
  modelLabel,
  usagePeriodDateRange,
  type UsagePeriod,
  type UsageAggregate,
  type UsageView,
} from './usage-ledger-model';

type CssVars = CSSProperties & Record<string, string | number>;

export function UsageLedgerSection() {
  const { locale } = useI18n();
  const [entries, setEntries] = useState<UsageLedgerEntry[]>([]);
  const [dateWindowEntries, setDateWindowEntries] = useState<UsageLedgerEntry[]>([]);
  const [view, setView] = useState<UsageView>('overall');
  const [period, setPeriod] = useState<UsagePeriod>('week');
  const [loading, setLoading] = useState(false);
  const refreshId = useRef(0);
  const [completeness, setCompleteness] = useState<UsageCompleteness>();
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const id = ++refreshId.current;
    setLoading(true);
    setError(null);
    try {
      const [recent, dateWindow] = await Promise.all([
        loadLlmUsageReport(500),
        loadLlmUsageReport(usagePeriodDateRange(period)),
      ]);
      if (id !== refreshId.current) return;
      setEntries(recent.entries);
      setDateWindowEntries(dateWindow.entries);
      setCompleteness(recent.completeness);
    } catch (err) {
      if (id !== refreshId.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === refreshId.current) setLoading(false);
    }
  }, [period]);

  useEffect(() => { void refresh(); return () => { refreshId.current++; }; }, [refresh]);

  const totals = useMemo(() => {
    void locale;
    return aggregateEntries('total', usageT('settings.usage.total'), entries);
  }, [entries, locale]);
  const modelGroups = useMemo(() => groupEntries(entries, modelKey, modelLabel), [entries]);
  const categoryGroups = useMemo(() => {
    void locale;
    return groupEntries(entries, categoryKey, entry => categoryLabel(entry, usageT));
  }, [entries, locale]);
  const dailyGroups = useMemo(() => {
    const groups = groupDateWindowEntries(dateWindowEntries, period);
    return groups.length > 0 ? groups : groupDailyEntries(entries);
  }, [dateWindowEntries, entries, period]);
  const latestEntries = useMemo(() => [...entries].reverse(), [entries]);

  return (
    <SettingsSection title={usageT('settings.usage.title')} context={<RefreshButton loading={loading} onRefresh={refresh} />}>
      <div className={styles['usage-ledger']}>
        <div className={styles['usage-note']}>{usageT('settings.usage.note')}</div>
        {completeness && <div className={styles['usage-note']}>
          统计起点：{new Date(completeness.statisticsStartedAt).toLocaleString()} · {completeness.persistent ? '重启后保留' : '仅本次运行'}
          {' · '}当前展示 {completeness.returnedEntries}/{completeness.matchingEntries} 条
          {completeness.truncated && ' · 记录已截断，此金额仅为展示部分'}
          {completeness.droppedEntries > 0 && ` · 更早 ${completeness.droppedEntries} 条已不在统计范围`}
        </div>}
        <UsageBudgetSettings />
        <UsageTabs view={view} onChange={setView} />
        <div className={styles['usage-view-frame']}>
          {error && <div className={styles['usage-error']}>{error}</div>}
          {!error && loading && entries.length === 0 && <div className={styles['usage-empty']}>{usageT('settings.usage.loading')}</div>}
          {!error && !loading && entries.length === 0 && <div className={styles['usage-empty']}>{usageT('settings.usage.empty')}</div>}
          {!error && entries.length > 0 && (
            <>
              {view === 'overall' && <OverallView totals={totals} models={modelGroups} requests={latestEntries} />}
              {view === 'daily' && <DailyView groups={dailyGroups} period={period} onPeriodChange={setPeriod} />}
              {view === 'category' && <GroupView groups={categoryGroups} totals={totals} />}
              {view === 'model' && <GroupView groups={modelGroups} totals={totals} />}
            </>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

function RefreshButton({ loading, onRefresh }: { loading: boolean; onRefresh: () => Promise<void> }) {
  return (
    <button
      type="button"
      className={styles['usage-refresh-btn']}
      onClick={() => { void onRefresh(); }}
      title={usageT('settings.usage.refresh')}
      aria-label={usageT('settings.usage.refresh')}
      disabled={loading}
    >
      <RefreshIcon />
    </button>
  );
}

function UsageTabs({ view, onChange }: { view: UsageView; onChange: (view: UsageView) => void }) {
  const tabStyle = { '--usage-tab-index': USAGE_VIEW_ORDER.indexOf(view) } as CssVars;
  return (
    <div className={styles['usage-tabs']} role="tablist" aria-label={usageT('settings.usage.title')} style={tabStyle}>
      <span className={styles['usage-tab-slider']} aria-hidden="true" />
      {USAGE_VIEW_ORDER.map(item => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={view === item}
          className={`${styles['usage-tab']}${view === item ? ` ${styles.active}` : ''}`}
          onClick={() => onChange(item)}
        >
          <span className={styles['usage-tab-label']}>{usageT(`settings.usage.view.${item}`)}</span>
        </button>
      ))}
    </div>
  );
}

function OverallView({ totals, models, requests }: { totals: UsageAggregate; models: UsageAggregate[]; requests: UsageLedgerEntry[] }) {
  const topModels = models.slice(0, 4);
  return (
    <div className={styles['usage-overall']}>
      <div className={styles['usage-hero']}>
        <ModelOrbit groups={topModels} totalTokens={totals.totalTokens} />
        <div className={styles['usage-hero-copy']}>
          <span className={styles['usage-eyebrow']}>{usageT('settings.usage.modelMix')}</span>
          <span className={styles['usage-hero-value']}>{formatCompactNumber(totals.totalTokens)}</span>
          <span className={styles['usage-hero-meta']}>
            {usageT('settings.usage.cacheSummary', {
              cache: formatCompactNumber(totals.cacheReadTokens),
              uncached: formatCompactNumber(totals.nonCachedTokens),
            })}
          </span>
          <div className={styles['usage-hero-stats']}>
            <UsageHeroStat label={usageT('settings.usage.requests')} value={formatCompactNumber(totals.requests)} />
            <UsageHeroStat label={usageT('settings.usage.cacheRead')} value={formatCompactNumber(totals.cacheReadTokens)} />
            <UsageHeroStat label="已知部分金额（USD）" value={totals.knownCostCount ? formatCost(totals.costTotal) : '未知'} />
          </div>
          <div className={styles['usage-note']}>费用已知 {totals.knownCostCount} 次 · 未知 {totals.unknownCostCount} 次 · 覆盖率 {formatPercent(totals.costCoverage)}
            <br />配置估算 {formatCost(totals.configuredEstimateUsd)} · 供应商报告 {formatCost(totals.providerReportedUsd)}（非已核对账单）
          </div>
          <UsageLegend />
        </div>
      </div>
      <div className={styles['usage-overall-grid']}>
        <UsageRankList title={usageT('settings.usage.modelMix')} groups={models.slice(0, 6)} totalTokens={totals.totalTokens} />
        <RequestLedger entries={requests} />
      </div>
    </div>
  );
}

function UsageHeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles['usage-hero-stat']}>
      <span>{value}</span>
      <small>{label}</small>
    </div>
  );
}

function DailyView({
  groups,
  period,
  onPeriodChange,
}: {
  groups: UsageAggregate[];
  period: UsagePeriod;
  onPeriodChange: (period: UsagePeriod) => void;
}) {
  const activeGroups = groups.filter(group => group.requests > 0 || group.totalTokens > 0);
  const title = usageT(`settings.usage.window.${period}`);
  const periodTotals = aggregateEntries(`date-window-${period}`, title, groups.flatMap(group => group.entries));
  return (
    <div className={styles['usage-daily']}>
      <DailyBars groups={groups} title={title} period={period} onPeriodChange={onPeriodChange} />
      <UsageRankList title={title} groups={[...activeGroups].reverse()} totalTokens={periodTotals.totalTokens} />
    </div>
  );
}

function GroupView({ groups, totals }: { groups: UsageAggregate[]; totals: UsageAggregate }) {
  return (
    <div className={styles['usage-ring-grid']}>
      {groups.map(group => (
        <UsageGroupRow key={group.key} group={group} totalTokens={totals.totalTokens} />
      ))}
    </div>
  );
}

function UsageRankList({ title, groups, totalTokens }: { title: string; groups: UsageAggregate[]; totalTokens: number }) {
  return (
    <div className={styles['usage-panel']}>
      <div className={styles['usage-panel-title']}>{title}</div>
      <div className={styles['usage-rank-list']}>
        {groups.map(group => (
          <UsageGroupRow key={group.key} group={group} totalTokens={totalTokens} compact />
        ))}
      </div>
    </div>
  );
}

function UsageGroupRow({ group, totalTokens, compact = false }: { group: UsageAggregate; totalTokens: number; compact?: boolean }) {
  const share = totalTokens > 0 ? group.totalTokens / totalTokens : 0;
  return (
    <div className={`${styles['usage-group-row']}${compact ? ` ${styles.compact}` : ''}`}>
      <SplitRing group={group} totalTokens={compact ? group.totalTokens : totalTokens} size={compact ? 42 : 54} />
      <div className={styles['usage-group-main']}>
        <span className={styles['usage-group-title']} title={group.label}>{group.label}</span>
        <span className={styles['usage-group-meta']}>
          {usageT('settings.usage.groupMeta', { requests: group.requests, errors: group.errors })} · 已知 {group.knownCostCount ? formatCost(group.costTotal) : '未知'} · 未知 {group.unknownCostCount} 次 · 覆盖率 {formatPercent(group.costCoverage)}
        </span>
      </div>
      <div className={styles['usage-group-numbers']}>
        <span>{formatCompactNumber(group.totalTokens)}</span>
        <span>{formatPercent(share)}</span>
      </div>
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 0 1-15.5 6.2" />
      <path d="M3 12A9 9 0 0 1 18.5 5.8" />
      <path d="M18 2v4h4" />
      <path d="M6 22v-4H2" />
    </svg>
  );
}
