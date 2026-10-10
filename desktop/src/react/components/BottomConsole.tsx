import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';

type ConsoleKind = 'powershell' | 'codiactl';
type ConsolePanel = 'problems' | 'output' | 'debug' | 'terminal' | 'ports';

type ConsoleLine = {
  id: number;
  kind: ConsoleKind;
  command: string;
  output: string;
  code: number;
  ok: boolean;
};

type ProblemItem = {
  id: number;
  source: string;
  location: string;
  message: string;
  code: string;
};

type ConsoleActionDetail = {
  action?: 'show-terminal' | 'show-output' | 'run-debug' | 'run-command' | 'toggle';
  kind?: ConsoleKind;
  command?: string;
  label?: string;
  panel?: ConsolePanel;
};

type BottomConsoleProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

const PANEL_LABELS: Record<ConsolePanel, string> = {
  problems: '问题',
  output: '输出',
  debug: '调试控制台',
  terminal: '终端',
  ports: '端口',
};

const PANEL_HINTS: Record<ConsolePanel, string> = {
  problems: '未发现本地命令问题',
  output: '暂无输出流',
  debug: '运行调试命令或本地检查',
  terminal: '运行本地 PowerShell 或 Agent CLI 命令',
  ports: '暂无转发端口',
};

const FALLBACK_TEXT: Record<string, string> = {
  'console.title': '底部面板',
  'console.clear': '清空',
  'console.empty': '暂无输出',
  'console.running': '命令运行中...',
  'console.runningShort': '运行中',
  'console.run': '运行',
};

function defaultCommand(kind: ConsoleKind) {
  return kind === 'codiactl' ? 'health' : 'Get-Location';
}

function tt(key: string) {
  const value = window.t?.(key);
  return value && value !== key ? value : FALLBACK_TEXT[key] || key;
}

function publishRecentTerminalOutput(lines: ConsoleLine[]): void {
  const text = lines
    .map((line) => `${line.kind === 'codiactl' ? 'agent-cli' : 'PS'}> ${line.command}\n${line.output || `(exit ${line.code})`}`)
    .join('\n\n')
    .slice(-4000);
  (window as typeof window & { __CODIA_RECENT_TERMINAL_OUTPUT__?: string }).__CODIA_RECENT_TERMINAL_OUTPUT__ = text;
  window.dispatchEvent(new CustomEvent('codia-terminal-output', { detail: { text } }));
}

function problemFromLine(line: ConsoleLine): ProblemItem {
  const firstLine = (line.output || `(exit ${line.code})`).split(/\r?\n/).find(Boolean) || `(exit ${line.code})`;
  const locationMatch = firstLine.match(/^(.+?\.(?:ts|tsx|js|jsx|json|css|scss|md|py|cjs|mjs))(?::(\d+))?(?::(\d+))?\s*(?:-|:)?\s*(.*)$/i);
  if (locationMatch) {
    const [, file, row, col, message] = locationMatch;
    const location = [file, row, col].filter(Boolean).join(':');
    return {
      id: line.id,
      source: line.command,
      location,
      message: message?.trim() || firstLine,
      code: `exit ${line.code}`,
    };
  }
  return {
    id: line.id,
    source: line.command,
    location: line.kind === 'codiactl' ? 'Agent CLI' : 'PowerShell',
    message: firstLine,
    code: `exit ${line.code}`,
  };
}

