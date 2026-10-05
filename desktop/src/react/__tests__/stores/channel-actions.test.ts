/**
 * channel-actions 基线测试
 *
  * */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadAgentsMock = vi.fn();

// Mock store
const mockState: Record<string, unknown> = {
  serverPort: '3210',
  currentTab: 'chat',
  channels: [],
  currentChannel: null,
  channelMessages: [],
  channelMessageCache: {},
  channelMessageCacheDirty: {},
  channelTotalUnread: 0,
  channelsEnabled: true,
  userName: 'testuser',
  channelMembers: [],
  channelHeaderName: '',
  channelHeaderMembersText: '',
  channelIsDM: false,
  channelInfoName: '',
  channelInfoDescription: '',
  channelMemberRoles: {},
  channelAgentActivities: {},
  channelAgentPhoneToolMode: 'read_only',
  channelAgentReplyMinChars: null,
  channelAgentReplyMaxChars: null,
  channelAgentProactiveEnabled: true,
  channelAgentReminderIntervalMinutes: 31,
  channelAgentGuardLimit: 36,
  channelAgentModelOverrideEnabled: false,
  channelAgentModelOverrideModel: null,
};

const setStateCalls: Array<Record<string, unknown>> = [];

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => ({ ...mockState }),
    setState: (patch: Record<string, unknown>) => {
      setStateCalls.push(patch);
      Object.assign(mockState, patch);
    },
  },
}));

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: vi.fn(),
}));

vi.mock('../../stores/agent-actions', () => ({
  loadAgents: (...args: unknown[]) => loadAgentsMock(...args),
}));

import { gsapFetch } from '../../hooks/use-gsap-fetch';

const mockFetch = vi.mocked(gsapFetch);

