/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomConsole } from '../../components/BottomConsole';

let mockAppViewMode: 'standard' | 'obsidian' = 'obsidian';
let mockCwd = '/workspace';

vi.mock('../../stores', () => ({
  useStore: (selector: (state: {
    appViewMode: 'standard' | 'obsidian';
    deskBasePath: string | null;
    selectedFolder: string | null;
    homeFolder: string | null;
  }) => unknown) => selector({
    appViewMode: mockAppViewMode,
    deskBasePath: mockCwd,
    selectedFolder: null,
    homeFolder: null,
  }),
}));

function dispatchConsoleAction(detail: Record<string, unknown>) {
  fireEvent(window, new CustomEvent('codia-console-action', { detail }));
}

function openTerminal() {
  dispatchConsoleAction({ action: 'show-terminal' });
}

describe('BottomConsole', () => {
  beforeEach(() => {
    mockAppViewMode = 'obsidian';
    mockCwd = '/workspace';
    window.t = ((key: string) => key) as typeof window.t;
    window.platform = {
      runConsoleCommand: vi.fn(async () => ({ ok: true, code: 0, output: 'ok' })),
    } as unknown as typeof window.platform;
  });

  afterEach(() => {
    cleanup();
    document.body.classList.remove('bottom-console-open');
  });

  it('stays visually hidden while closed so the top bar is owned by the titlebar button', () => {
    const { container } = render(<BottomConsole />);

    expect(screen.getByTestId('bottom-console').className).toContain('collapsed');
    expect(container.querySelector('.bottom-console-header')).toBeNull();
    expect(container.querySelector('.bottom-console-panel')).toBeNull();
    expect(screen.queryByRole('button', { name: '终端' })).toBeNull();
    expect(document.body.classList.contains('bottom-console-open')).toBe(false);
  });

  it('opens from the shared console action and runs a PowerShell command through platform IPC', async () => {
    render(<BottomConsole />);
    openTerminal();

    expect(document.body.classList.contains('bottom-console-open')).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Get-ChildItem'), { target: { value: 'Get-Date' } });
    fireEvent.click(screen.getByRole('button', { name: '运行' }));

    await waitFor(() => expect(window.platform.runConsoleCommand).toHaveBeenCalledWith({
      kind: 'powershell',
      command: 'Get-Date',
      cwd: '/workspace',
    }));
    expect(await screen.findByText('ok')).toBeTruthy();
  });

  it('switches to Agent CLI mode', async () => {
    render(<BottomConsole />);
    openTerminal();
    fireEvent.click(screen.getByRole('button', { name: 'Agent CLI' }));
    fireEvent.click(screen.getByRole('button', { name: '运行' }));

    await waitFor(() => expect(window.platform.runConsoleCommand).toHaveBeenCalledWith({
      kind: 'codiactl',
      command: 'health',
      cwd: '/workspace',
    }));
  });

  it('renders localized bottom panel tabs and utility controls after opening', () => {
    const { container } = render(<BottomConsole />);

    expect(container.querySelector('.bottom-console-launcher')).toBeNull();
    expect(container.querySelector('.bottom-console-tabs')).toBeNull();
    openTerminal();

    expect(screen.getByRole('button', { name: /问题/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /输出/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /调试控制台/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /终端/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /端口/ })).toBeTruthy();

    const root = screen.getByTestId('bottom-console');
    const header = root.querySelector('.bottom-console-header');
    const panel = root.querySelector('.bottom-console-panel');
    expect(header && panel ? Number(header.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING) : 0).toBeGreaterThan(0);
    expect(header?.querySelector('.bottom-console-header-actions')).toBeTruthy();
    expect(screen.getByPlaceholderText('筛选，例如 text, !exclude')).toBeTruthy();
    expect(screen.getByTitle('搜索')).toBeTruthy();
    expect(screen.getByTitle('最大化')).toBeTruthy();
    expect(screen.getByTitle('关闭底部面板')).toBeTruthy();
  });

  it('collapses the console when the active bottom tab is clicked again', () => {
    render(<BottomConsole />);
    openTerminal();

    const terminal = screen.getByRole('button', { name: '终端' });
    expect(screen.getByTestId('bottom-console').className).toContain('open');

    fireEvent.click(terminal);
    expect(screen.getByTestId('bottom-console').className).toContain('collapsed');
    expect(document.body.classList.contains('bottom-console-open')).toBe(false);
  });

  it('only shows the problem count when console commands have real failures', async () => {
    render(<BottomConsole />);

    expect(screen.queryByRole('button', { name: /问题/ })).toBeNull();

    window.platform.runConsoleCommand = vi.fn(async () => ({
      ok: false,
      code: 1,
      output: 'spawn powershell.exe ENOENT',
    })) as typeof window.platform.runConsoleCommand;

    openTerminal();
    fireEvent.change(screen.getByPlaceholderText('Get-ChildItem'), { target: { value: 'Get-Location' } });
    fireEvent.click(screen.getByRole('button', { name: '运行' }));

    await waitFor(() => expect(window.platform.runConsoleCommand).toHaveBeenCalled());
    expect(within(screen.getByRole('button', { name: /问题/ })).getByText('1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(within(screen.getByRole('button', { name: '问题' })).queryByText(/\d+/)).toBeNull();
  });

  it('renders failed commands in a VS Code style problems panel instead of terminal output', async () => {
    const { container } = render(<BottomConsole />);
    window.platform.runConsoleCommand = vi.fn(async () => ({
      ok: false,
      code: 127,
      output: 'src/main.ts:12:5 - Cannot find name Foo',
    })) as typeof window.platform.runConsoleCommand;

    openTerminal();
    fireEvent.change(screen.getByPlaceholderText('Get-ChildItem'), { target: { value: 'npm run typecheck' } });
    fireEvent.click(screen.getByRole('button', { name: /运行/ }));
    await waitFor(() => expect(window.platform.runConsoleCommand).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /问题/ }));

    const problems = container.querySelector('.bottom-console-problems-list');
    expect(problems).toBeTruthy();
    expect(container.querySelector('.bottom-console-problem-row')).toBeTruthy();
    expect(container.querySelector('.bottom-console-problem-message')?.textContent).toContain('Cannot find name Foo');
    expect(container.querySelector('.bottom-console-problem-source')?.textContent).toContain('npm run typecheck');
    expect(container.querySelector('.bottom-console-problem-location')?.textContent).toContain('src/main.ts:12:5');
    expect(problems?.textContent).not.toContain('PS>');
    expect(problems?.querySelector('pre')).toBeNull();
  });

  it('runs the local debug command from the debug console tab', async () => {
    render(<BottomConsole />);
    dispatchConsoleAction({ action: 'show-output' });
    fireEvent.click(screen.getByRole('button', { name: /调试控制台/ }));
    fireEvent.click(screen.getByRole('button', { name: '调试程序' }));

    await waitFor(() => expect(window.platform.runConsoleCommand).toHaveBeenCalledWith({
      kind: 'powershell',
      command: 'Get-Location',
      cwd: '/workspace',
    }));
  });

  it('opens maximized when the maximize control is clicked from the open state', () => {
    render(<BottomConsole />);
    const consoleRoot = screen.getByTestId('bottom-console');

    expect(consoleRoot.className).toContain('collapsed');
    expect(consoleRoot.className).not.toContain('maximized');

    openTerminal();
    fireEvent.click(screen.getByTitle('最大化'));

    expect(document.body.classList.contains('bottom-console-open')).toBe(true);
    expect(consoleRoot.className).toContain('open');
    expect(consoleRoot.className).toContain('maximized');
  });

  it('can run source control commands from IDE menu events', async () => {
    render(<BottomConsole />);

    dispatchConsoleAction({
      action: 'run-command',
      kind: 'powershell',
      command: 'git status --short',
      label: 'Source Control: status',
    });

    await waitFor(() => expect(window.platform.runConsoleCommand).toHaveBeenCalledWith({
      kind: 'powershell',
      command: 'git status --short',
      cwd: '/workspace',
    }));
    expect(document.body.classList.contains('bottom-console-open')).toBe(true);
  });

  it('stays available but visually hidden in standard conversation mode until opened', () => {
    mockAppViewMode = 'standard';
    render(<BottomConsole />);

    expect(screen.getByTestId('bottom-console')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '终端' })).toBeNull();
    expect(document.body.classList.contains('bottom-console-open')).toBe(false);
  });
});