export function BottomConsole({ open: controlledOpen, onOpenChange }: BottomConsoleProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [panel, setPanel] = useState<ConsolePanel>('terminal');
  const [kind, setKind] = useState<ConsoleKind>('powershell');
  const [command, setCommand] = useState(defaultCommand('powershell'));
  const [filter, setFilter] = useState('');
  const [running, setRunning] = useState(false);
  const [available, setAvailable] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const appViewMode = useStore((s) => s.appViewMode);
  const cwd = useStore((s) => s.deskBasePath || s.selectedFolder || s.homeFolder || undefined);
  const outputRef = useRef<HTMLDivElement>(null);
  const open = controlledOpen ?? internalOpen;
  const problemLines = lines.filter((line) => !line.ok);
  const problemCount = problemLines.length;
  const visibleLines = panel === 'problems' ? problemLines : lines;
  const problemItems = problemLines.map(problemFromLine);

  const setConsoleOpen = useCallback((nextOpen: boolean) => {
    if (onOpenChange) onOpenChange(nextOpen);
    else setInternalOpen(nextOpen);
    if (!nextOpen) setMaximized(false);
  }, [onOpenChange]);

  useEffect(() => {
    let alive = true;
    window.platform?.getPlatform?.()
      .then((platform) => {
        if (alive && platform === 'web') setAvailable(false);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    document.body.classList.toggle('bottom-console-open', open && available);
    return () => document.body.classList.remove('bottom-console-open');
  }, [available, open]);

  useEffect(() => {
    if (!open) setMaximized(false);
  }, [open]);

  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight });
    else el.scrollTop = el.scrollHeight;
  }, [lines, running]);

  const appendLine = useCallback((line: Omit<ConsoleLine, 'id'>) => {
    setLines((prev) => {
      const next = [...prev, { id: Date.now(), ...line }].slice(-40);
      publishRecentTerminalOutput(next);
      return next;
    });
  }, []);

  const runCommand = useCallback(async (nextKind: ConsoleKind, text: string, label = text) => {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    setRunning(true);
    try {
      const result = await window.platform?.runConsoleCommand?.({ kind: nextKind, command: trimmed, cwd });
      appendLine({
        kind: nextKind,
        command: label,
        output: result?.output || '',
        code: Number(result?.code ?? 1),
        ok: result?.ok === true,
      });
    } catch (err) {
      appendLine({
        kind: nextKind,
        command: label,
        output: err instanceof Error ? err.message : String(err),
        code: 1,
        ok: false,
      });
    } finally {
      setRunning(false);
    }
  }, [appendLine, cwd, running]);

  const switchKind = (next: ConsoleKind) => {
    setKind(next);
    setCommand(defaultCommand(next));
  };

  const showPanel = useCallback((next: ConsolePanel) => {
    setPanel(next);
    setConsoleOpen(true);
  }, [setConsoleOpen]);

  const togglePanel = (next: ConsolePanel) => {
    if (open && panel === next) {
      setConsoleOpen(false);
      return;
    }
    showPanel(next);
  };

  const run = async () => {
    await runCommand(kind, command);
  };

  const toggleMaximized = () => {
    if (!open) setConsoleOpen(true);
    setMaximized((current) => !current);
  };

  const runDebug = useCallback(async () => {
    showPanel('debug');
    await runCommand('powershell', 'Get-Location', 'Debug Program');
  }, [runCommand, showPanel]);

  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<ConsoleActionDetail>).detail || {};
      if (detail.action === 'toggle') setConsoleOpen(!open);
      else if (detail.action === 'show-terminal') showPanel('terminal');
      else if (detail.action === 'show-output') showPanel('output');
      else if (detail.action === 'run-debug') void runDebug();
      else if (detail.action === 'run-command' && detail.command) {
        const nextKind = detail.kind || 'powershell';
        setKind(nextKind);
        setCommand(detail.command);
        showPanel(detail.panel || (nextKind === 'codiactl' ? 'terminal' : 'output'));
        void runCommand(nextKind, detail.command, detail.label || detail.command);
      }
    };
    window.addEventListener('codia-console-action', onAction);
    return () => window.removeEventListener('codia-console-action', onAction);
  }, [open, runCommand, runDebug, setConsoleOpen, showPanel]);

  if (!available) return null;

  return (
    <div
      className={`bottom-console bottom-console-${appViewMode}${open ? ' open' : ' collapsed'}${maximized ? ' maximized' : ''}`}
      data-testid="bottom-console"
    >
      {open && (
        <>
          <div className="bottom-console-header">
            <div className="bottom-console-tabs" role="tablist" aria-label={tt('console.title')}>
              {(Object.keys(PANEL_LABELS) as ConsolePanel[]).map((key) => (
                <button
                  key={key}
                  className={`bottom-console-tab${panel === key ? ' active' : ''}`}
                  onClick={() => togglePanel(key)}
                  aria-expanded={panel === key}
                  type="button"
                >
                  <span>{PANEL_LABELS[key]}</span>
                  {key === 'problems' && problemCount > 0 && (
                    <span className="bottom-console-count">{problemCount}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="bottom-console-header-actions">
              <input
                className="bottom-console-filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="筛选，例如 text, !exclude"
              />
              <button className="bottom-console-icon-btn" type="button" title="搜索" aria-label="搜索">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
              </button>
              <button className="bottom-console-clear" type="button" onClick={() => setLines([])}>{tt('console.clear')}</button>
              <button className="bottom-console-icon-btn" type="button" onClick={toggleMaximized} title={maximized ? '还原' : '最大化'} aria-label={maximized ? '还原' : '最大化'}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H3v5"/><path d="M16 3h5v5"/><path d="M8 21H3v-5"/><path d="M16 21h5v-5"/></svg>
              </button>
              <button className="bottom-console-icon-btn" type="button" onClick={() => setConsoleOpen(false)} title="关闭底部面板" aria-label="关闭底部面板">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
              </button>
            </div>
          </div>
          <div className="bottom-console-panel">
            {panel === 'debug' && (
              <div className="bottom-console-toolbar">
                <button className="bottom-console-debug-run" type="button" onClick={() => void runDebug()} disabled={running}>调试程序</button>
              </div>
            )}
            {panel !== 'terminal' && panel !== 'debug' && (
              <div className="bottom-console-empty bottom-console-panel-note">
                {panel === 'problems' && problemCount > 0 ? '' : PANEL_HINTS[panel]}
              </div>
            )}
            <div className="bottom-console-output" ref={outputRef}>
              {panel === 'problems' ? (
                problemItems.length === 0 ? (
                  <div className="bottom-console-empty">{tt('console.empty')}</div>
                ) : (
                  <div className="bottom-console-problems-list" role="table" aria-label={PANEL_LABELS.problems}>
                    {problemItems.map((item) => (
                      <div key={item.id} className="bottom-console-problem-row" role="row">
                        <span className="bottom-console-problem-severity" aria-hidden="true">!</span>
                        <span className="bottom-console-problem-message">{item.message}</span>
                        <span className="bottom-console-problem-location">{item.location}</span>
                        <span className="bottom-console-problem-source">{item.source}</span>
                        <span className="bottom-console-problem-code">{item.code}</span>
                      </div>
                    ))}
                  </div>
                )
              ) : visibleLines.length === 0 ? (
                <div className="bottom-console-empty">{tt('console.empty')}</div>
              ) : visibleLines.map((line) => (
                <div key={line.id} className="bottom-console-entry">
                  <div className="bottom-console-command">{line.kind === 'codiactl' ? 'agent-cli' : 'PS'}&gt; {line.command}</div>
                  <pre className={line.ok ? '' : 'error'}>{line.output || `(exit ${line.code})`}</pre>
                </div>
              ))}
              {running && <div className="bottom-console-empty">{tt('console.running')}</div>}
            </div>
            {(panel === 'terminal' || panel === 'debug') && (
              <form
                className="bottom-console-input-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run();
                }}
              >
                <div className="bottom-console-switch" role="tablist" aria-label={tt('console.title')}>
                  <button type="button" className={kind === 'powershell' ? 'active' : ''} onClick={() => switchKind('powershell')}>PowerShell</button>
                  <button type="button" className={kind === 'codiactl' ? 'active' : ''} onClick={() => switchKind('codiactl')}>Agent CLI</button>
                </div>
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder={kind === 'codiactl' ? 'health' : 'Get-ChildItem'}
                />
                <button type="submit" disabled={running || !command.trim()}>{running ? tt('console.runningShort') : tt('console.run')}</button>
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
}