describe('channel-actions', () => {
  beforeEach(() => {
    const testGlobal = globalThis as typeof globalThis & {
      window?: {
        platform?: { settingsChanged: ReturnType<typeof vi.fn> };
        t?: (key: string) => string;
      };
    };

    setStateCalls.length = 0;
    mockState.channels = [];
    mockState.currentTab = 'chat';
    mockState.currentChannel = null;
    mockState.channelMessages = [];
    mockState.channelMessageCache = {};
    mockState.channelMessageCacheDirty = {};
    mockState.channelTotalUnread = 0;
    mockState.channelsEnabled = true;
    mockState.channelInfoDescription = '';
    mockState.channelMemberRoles = {};
    mockState.channelAgentActivities = {};
    mockState.channelAgentPhoneToolMode = 'read_only';
    mockState.channelAgentReplyMinChars = null;
    mockState.channelAgentReplyMaxChars = null;
    mockState.channelAgentProactiveEnabled = true;
    mockState.channelAgentReminderIntervalMinutes = 31;
    mockState.channelAgentGuardLimit = 36;
    mockState.channelAgentModelOverrideEnabled = false;
    mockState.channelAgentModelOverrideModel = null;
    mockState.deskBasePath = '';
    mockState.selectedFolder = '';
    mockState.homeFolder = '';
    mockFetch.mockReset();
    loadAgentsMock.mockReset();
    testGlobal.window = {
      platform: { settingsChanged: vi.fn() },
      t: (key: string) => key,
    } as unknown as typeof testGlobal.window;
  });

  describe('loadChannels', () => {
    it('loads channels and DM list', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            channels: [{
              id: 'ch1',
              name: 'general',
              newMessageCount: 2,
              memberRoles: { hana: 'project_manager' },
              roleCounts: { project_manager: 1, admin: 0, worker: 0 },
            }],
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ownerAgentId: 'owner-1',
            dms: [{ peerId: 'agent1', peerName: 'Agent 1', messageCount: 5 }],
          }),
        } as Response);

      const { loadChannels } = await import('../../stores/channel-actions');
      await loadChannels();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      //
      const lastPatch = setStateCalls[setStateCalls.length - 1];
      expect(lastPatch.channels).toBeDefined();
      const channels = lastPatch.channels as Array<{ id: string; isDM: boolean }>;
      expect(channels.length).toBe(2);
      expect(channels[0].isDM).toBe(false);
      expect((channels[0] as { memberRoles?: Record<string, string> }).memberRoles?.hana).toBe('project_manager');
      expect(channels[1].isDM).toBe(true);
      expect(channels[1].id).toBe('dm:agent1');
      expect((channels[1] as { dmOwnerId?: string }).dmOwnerId).toBe('owner-1');
    });

    it('does not request when serverPort is empty', async () => {
      mockState.serverPort = '';
      const { loadChannels } = await import('../../stores/channel-actions');
      await loadChannels();
      expect(mockFetch).not.toHaveBeenCalled();
      mockState.serverPort = '3210';
    });
  });

  describe('sendChannelMessage', () => {
    it('does not send empty messages', async () => {
      mockState.currentChannel = 'ch1';
      const { sendChannelMessage } = await import('../../stores/channel-actions');
      await sendChannelMessage('   ');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not send without a current channel', async () => {
      mockState.currentChannel = null;
      const { sendChannelMessage } = await import('../../stores/channel-actions');
      await sendChannelMessage('hello');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('appends the message to store after a successful send', async () => {
      mockState.currentChannel = 'ch1';
      mockState.channelMessages = [];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, timestamp: '2026-03-22T00:00:00Z' }),
      } as Response);

      const { sendChannelMessage } = await import('../../stores/channel-actions');
      await sendChannelMessage('hello world');

      const msgPatch = setStateCalls.find(p => p.channelMessages);
      expect(msgPatch).toBeDefined();
      const msgs = msgPatch!.channelMessages as Array<{ sender: string; body: string }>;
      expect(msgs[msgs.length - 1].body).toBe('hello world');
      expect(msgs[msgs.length - 1].sender).toBe('testuser');
    });

    it('sends rich file blocks and resource envelopes for channel media messages', async () => {
      mockState.currentChannel = 'ch1';
      mockState.channelMessages = [];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, timestamp: '2026-03-22T00:00:00Z' }),
      } as Response);

      const blocks = [
        {
          type: 'file',
          filePath: 'E:/uploads/demo.png',
          label: 'demo.png',
          ext: 'png',
          kind: 'image',
          resource: {
            schemaVersion: 1,
            resourceId: 'res-demo',
            name: 'demo.png',
            studioId: 'default',
            type: 'file',
            source: 'session_file',
            lifecycle: { status: 'available', missingAt: null },
            storage: { provider: 'session_file' },
            links: { self: '/api/resources/res-demo' },
          },
        },
      ];
      const { sendChannelMessage } = await import('../../stores/channel-actions');
      await (sendChannelMessage as (text: string, options?: { blocks?: unknown[] }) => Promise<void>)('', { blocks });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(mockFetch.mock.calls[0][1]?.body || '{}'));
      expect(body.blocks).toEqual(blocks);
      expect(body.resources).toEqual([blocks[0].resource]);
      expect(body.body).toBe('');

      const msgPatch = setStateCalls.find(p => p.channelMessages);
      expect(msgPatch).toBeDefined();
      const msgs = msgPatch!.channelMessages as Array<{ body: string; blocks?: unknown[]; resources?: unknown[] }>;
      expect(msgs[msgs.length - 1].body).toBe('');
      expect(msgs[msgs.length - 1].blocks).toEqual(blocks);
      expect(msgs[msgs.length - 1].resources).toEqual([blocks[0].resource]);
    });
  });

  describe('agent phone state', () => {
    it('loads conversation agent activities into a per-conversation map', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          activities: [{
            conversationId: 'ch-build',
            conversationType: 'channel',
            agentId: 'worker-1',
            state: 'triaging',
            summary: 'checking updates',
            timestamp: '2026-05-13T10:00:00.000Z',
          }],
        }),
      } as Response);

      const { loadConversationAgentActivities } = await import('../../stores/channel-actions');
      await loadConversationAgentActivities('ch-build');

      expect(mockFetch).toHaveBeenCalledWith('/api/conversations/ch-build/agent-activities');
      expect(mockState.channelAgentActivities).toEqual({
        'ch-build': {
          'worker-1': [{
            conversationId: 'ch-build',
            conversationType: 'channel',
            agentId: 'worker-1',
            state: 'triaging',
            summary: 'checking updates',
            timestamp: '2026-05-13T10:00:00.000Z',
          }],
        },
      });
    });

    it('upserts live conversation activity without duplicating the same event', async () => {
      const activity = {
        conversationId: 'ch-build',
        conversationType: 'channel' as const,
        agentId: 'worker-1',
        state: 'replying',
        summary: 'writing',
        timestamp: '2026-05-13T10:01:00.000Z',
      };

      const { upsertConversationAgentActivity } = await import('../../stores/channel-actions');
      upsertConversationAgentActivity(activity);
      upsertConversationAgentActivity(activity);

      expect(mockState.channelAgentActivities).toEqual({
        'ch-build': {
          'worker-1': [activity],
        },
      });
    });

    it('saves phone settings for the current channel and applies normalized response state', async () => {
      mockState.currentChannel = 'ch-build';
      mockState.channelAgentPhoneToolMode = 'read_only';
      mockState.channelAgentReplyMinChars = null;
      mockState.channelAgentReplyMaxChars = 240;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          mode: 'write',
          replyMinChars: 20,
          replyMaxChars: 240,
          proactiveEnabled: false,
          reminderIntervalMinutes: 45,
          guardLimit: 24,
          modelOverrideEnabled: true,
          modelOverrideModel: { id: 'gpt-5.2', provider: 'openai' },
        }),
      } as Response);

      const { saveConversationAgentPhoneSettings } = await import('../../stores/channel-actions');
      await saveConversationAgentPhoneSettings({ mode: 'write', replyMinChars: 20, proactiveEnabled: false });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/conversations/ch-build/agent-phone-settings',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"mode":"write"'),
        }),
      );
      expect(mockState.channelAgentPhoneToolMode).toBe('write');
      expect(mockState.channelAgentReplyMinChars).toBe(20);
      expect(mockState.channelAgentReplyMaxChars).toBe(240);
      expect(mockState.channelAgentProactiveEnabled).toBe(false);
      expect(mockState.channelAgentReminderIntervalMinutes).toBe(45);
      expect(mockState.channelAgentGuardLimit).toBe(24);
      expect(mockState.channelAgentModelOverrideModel).toEqual({ id: 'gpt-5.2', provider: 'openai' });
    });
  });

  describe('openChannel', () => {
    it('shows cached group messages immediately and refreshes the cache from channel details', async () => {
      mockState.channels = [{
        id: 'ch1',
        name: 'general',
        members: ['agent-a'],
        lastMessage: 'cached',
        lastSender: 'agent-a',
        lastTimestamp: '2026-05-13 10:00',
        newMessageCount: 1,
        roleCounts: { project_manager: 0, admin: 0, worker: 1 },
      }];
      mockState.channelMessageCache = {
        ch1: [{ sender: 'agent-a', timestamp: '2026-05-13 09:59', body: 'cached' }],
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: 'general',
          description: 'team channel',
          members: ['agent-a'],
          messages: [{ sender: 'agent-a', timestamp: '2026-05-13 10:00', body: 'fresh' }],
          roleCounts: { project_manager: 0, admin: 0, worker: 1 },
        }),
      } as Response);

      const { openChannel } = await import('../../stores/channel-actions');
      await openChannel('ch1');

      expect(setStateCalls[0]).toMatchObject({
        currentChannel: 'ch1',
        channelHeaderName: '# general',
        channelMessages: [{ sender: 'agent-a', timestamp: '2026-05-13 09:59', body: 'cached' }],
      });
      expect(mockState.channelMessages).toEqual([
        { sender: 'agent-a', timestamp: '2026-05-13 10:00', body: 'fresh' },
      ]);
      expect((mockState.channelMessageCache as Record<string, unknown>).ch1).toEqual([
        { sender: 'agent-a', timestamp: '2026-05-13 10:00', body: 'fresh' },
      ]);
    });

    it('opens DM channels with the owner agent route query', async () => {
      mockState.channels = [{
        id: 'dm:peer-1',
        name: 'Peer One',
        members: ['peer-1'],
        lastMessage: '',
        lastSender: '',
        lastTimestamp: '',
        newMessageCount: 0,
        isDM: true,
        dmOwnerId: 'owner-1',
        peerId: 'peer-1',
        peerName: 'Peer One',
      }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ownerAgentId: 'owner-1',
          peerId: 'peer-1',
          peerName: 'Peer One',
          messages: [],
        }),
      } as Response);

      const { openChannel } = await import('../../stores/channel-actions');
      await openChannel('dm:peer-1', true);

      expect(mockFetch.mock.calls[0][0]).toBe('/api/dm/peer-1?agentId=owner-1');
      expect(mockState.channelHeaderName).toBe('Peer One');
    });

    it('hydrates the first available channel when the channel tab has no active channel', async () => {
      mockState.currentTab = 'channels';
      mockState.currentChannel = null;
      mockState.channels = [{
        id: 'ch1',
        name: 'general',
        members: ['agent-a'],
        lastMessage: '',
        lastSender: '',
        lastTimestamp: '',
        newMessageCount: 0,
        isDM: false,
      }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: 'general',
          description: 'team channel',
          members: ['agent-a'],
          messages: [{ sender: 'agent-a', timestamp: '2026-05-13 10:00', body: 'fresh' }],
          roleCounts: { project_manager: 0, admin: 0, worker: 1 },
        }),
      } as Response);

      const { hydrateCurrentChannelIfNeeded } = await import('../../stores/channel-actions');
      await hydrateCurrentChannelIfNeeded();

      expect(mockFetch).toHaveBeenCalledWith('/api/channels/ch1');
      expect(mockState.currentChannel).toBe('ch1');
      expect(mockState.channelHeaderName).toBe('# general');
      expect(mockState.channelMessages).toEqual([
        { sender: 'agent-a', timestamp: '2026-05-13 10:00', body: 'fresh' },
      ]);
    });

    it('hydrates the first available channel when the active channel is stale after re-enable', async () => {
      mockState.currentTab = 'channels';
      mockState.currentChannel = 'ch-stale';
      mockState.channels = [{
        id: 'ch1',
        name: 'general',
        members: ['agent-a'],
        lastMessage: '',
        lastSender: '',
        lastTimestamp: '',
        newMessageCount: 0,
        isDM: false,
      }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: 'general',
          description: 'team channel',
          members: ['agent-a'],
          messages: [{ sender: 'agent-a', timestamp: '2026-05-13 10:00', body: 'fresh' }],
          roleCounts: { project_manager: 0, admin: 0, worker: 1 },
        }),
      } as Response);

      const { hydrateCurrentChannelIfNeeded } = await import('../../stores/channel-actions');
      await hydrateCurrentChannelIfNeeded();

      expect(mockFetch).toHaveBeenCalledWith('/api/channels/ch1');
      expect(mockState.currentChannel).toBe('ch1');
      expect(mockState.channelHeaderName).toBe('# general');
      expect(mockState.channelMessages).toEqual([
        { sender: 'agent-a', timestamp: '2026-05-13 10:00', body: 'fresh' },
      ]);
    });
  });

  describe('appendChannelMessage', () => {
    it('appends messages for the current channel, clears unread, and marks the message as read', async () => {
      mockState.currentChannel = 'ch1';
      mockState.channelMessages = [{ sender: 'hana', timestamp: '2026-05-13 10:00', body: 'old' }];
      mockState.channels = [{
        id: 'ch1',
        name: 'general',
        members: ['hana'],
        lastMessage: 'old',
        lastSender: 'hana',
        lastTimestamp: '2026-05-13 10:00',
        newMessageCount: 2,
      }];
      mockState.channelTotalUnread = 2;
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);

      const { appendChannelMessage } = await import('../../stores/channel-actions');
      appendChannelMessage('ch1', { sender: 'hana', timestamp: '2026-05-13 10:01', body: 'new' });

      expect((mockState.channelMessages as Array<{ body: string }>).map(m => m.body)).toEqual(['old', 'new']);
      expect((mockState.channels as Array<{ newMessageCount: number }>)[0].newMessageCount).toBe(0);
      expect(mockState.channelTotalUnread).toBe(0);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/channels/ch1/read',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ timestamp: '2026-05-13 10:01' }),
        }),
      );
    });

    it('increments unread count and moves background channels to the top on new messages', async () => {
      mockState.currentChannel = 'ch1';
      mockState.channels = [
        {
          id: 'ch1',
          name: 'current',
          members: [],
          lastMessage: 'current',
          lastSender: 'user',
          lastTimestamp: '2026-05-13 10:00',
          newMessageCount: 0,
        },
        {
          id: 'ch2',
          name: 'background',
          members: [],
          lastMessage: 'older',
          lastSender: 'hana',
          lastTimestamp: '2026-05-13 09:00',
          newMessageCount: 1,
        },
      ];
      mockState.channelTotalUnread = 1;

      const { appendChannelMessage } = await import('../../stores/channel-actions');
      appendChannelMessage('ch2', { sender: 'hana', timestamp: '2026-05-13 10:02', body: 'background new' });

      const channels = mockState.channels as Array<{ id: string; lastMessage: string; newMessageCount: number }>;
      expect(channels[0].id).toBe('ch2');
      expect(channels[0].lastMessage).toBe('background new');
      expect(channels[0].newMessageCount).toBe(2);
      expect(mockState.channelTotalUnread).toBe(2);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('toggleChannelsEnabled', () => {
    it('toggles the channel enabled state', async () => {
      mockState.channelsEnabled = true;

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ channels: [] }),
      } as Response);

      const { toggleChannelsEnabled } = await import('../../stores/channel-actions');
      const result = await toggleChannelsEnabled();

      expect(result).toBe(false); // toggled from true to false
      //
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/channels/toggle'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('reloads and opens a channel after channels are re-enabled', async () => {
      mockState.channelsEnabled = false;
      mockState.currentTab = 'channels';
      mockState.currentChannel = null;

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ok: true, enabled: true }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            channels: [{
              id: 'ch1',
              name: 'general',
              members: ['agent-a'],
              lastMessage: '',
              lastSender: '',
              lastTimestamp: '',
              newMessageCount: 0,
            }],
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ dms: [] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: 'general',
            description: 'team channel',
            members: ['agent-a'],
            messages: [{ sender: 'agent-a', timestamp: '2026-05-13 10:00', body: 'fresh' }],
            roleCounts: { project_manager: 0, admin: 0, worker: 1 },
          }),
        } as Response);

      const { toggleChannelsEnabled } = await import('../../stores/channel-actions');
      const result = await toggleChannelsEnabled();

      expect(result).toBe(true);
      expect(mockFetch.mock.calls[0][0]).toBe('/api/channels/toggle');
      expect(mockState.channelsEnabled).toBe(true);
      expect(mockState.currentChannel).toBe('ch1');
      expect(mockState.channelHeaderName).toBe('# general');
      expect(mockState.channelMessages).toEqual([
        { sender: 'agent-a', timestamp: '2026-05-13 10:00', body: 'fresh' },
      ]);
    });
  });

  describe('group roles', () => {
    it('createChannel sends member role payload', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'ch-build' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ channels: [] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ dms: [] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: 'Build',
            messages: [],
            members: ['pm-1', 'worker-1'],
            memberRoles: { 'pm-1': 'project_manager', 'worker-1': 'worker' },
            roleCounts: { project_manager: 1, admin: 0, worker: 1 },
          }),
        } as Response);

      const { createChannel } = await import('../../stores/channel-actions');
      await createChannel(
        'Build',
        ['pm-1', 'worker-1'],
        { 'pm-1': 'project_manager', 'worker-1': 'worker' },
      );

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(String((options as RequestInit).body));
      expect(body.memberRoles).toEqual({
        'pm-1': 'project_manager',
        'worker-1': 'worker',
      });
    });

    it('createChannel accepts the original UI signature with intro as the third argument', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'ch-design' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ channels: [] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ dms: [] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: 'Design',
            messages: [],
            members: ['agent-a', 'agent-b'],
          }),
        } as Response);

      const { createChannel } = await import('../../stores/channel-actions');
      await createChannel('Design', ['agent-a', 'agent-b'], 'original intro');

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(String((options as RequestInit).body));
      expect(body.intro).toBe('original intro');
      expect(body.memberRoles).toBeUndefined();
    });

    it('createChannelAgent posts to the group-agent endpoint and refreshes agents', async () => {
      mockState.currentChannel = 'ch-build';
      mockState.deskBasePath = 'E:/workspace/build';
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ agent: { id: 'agent-worker-a', name: 'Worker A' } }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            channels: [{
              id: 'ch-build',
              name: 'Build',
              members: ['pm-1', 'agent-worker-a'],
              memberRoles: { 'pm-1': 'project_manager', 'agent-worker-a': 'worker' },
              roleCounts: { project_manager: 1, admin: 0, worker: 1 },
              newMessageCount: 0,
            }],
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ dms: [] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: 'Build',
            description: 'ship it',
            messages: [],
            members: ['pm-1', 'agent-worker-a'],
            memberRoles: { 'pm-1': 'project_manager', 'agent-worker-a': 'worker' },
            roleCounts: { project_manager: 1, admin: 0, worker: 1 },
          }),
        } as Response);

      const { createChannelAgent } = await import('../../stores/channel-actions');
      const created = await createChannelAgent('ch-build', {
        name: 'Worker A',
        role: 'worker',
      });

      expect(created).toEqual({ id: 'agent-worker-a', name: 'Worker A' });
      expect(loadAgentsMock).toHaveBeenCalled();
      expect(String(mockFetch.mock.calls[0][0])).toContain('/api/channels/ch-build/agents');
      expect(JSON.parse(String((mockFetch.mock.calls[0][1] as RequestInit).body))).toMatchObject({
        name: 'Worker A',
        role: 'worker',
        homeFolder: 'E:/workspace/build',
      });
    });

    it('addChannelMember posts to the member endpoint and refreshes current channel members', async () => {
      mockState.currentChannel = 'ch-build';
      mockState.channelMembers = ['pm-1', 'admin-1'];
      mockState.channels = [{
        id: 'ch-build',
        name: 'Build',
        members: ['pm-1', 'admin-1'],
        lastMessage: '',
        lastSender: '',
        lastTimestamp: '',
        newMessageCount: 0,
      }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          members: ['pm-1', 'admin-1', 'agent-c'],
          memberRoles: { 'pm-1': 'project_manager', 'admin-1': 'admin', 'agent-c': 'worker' },
          roleCounts: { project_manager: 1, admin: 1, worker: 1 },
        }),
      } as Response);

      const { addChannelMember } = await import('../../stores/channel-actions');
      await addChannelMember('ch-build', 'agent-c');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/channels/ch-build/members',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ memberId: 'agent-c' }),
        }),
      );
      expect(mockState.channelMembers).toEqual(['pm-1', 'admin-1', 'agent-c']);
      expect(mockState.channelMemberRoles).toEqual({
        'pm-1': 'project_manager',
        'admin-1': 'admin',
        'agent-c': 'worker',
      });
      expect((mockState.channels as Array<{ members: string[] }>)[0].members).toEqual(['pm-1', 'admin-1', 'agent-c']);
      expect((mockState.channels as Array<{ roleCounts?: Record<string, number> }>)[0].roleCounts).toEqual({
        project_manager: 1,
        admin: 1,
        worker: 1,
      });
    });

    it('removeChannelMember posts to the member delete endpoint and refreshes current channel members', async () => {
      mockState.currentChannel = 'ch-build';
      mockState.channelMembers = ['pm-1', 'admin-1', 'agent-c'];
      mockState.channels = [{
        id: 'ch-build',
        name: 'Build',
        members: ['pm-1', 'admin-1', 'agent-c'],
        lastMessage: '',
        lastSender: '',
        lastTimestamp: '',
        newMessageCount: 0,
      }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          members: ['pm-1', 'admin-1'],
          memberRoles: { 'pm-1': 'project_manager', 'admin-1': 'admin' },
          roleCounts: { project_manager: 1, admin: 1, worker: 0 },
        }),
      } as Response);

      const { removeChannelMember } = await import('../../stores/channel-actions');
      await removeChannelMember('ch-build', 'agent-c');

      expect(mockFetch).toHaveBeenCalledWith('/api/channels/ch-build/members/agent-c', { method: 'DELETE' });
      expect(mockState.channelMembers).toEqual(['pm-1', 'admin-1']);
      expect(mockState.channelMemberRoles).toEqual({
        'pm-1': 'project_manager',
        'admin-1': 'admin',
      });
      expect((mockState.channels as Array<{ members: string[] }>)[0].members).toEqual(['pm-1', 'admin-1']);
      expect((mockState.channels as Array<{ roleCounts?: Record<string, number> }>)[0].roleCounts).toEqual({
        project_manager: 1,
        admin: 1,
        worker: 0,
      });
    });
  });
});
