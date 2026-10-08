/**
 * ToolGroupBlock — 工具调用组，含展开/折叠
 */

import { memo, useState, useCallback, useEffect } from 'react';
import styles from './Chat.module.css';
import { extractToolDetail } from '../../utils/message-parser';
import type { ToolDetail } from '../../utils/message-parser';
import { isToolCallHiddenFromProcessUi } from '../../utils/tool-call-visibility';
import { openInternalLink } from '../../utils/link-open';
import { LinkContextMenu, type LinkContextMenuState } from '../shared/LinkContextMenu';

import type { ToolCall } from '../../stores/chat-types';

interface Props {
  tools: ToolCall[];
  collapsed: boolean;
  agentName?: string;
}

function getToolLabel(name: string, phase: string, agentName: string): string {
  const t = window.t;
  const vars = { name: agentName };
  const val = t?.(`tool.${name}.${phase}`, vars);
  if (val && val !== `tool.${name}.${phase}`) return val;
  return t?.(`tool._fallback.${phase}`, vars) || name;
}

export const ToolGroupBlock = memo(function ToolGroupBlock({ tools: rawTools, collapsed: initialCollapsed, agentName = '助手' }: Props) {
  // subagent 有独立卡片，不在工具组里重复显示
  const tools = rawTools.filter(t => !isToolCallHiddenFromProcessUi(t));
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  useEffect(() => {
    setCollapsed(initialCollapsed);
  }, [initialCollapsed]);
  const toggle = useCallback(() => setCollapsed(v => !v), []);

  if (tools.length === 0) return null;

  const allDone = tools.every(t => t.done);
  const failCount = tools.filter(t => t.done && !t.success).length;
  const isSingle = tools.length === 1;

  // 摘要标题
  const _t = window.t ?? ((p: string) => p);
  let summaryText = '';
  if (allDone) {
    if (failCount > 0) {
      summaryText = _t('toolGroup.countWithFail', { total: tools.length, fail: failCount });
    } else {
      summaryText = _t('toolGroup.count', { n: tools.length });
    }
  } else {
    const running = tools.filter(t => !t.done).length;
    summaryText = _t('toolGroup.running', { n: running });
  }

  return (
    <div className={`${styles.toolGroup}${isSingle ? ` ${styles.toolGroupSingle}` : ''}`}>
      {!isSingle && (
        <div
          className={`${styles.toolGroupSummary}${allDone ? ` ${styles.toolGroupSummaryClickable}` : ''}`}
          onClick={allDone ? toggle : undefined}
        >
          <span className={styles.toolGroupTitle}>{summaryText}</span>
          {allDone && <span className={styles.toolGroupArrow}>{collapsed ? '›' : '‹'}</span>}
          {!allDone && (
            <span className={styles.toolDots}><span /><span /><span /></span>
          )}
        </div>
      )}
      <div className={`${styles.toolGroupContent}${collapsed && !isSingle ? ` ${styles.toolGroupContentCollapsed}` : ''}`}>
        {tools.map((tool, i) => (
          <ToolIndicator key={`${tool.name}-${i}`} tool={tool} agentName={agentName} />
        ))}
      </div>
    </div>
  );
});

// ── ToolIndicator ──

function handleDetailClick(e: React.MouseEvent, detail: ToolDetail) {
  e.preventDefault();
  e.stopPropagation();
  if (!detail.href) return;
  void openInternalLink(detail.href, { origin: 'session' });
}

const ToolIndicator = memo(function ToolIndicator({ tool, agentName }: { tool: ToolCall; agentName: string }) {
  const [linkMenu, setLinkMenu] = useState<LinkContextMenuState | null>(null);

  const detail = extractToolDetail(tool.name, tool.args);
  const label = getToolLabel(tool.name, tool.done ? 'done' : 'running', agentName);
  const detailTitle = detail.title || detail.href;

  // 如果 args 里有 tag 类型信息（如 agent 名）
  const tag = tool.args?.agentId as string | undefined;

  return (
    <>
      <div className={styles.toolIndicator} data-tool={tool.name} data-done={String(tool.done)}>
        <span className={styles.toolDesc}>{label}</span>
        {detail.text && (
          detail.href ? (
            <span
              className={`${styles.toolDetail} ${styles.toolDetailLink}`}
              title={detailTitle}
              onClick={(e) => handleDetailClick(e, detail)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!detail.href) return;
                setLinkMenu({
                  href: detail.href,
                  context: { origin: 'session', label: detail.text },
                  position: { x: e.clientX, y: e.clientY },
                });
              }}
            >
              {detail.text}
            </span>
          ) : (
            <span className={styles.toolDetail} title={detailTitle}>{detail.text}</span>
          )
        )}
        {tag && <span className={styles.toolTag}>{tag}</span>}
        {tool.done ? (
          <span className={`${styles.toolStatus} ${tool.success ? styles.toolStatusDone : styles.toolStatusFailed}`}>
            {tool.success ? '✓' : '✗'}
          </span>
        ) : (
          <span className={styles.toolDots}><span /><span /><span /></span>
        )}
      </div>
      {linkMenu && (
        <LinkContextMenu
          state={linkMenu}
          onClose={() => setLinkMenu(null)}
        />
      )}
    </>
  );
});
