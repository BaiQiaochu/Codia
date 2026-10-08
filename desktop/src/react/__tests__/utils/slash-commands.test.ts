import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let buildSlashCommands: typeof import('../../components/input/slash-commands').buildSlashCommands;
let buildVideoCommandPrompt: typeof import('../../components/input/slash-commands').buildVideoCommandPrompt;
let buildSlashDraftText: typeof import('../../components/input/slash-commands').buildSlashDraftText;
let executeSlashViaWs: typeof import('../../components/input/slash-commands').executeSlashViaWs;
let getSlashMatches: typeof import('../../components/input/slash-commands').getSlashMatches;
let parseSlashInput: typeof import('../../components/input/slash-commands').parseSlashInput;
let useStore: typeof import('../../stores').useStore;

const mocks = vi.hoisted(() => ({
  ws: {
    readyState: 1,
    send: vi.fn(),
  },
  getWebSocket: vi.fn(),
  ensureSession: vi.fn(),
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: mocks.getWebSocket,
}));

vi.mock('../../stores/session-actions', () => ({
  ensureSession: mocks.ensureSession,
}));

beforeAll(async () => {
  vi.stubGlobal('window', {
    i18n: { locale: 'zh-CN' },
  });
  const mod = await import('../../components/input/slash-commands');
  ({ useStore } = await import('../../stores'));
  buildSlashCommands = mod.buildSlashCommands;
  buildVideoCommandPrompt = mod.buildVideoCommandPrompt;
  buildSlashDraftText = mod.buildSlashDraftText;
  executeSlashViaWs = mod.executeSlashViaWs;
  getSlashMatches = mod.getSlashMatches;
  parseSlashInput = mod.parseSlashInput;
});

beforeEach(() => {
  mocks.ws.send.mockClear();
  mocks.getWebSocket.mockReturnValue(mocks.ws);
  mocks.ensureSession.mockReset();
  useStore.setState({
    currentSessionPath: null,
    pendingNewSession: false,
    streamingSessions: [],
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('slash commands', () => {
  function commands() {
    return buildSlashCommands(
      (key: string) => key,
      vi.fn(async () => {}),
      vi.fn(async () => {}),
      vi.fn(async () => {}),
      vi.fn(async () => {}),
      vi.fn((_cmd: string) => async () => {}),
    );
  }

  it('parses command name and arguments separately', () => {
    expect(parseSlashInput('/video make rain')).toEqual({
      name: 'video',
      args: 'make rain',
    });
  });

  it('matches slash commands by command token even when args are present', () => {
    const matches = getSlashMatches('/video hi', commands());
    expect(matches.some((cmd) => cmd.name === 'video')).toBe(true);
  });

  it('shows all current slash commands for a bare slash trigger', () => {
    const list = commands();
    const matches = getSlashMatches('/', list);
    const names = matches.map((cmd) => cmd.name);

    expect(names).toContain('video');
    expect(names).not.toContain('hermes');
    expect(names).not.toContain('hfvideo');
    expect(matches.length).toBe(list.length);
  });

  it('tells video slash calls to use the unified image-gen video tool', () => {
    const prompt = buildVideoCommandPrompt('make a short rain scene');
    expect(prompt).toContain('image-gen_generate-video');
    expect(prompt).not.toContain('openmontage_create-video-production');
    expect(prompt).not.toMatch(/video-gen_.*render/);
  });

  it('does not match removed slash commands', () => {
    const list = commands();

    expect(getSlashMatches('/hermes hi', list).some((cmd) => cmd.name === 'hermes')).toBe(false);
    expect(getSlashMatches('/hfvideo hi', list).some((cmd) => cmd.name === 'hfvideo')).toBe(false);
  });

  it('matches slash commands with long argument text by limiting only the command token', () => {
    const matches = getSlashMatches(
      '/video quick animated title --duration 1 --resolution 320x240 --fps 24',
      commands(),
    );

    expect(matches.some((cmd) => cmd.name === 'video')).toBe(true);
  });

  it('builds a slash draft from a bare slash trigger', () => {
    expect(buildSlashDraftText('video', '/')).toBe('/video ');
  });

  it('replaces a partial slash command with the picked command', () => {
    expect(buildSlashDraftText('video', '/vi')).toBe('/video ');
  });

  it('preserves typed args when switching slash command picks', () => {
    expect(buildSlashDraftText('video', '/diary check D drive')).toBe('/video check D drive');
  });

  it('creates the pending desktop session before sending reset slash commands', async () => {
    useStore.setState({
      currentSessionPath: null,
      pendingNewSession: true,
    });
    mocks.ensureSession.mockImplementation(async () => {
      useStore.setState({
        currentSessionPath: 'E:/GSAPmaim/G-sap/.tmp/current.jsonl',
        pendingNewSession: false,
      });
      return true;
    });

    const run = executeSlashViaWs(
      'reset',
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    await run();

    expect(mocks.ensureSession).toHaveBeenCalledTimes(1);
    expect(mocks.ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.ws.send.mock.calls[0][0])).toMatchObject({
      type: 'slash',
      text: '/reset',
      sessionPath: 'E:/GSAPmaim/G-sap/.tmp/current.jsonl',
    });
  });

  it('creates a desktop session for reset slash commands when the pending flag was lost', async () => {
    useStore.setState({
      currentSessionPath: null,
      pendingNewSession: false,
    });
    mocks.ensureSession.mockImplementation(async () => {
      useStore.setState({
        currentSessionPath: 'E:/GSAPmaim/G-sap/.tmp/recovered.jsonl',
        pendingNewSession: false,
      });
      return true;
    });

    const run = executeSlashViaWs(
      'reset',
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    await run();

    expect(mocks.ensureSession).toHaveBeenCalledTimes(1);
    expect(mocks.ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.ws.send.mock.calls[0][0])).toMatchObject({
      type: 'slash',
      text: '/reset',
      sessionPath: 'E:/GSAPmaim/G-sap/.tmp/recovered.jsonl',
    });
  });

  it('sends the stable sessionId with WebSocket slash commands when available', async () => {
    useStore.setState({
      currentSessionPath: 'E:/GSAPmaim/G-sap/.tmp/current.jsonl',
      currentSessionId: 'sess_current_123',
      sessions: [{
        path: 'E:/GSAPmaim/G-sap/.tmp/current.jsonl',
        sessionId: 'sess_current_123',
        title: 'Current',
        firstMessage: '',
        modified: new Date(0).toISOString(),
        messageCount: 0,
        agentId: 'agent-1',
        agentName: 'G-SAP',
        cwd: null,
      }],
      pendingNewSession: false,
    });

    const run = executeSlashViaWs(
      'reset',
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    await run();

    expect(mocks.ensureSession).not.toHaveBeenCalled();
    expect(mocks.ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.ws.send.mock.calls[0][0])).toMatchObject({
      type: 'slash',
      text: '/reset',
      sessionPath: 'E:/GSAPmaim/G-sap/.tmp/current.jsonl',
      sessionId: 'sess_current_123',
    });
  });
});
