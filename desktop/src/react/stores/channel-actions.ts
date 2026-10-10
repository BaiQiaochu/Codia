/**
 * Channel side-effect actions.
 *
 * These helpers keep channel network requests and store synchronization outside
 * the Zustand slice definition.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- API JSON payloads and catch(err: any) */

import { useStore } from './index';
import { codiaFetch } from '../hooks/use-codia-fetch';
import { loadAgents } from './agent-actions';
import { hasServerConnection } from '../services/server-connection';
import type { AgentPhoneActivity, AgentPhoneSettings, AgentPhoneToolMode, Channel, ChannelAgentActivities, ChannelMemberRole, ChannelMessage } from '../types';
import type { ContentBlock, ResourceEnvelope } from './chat-types';

function normalizeArray<T = any>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') return Object.values(value as Record<string, T>);
  return [];
}

function formatRoleSummary(roleCounts: Partial<Record<ChannelMemberRole, number>> = {}): string {
  const t = window.t;
  const parts = [
    roleCounts.project_manager ? `${t('channel.roleShort.projectManager')} ${roleCounts.project_manager}` : '',
    roleCounts.admin ? `${t('channel.roleShort.admin')} ${roleCounts.admin}` : '',
    roleCounts.worker ? `${t('channel.roleShort.worker')} ${roleCounts.worker}` : '',
  ].filter(Boolean);
  return parts.join(' / ');
}

function buildChannelHeaderMembersText(memberCount: number, roleCounts: Partial<Record<ChannelMemberRole, number>> = {}): string {
  const t = window.t;
  const base = `${memberCount} ${t('channel.membersCount')}`;
  const summary = formatRoleSummary(roleCounts);
  return summary ? `${base} / ${summary}` : base;
}

export async function loadChannels(): Promise<void> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  try {
    const [chRes, dmRes] = await Promise.all([
      codiaFetch('/api/channels'),
      codiaFetch('/api/dm'),
    ]);

    const chData = chRes.ok ? await chRes.json() : { channels: [] };
    const dmData = dmRes.ok ? await dmRes.json() : { dms: [] };

    const channels: Channel[] = normalizeArray(chData.channels).map((ch: any) => ({
      ...ch,
      isDM: false,
    }));

    const dms: Channel[] = normalizeArray(dmData.dms).map((dm: any) => {
      const dmOwnerId = dm.ownerAgentId || dmData.ownerAgentId || undefined;
      return {
        id: `dm:${dm.peerId}`,
        name: dm.peerName || dm.peerId,
        members: [dm.peerId],
        lastMessage: dm.lastMessage || '',
        lastSender: dm.lastSender || '',
        lastTimestamp: dm.lastTimestamp || '',
        newMessageCount: 0,
        messageCount: dm.messageCount || 0,
        isDM: true,
        dmOwnerId,
        peerId: dm.peerId,
        peerName: dm.peerName,
      };
    });

    const allChannels = [...channels, ...dms];
    const totalUnread = allChannels.reduce((sum, ch) => sum + (ch.newMessageCount || 0), 0);
    useStore.setState({ channels: allChannels, channelTotalUnread: totalUnread });
  } catch (err) {
    console.error('[channels] load failed:', err);
  }
}

function keyActivities(activities: AgentPhoneActivity[] | Record<string, AgentPhoneActivity>): Record<string, AgentPhoneActivity[]> {
  const keyed: Record<string, AgentPhoneActivity[]> = {};
  for (const activity of normalizeArray<AgentPhoneActivity>(activities)) {
    if (!activity?.agentId) continue;
    keyed[activity.agentId] = [activity];
  }
  return keyed;
}

export async function loadConversationAgentActivities(conversationId: string): Promise<void> {
  const s = useStore.getState();
  if (!conversationId || !hasServerConnection(s)) return;
  try {
    const res = await codiaFetch(`/api/conversations/${encodeURIComponent(conversationId)}/agent-activities`);
    if (!res?.ok) return;
    const data = await res.json();
    const activities = keyActivities(data.activities);
    const latestState = useStore.getState();
    const current = (latestState.channelAgentActivities || {}) as ChannelAgentActivities;
    useStore.setState({
      channelAgentActivities: {
        ...current,
        [conversationId]: activities,
      },
      channelTickerStatus: {
        ...(latestState.channelTickerStatus || {}),
        [conversationId]: data.ticker || null,
      },
    });
  } catch (err) {
    console.error('[channels] load agent activities failed:', err);
  }
}

export function upsertConversationAgentActivity(activity: AgentPhoneActivity): void {
  if (!activity?.conversationId || !activity.agentId) return;
  const state = useStore.getState();
  const current = (state.channelAgentActivities || {}) as ChannelAgentActivities;
  const byAgent = current[activity.conversationId] || {};
  const history = byAgent[activity.agentId] || [];
  const nextHistory = [
    activity,
    ...history.filter((item: AgentPhoneActivity) =>
      item.timestamp !== activity.timestamp || item.state !== activity.state || item.summary !== activity.summary),
  ].slice(0, 20);

  useStore.setState({
    channelAgentActivities: {
      ...current,
      [activity.conversationId]: {
        ...byAgent,
        [activity.agentId]: nextHistory,
      },
    },
  });
}

function normalizeAgentPhoneToolMode(mode: unknown): AgentPhoneToolMode {
  return mode === 'write' ? 'write' : 'read_only';
}

function conversationOwnerQuery(conversationId: string): string {
  if (!conversationId.startsWith('dm:')) return '';
  const channel = useStore.getState().channels.find((ch: Channel) => ch.id === conversationId);
  return channel?.dmOwnerId ? `?agentId=${encodeURIComponent(channel.dmOwnerId)}` : '';
}

function conversationPhoneSettingsUrl(conversationId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/agent-phone-settings${conversationOwnerQuery(conversationId)}`;
}

function normalizeNullablePositiveInt(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

function normalizeAgentPhoneSettings(data: any): AgentPhoneSettings {
  const overrideModel = data?.modelOverrideModel;
  return {
    mode: normalizeAgentPhoneToolMode(data?.mode),
    replyMinChars: normalizeNullablePositiveInt(data?.replyMinChars),
    replyMaxChars: normalizeNullablePositiveInt(data?.replyMaxChars),
    proactiveEnabled: data?.proactiveEnabled !== false,
    reminderIntervalMinutes: normalizeNullablePositiveInt(data?.reminderIntervalMinutes) || 31,
    guardLimit: normalizeNullablePositiveInt(data?.guardLimit) || 36,
    modelOverrideEnabled: data?.modelOverrideEnabled === true,
    modelOverrideModel: overrideModel?.id && overrideModel?.provider
      ? { id: String(overrideModel.id), provider: String(overrideModel.provider) }
      : null,
  };
}

function applyAgentPhoneSettings(settings: AgentPhoneSettings): void {
  useStore.setState({
    channelAgentPhoneToolMode: settings.mode,
    channelAgentReplyMinChars: settings.replyMinChars,
    channelAgentReplyMaxChars: settings.replyMaxChars,
    channelAgentProactiveEnabled: settings.proactiveEnabled,
    channelAgentReminderIntervalMinutes: settings.reminderIntervalMinutes,
    channelAgentGuardLimit: settings.guardLimit,
    channelAgentModelOverrideEnabled: settings.modelOverrideEnabled,
    channelAgentModelOverrideModel: settings.modelOverrideModel,
  });
}

function defaultAgentPhoneSettings(): AgentPhoneSettings {
  return {
    mode: 'read_only',
    replyMinChars: null,
    replyMaxChars: null,
    proactiveEnabled: true,
    reminderIntervalMinutes: 31,
    guardLimit: 36,
    modelOverrideEnabled: false,
    modelOverrideModel: null,
  };
}

export async function loadConversationAgentPhoneToolMode(conversationId: string): Promise<void> {
  await loadConversationAgentPhoneSettings(conversationId);
}

export async function loadConversationAgentPhoneSettings(conversationId: string): Promise<void> {
  const s = useStore.getState();
  if (!conversationId || !hasServerConnection(s)) return;
  try {
    const res = await codiaFetch(conversationPhoneSettingsUrl(conversationId));
    if (!res?.ok) {
      applyAgentPhoneSettings(defaultAgentPhoneSettings());
      return;
    }
    const data = await res.json();
    applyAgentPhoneSettings(normalizeAgentPhoneSettings(data));
  } catch (err) {
    console.error('[channels] load phone settings failed:', err);
    applyAgentPhoneSettings(defaultAgentPhoneSettings());
  }
}

export async function setConversationAgentPhoneToolMode(mode: AgentPhoneToolMode): Promise<void> {
  await saveConversationAgentPhoneSettings({ mode });
}

export async function saveConversationAgentPhoneSettings(patch: Partial<AgentPhoneSettings>): Promise<void> {
  const s = useStore.getState();
  const conversationId = s.currentChannel;
  if (!conversationId || !hasServerConnection(s)) return;
  const res = await codiaFetch(conversationPhoneSettingsUrl(conversationId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: patch.mode !== undefined ? normalizeAgentPhoneToolMode(patch.mode) : s.channelAgentPhoneToolMode,
      replyMinChars: patch.replyMinChars !== undefined ? patch.replyMinChars : s.channelAgentReplyMinChars,
      replyMaxChars: patch.replyMaxChars !== undefined ? patch.replyMaxChars : s.channelAgentReplyMaxChars,
      proactiveEnabled: patch.proactiveEnabled !== undefined ? patch.proactiveEnabled : s.channelAgentProactiveEnabled,
      reminderIntervalMinutes: patch.reminderIntervalMinutes !== undefined ? patch.reminderIntervalMinutes : s.channelAgentReminderIntervalMinutes,
      guardLimit: patch.guardLimit !== undefined ? patch.guardLimit : s.channelAgentGuardLimit,
      modelOverrideEnabled: patch.modelOverrideEnabled !== undefined ? patch.modelOverrideEnabled : s.channelAgentModelOverrideEnabled,
      modelOverrideModel: patch.modelOverrideModel !== undefined ? patch.modelOverrideModel : s.channelAgentModelOverrideModel,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  applyAgentPhoneSettings(normalizeAgentPhoneSettings(data));
}

export async function openChannel(channelId: string, isDM?: boolean): Promise<void> {
  const s = useStore.getState();
  const ch = s.channels.find((c: Channel) => c.id === channelId);
  const isThisDM = isDM ?? ch?.isDM ?? false;
  const cachedMessages = s.channelMessageCache[channelId] || [];

  // Switch immediately and show cached or empty data while fresh channel data loads.
  const peerId = isThisDM ? (ch?.peerId || channelId.replace('dm:', '')) : '';
  const peerName = isThisDM ? (ch?.name || peerId) : '';
  const dmOwnerId = isThisDM ? ch?.dmOwnerId : undefined;
  const members = Array.isArray(ch?.members) ? ch.members : [];
  const displayMembers = [s.userName || 'user', ...members];
  useStore.setState({
    currentChannel: channelId,
    channelMessages: cachedMessages,
    channelMembers: isThisDM ? [peerId] : members,
    channelHeaderName: isThisDM ? peerName : `# ${ch?.name || channelId}`,
    channelHeaderMembersText: isThisDM ? '' : buildChannelHeaderMembersText(displayMembers.length, ch?.roleCounts || {}),
    channelIsDM: isThisDM,
    channelInfoName: isThisDM ? peerName : (ch?.name || channelId),
    channelInfoDescription: isThisDM ? '' : (ch?.description || ''),
    channelMemberRoles: isThisDM ? {} : (ch?.memberRoles || {}),
  });

  try {
    if (isThisDM) {
      const ownerQuery = dmOwnerId ? `?agentId=${encodeURIComponent(dmOwnerId)}` : '';
      const res = await codiaFetch(`/api/dm/${encodeURIComponent(peerId)}${ownerQuery}`);
      if (res.ok) {
        const data = await res.json();
        if (useStore.getState().currentChannel !== channelId) return;
        const messages = normalizeArray<ChannelMessage>(data.messages);
        const responseOwnerId = data.ownerAgentId || dmOwnerId;
        const fresh = useStore.getState();
        useStore.setState({
          channelMessages: messages,
          channelMessageCache: {
            ...fresh.channelMessageCache,
            [channelId]: messages,
          },
          channelMessageCacheDirty: {
            ...fresh.channelMessageCacheDirty,
            [channelId]: false,
          },
          channelHeaderName: data.peerName || peerName,
          channelInfoName: data.peerName || peerName,
          channels: responseOwnerId
            ? fresh.channels.map((channel: Channel) =>
              channel.id === channelId ? { ...channel, dmOwnerId: responseOwnerId } : channel)
            : fresh.channels,
        });
      }
      // 404 means there is no DM history; base info was already set above.
    } else {
      const res = await codiaFetch(`/api/channels/${encodeURIComponent(channelId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (useStore.getState().currentChannel !== channelId) return;
      const members = normalizeArray<string>(data.members);
      const displayMembers = [useStore.getState().userName || 'user', ...members];
      const messages = normalizeArray<ChannelMessage>(data.messages);
      const fresh = useStore.getState();
      useStore.setState({
        channelMessages: messages,
        channelMessageCache: {
          ...fresh.channelMessageCache,
          [channelId]: messages,
        },
        channelMessageCacheDirty: {
          ...fresh.channelMessageCacheDirty,
          [channelId]: false,
        },
        channelMembers: members,
        channelMemberRoles: data.memberRoles || {},
        channelHeaderName: `# ${data.name || channelId}`,
        channelHeaderMembersText: buildChannelHeaderMembersText(displayMembers.length, data.roleCounts || {}),
        channelIsDM: false,
        channelInfoName: data.name || channelId,
        channelInfoDescription: data.description || '',
      });

      // Mark as read
      const msgs = messages;
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg) {
        Promise.resolve(codiaFetch(`/api/channels/${encodeURIComponent(channelId)}/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: lastMsg.timestamp }),
        })).catch((err: unknown) => console.warn('[channel-actions] mark-as-read failed', err));

        // Read fresh state after await to avoid overwriting concurrent updates.
        const fresh = useStore.getState();
        const freshCh = fresh.channels.find((c: Channel) => c.id === channelId);
        if (freshCh) {
          const newTotal = Math.max(0, fresh.channelTotalUnread - (freshCh.newMessageCount || 0));
          const updatedChannels = fresh.channels.map((c: Channel) =>
            c.id === channelId ? { ...c, newMessageCount: 0 } : c,
          );
          useStore.setState({ channelTotalUnread: newTotal, channels: updatedChannels });
        }
      }
    }
  } catch (err) {
    console.error('[channels] open failed:', err);
  }

  if (useStore.getState().currentChannel === channelId) {
    loadConversationAgentActivities(channelId).catch((err: unknown) =>
      console.warn('[channel-actions] load agent activities failed', err));
    loadConversationAgentPhoneToolMode(channelId).catch((err: unknown) =>
      console.warn('[channel-actions] load phone tool mode failed', err));
  }
}

export async function hydrateCurrentChannelIfNeeded(): Promise<void> {
  const state = useStore.getState();
  const channelId = state.currentChannel;
  const firstChannel = state.channels.find((item: Channel) => item?.id);
  if (!channelId) {
    if (state.currentTab !== 'channels') return;
    if (!firstChannel) return;
    await openChannel(firstChannel.id, firstChannel.isDM);
    return;
  }
  const channel = state.channels.find((item: Channel) => item.id === channelId);
  if (!channel) {
    if (state.currentTab !== 'channels' || !firstChannel) return;
    await openChannel(firstChannel.id, firstChannel.isDM);
    return;
  }
  const cached = state.channelMessageCache[channelId];
  const dirty = state.channelMessageCacheDirty[channelId] === true;
  if (cached) {
    useStore.setState({ channelMessages: cached });
  }
  if (cached && !dirty) return;
  await openChannel(channelId, channel.isDM);
}

function resourcesFromBlocks(blocks: readonly ContentBlock[]): ResourceEnvelope[] {
  const resources: ResourceEnvelope[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.type !== 'file' || !block.resource) continue;
    const key = block.resource.resourceId || block.resource.fileId || block.fileId || block.filePath;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    resources.push(block.resource);
  }
  return resources;
}

export async function sendChannelMessage(
  text: string,
  options: { blocks?: ContentBlock[]; resources?: ResourceEnvelope[] } = {},
): Promise<void> {
  const s = useStore.getState();
  const body = String(text || '').trim();
  const blocks = Array.isArray(options.blocks)
    ? options.blocks.filter((block): block is ContentBlock => !!block && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string')
    : [];
  const resources = [
    ...(Array.isArray(options.resources) ? options.resources : []),
    ...resourcesFromBlocks(blocks),
  ].filter((resource): resource is ResourceEnvelope => (
    !!resource && typeof resource === 'object' && typeof resource.resourceId === 'string'
  ));
  if ((!body && blocks.length === 0 && resources.length === 0) || !s.currentChannel) return;

  try {
    const res = await codiaFetch(`/api/channels/${encodeURIComponent(s.currentChannel)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body,
        ...(blocks.length > 0 ? { blocks } : {}),
        ...(resources.length > 0 ? { resources } : {}),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok && data.timestamp) {
      const fresh = useStore.getState();
      appendChannelMessage(s.currentChannel, {
        sender: fresh.userName || 'user',
        timestamp: data.timestamp,
        body,
        ...(blocks.length > 0 ? { blocks } : {}),
        ...(resources.length > 0 ? { resources } : {}),
      }, { markRead: false, countUnread: false });
    }
  } catch (err) {
    console.error('[channels] send failed:', err);
  }
}

export async function deleteChannel(channelId: string): Promise<void> {
  const s = useStore.getState();
  try {
    const res = await codiaFetch(`/api/channels/${encodeURIComponent(channelId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      if (s.currentChannel === channelId) {
        useStore.setState({
          currentChannel: null,
          channelMessages: [],
          channelMessageCache: {
            ...useStore.getState().channelMessageCache,
            [channelId]: [],
          },
          channelMessageCacheDirty: {
            ...useStore.getState().channelMessageCacheDirty,
            [channelId]: false,
          },
          channelHeaderName: '',
          channelHeaderMembersText: '',
          channelIsDM: false,
          channelInfoDescription: '',
          channelMemberRoles: {},
        });
      }
      // Reload channels
      await loadChannels();
    } else {
      console.error('[channels] delete failed:', data.error);
    }
  } catch (err) {
    console.error('[channels] delete failed:', err);
  }
}

export async function toggleChannelsEnabled(): Promise<boolean> {
  const s = useStore.getState();
  const newEnabled = !s.channelsEnabled;
  useStore.setState({ channelsEnabled: newEnabled });

  try {
    await codiaFetch('/api/channels/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newEnabled }),
    });
    if (newEnabled) {
      await loadChannels();
      await hydrateCurrentChannelIfNeeded();
    }
  } catch (err) {
    console.error('[channels] toggle backend failed:', err);
    useStore.setState({ channelsEnabled: s.channelsEnabled });
    return s.channelsEnabled;
  }

  return newEnabled;
}

export async function createChannel(
  name: string,
  members: string[],
  memberRolesOrIntro?: Record<string, ChannelMemberRole> | string,
  intro?: string,
): Promise<string | null> {
  try {
    const memberRoles = typeof memberRolesOrIntro === 'string' ? undefined : memberRolesOrIntro;
    const normalizedIntro = typeof memberRolesOrIntro === 'string' ? memberRolesOrIntro : intro;
    const res = await codiaFetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        members,
        memberRoles,
        intro: normalizedIntro || undefined,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    await loadChannels();
    if (data.id) {
      await openChannel(data.id);
    }
    return data.id || null;
  } catch (err: any) {
    console.error('[channels] create failed:', err);
    throw err;
  }
}

export async function updateChannelMemberRole(
  channelId: string,
  memberId: string,
  role: ChannelMemberRole,
): Promise<void> {
  try {
    const res = await codiaFetch(`/api/channels/${encodeURIComponent(channelId)}/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId, role }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadChannels();
    if (useStore.getState().currentChannel === channelId) {
      await openChannel(channelId);
    }
  } catch (err) {
    console.error('[channels] update role failed:', err);
    throw err;
  }
}

export async function createChannelAgent(
  channelId: string,
  payload: { name: string; yuan?: string; role: ChannelMemberRole },
): Promise<{ id: string; name: string }> {
  try {
    const s = useStore.getState();
    const homeFolder = s.deskBasePath || s.selectedFolder || s.homeFolder || undefined;
    const res = await codiaFetch(`/api/channels/${encodeURIComponent(channelId)}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        ...(homeFolder ? { homeFolder } : {}),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    await loadAgents();
    await loadChannels();
    if (useStore.getState().currentChannel === channelId) {
      await openChannel(channelId);
    }

    if (data.agent) {
      window.platform?.settingsChanged?.('agent-created', {
        agentId: data.agent.id,
        name: data.agent.name,
      });
    }

    return data.agent;
  } catch (err) {
    console.error('[channels] create agent failed:', err);
    throw err;
  }
}

function sameChannelMessage(a: ChannelMessage, b: ChannelMessage): boolean {
  return a.sender === b.sender && a.timestamp === b.timestamp && a.body === b.body;
}

function sortChannelsByRecent(channels: Channel[]): Channel[] {
  return [...channels].sort((a, b) =>
    (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''),
  );
}

function sameCachedMessage(a: ChannelMessage, b: ChannelMessage): boolean {
  return sameChannelMessage(a, b);
}

export function markChannelMessagesDirty(channelId: string): void {
  if (!channelId) return;
  const state = useStore.getState();
  useStore.setState({
    channelMessageCacheDirty: {
      ...state.channelMessageCacheDirty,
      [channelId]: true,
    },
  });
}

export function appendChannelMessage(
  channelId: string,
  message: ChannelMessage,
  options: { markRead?: boolean; countUnread?: boolean } = { markRead: true },
): void {
  if (
    !channelId
    || typeof message?.sender !== 'string'
    || typeof message.timestamp !== 'string'
    || typeof message.body !== 'string'
  ) return;

  const state = useStore.getState();
  const isCurrentChannel = state.currentChannel === channelId;
  const cachedMessages = state.channelMessageCache[channelId];
  const baseMessages = cachedMessages || (isCurrentChannel ? state.channelMessages : []);
  const alreadyInCache = baseMessages.some((m: ChannelMessage) => sameCachedMessage(m, message));
  const nextMessages = alreadyInCache ? baseMessages : [...baseMessages, message];
  const shouldMarkRead = isCurrentChannel && options.markRead === true;
  const shouldCountUnread = !shouldMarkRead && options.countUnread !== false;
  const nextCacheDirty = state.channelMessageCacheDirty[channelId] === true
    || (!cachedMessages && !isCurrentChannel);

  let unreadDelta = 0;
  let readDelta = 0;
  const updatedChannels = state.channels.map((channel: Channel) => {
    if (channel.id !== channelId) return channel;

    const isDuplicatePreview =
      channel.lastSender === message.sender
      && channel.lastTimestamp === message.timestamp
      && channel.lastMessage === message.body.slice(0, 60);

    const previousUnread = channel.newMessageCount || 0;
    const nextUnread = shouldMarkRead
      ? 0
      : previousUnread + (shouldCountUnread && !isDuplicatePreview ? 1 : 0);

    if (shouldMarkRead) {
      readDelta = previousUnread;
    } else {
      unreadDelta += nextUnread - previousUnread;
    }

    return {
      ...channel,
      lastMessage: message.body.slice(0, 60),
      lastSender: message.sender,
      lastTimestamp: message.timestamp,
      messageCount: (channel.messageCount || 0) + (isDuplicatePreview ? 0 : 1),
      newMessageCount: nextUnread,
    };
  });

  const patch: Partial<ReturnType<typeof useStore.getState>> = {
    channels: sortChannelsByRecent(updatedChannels),
    channelMessageCache: {
      ...state.channelMessageCache,
      [channelId]: nextMessages,
    },
    channelMessageCacheDirty: {
      ...state.channelMessageCacheDirty,
      [channelId]: nextCacheDirty,
    },
    channelTotalUnread: Math.max(0, state.channelTotalUnread + unreadDelta - readDelta),
  };

  if (isCurrentChannel) {
    patch.channelMessages = nextMessages;
  }

  useStore.setState(patch);

  if (shouldMarkRead) {
    Promise.resolve(codiaFetch(`/api/channels/${encodeURIComponent(channelId)}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp: message.timestamp }),
    })).catch((err: unknown) => console.warn('[channel-actions] mark-as-read failed', err));
  }
}

function applyChannelMembers(
  channelId: string,
  members: string[],
  memberRoles: Record<string, ChannelMemberRole> = {},
  roleCounts: Record<ChannelMemberRole, number> = { project_manager: 0, admin: 0, worker: 0 },
): void {
  const state = useStore.getState();
  const isCurrentChannel = state.currentChannel === channelId;
  const displayMembers = [state.userName || 'user', ...members];
  useStore.setState({
    channelMembers: isCurrentChannel ? members : state.channelMembers,
    channelMemberRoles: isCurrentChannel ? memberRoles : state.channelMemberRoles,
    channelHeaderMembersText: isCurrentChannel
      ? buildChannelHeaderMembersText(displayMembers.length, roleCounts)
      : state.channelHeaderMembersText,
    channels: state.channels.map((channel: Channel) =>
      channel.id === channelId ? { ...channel, members, memberRoles, roleCounts } : channel,
    ),
  });
}

export async function addChannelMember(channelId: string, memberId: string): Promise<void> {
  const res = await codiaFetch(`/api/channels/${encodeURIComponent(channelId)}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  applyChannelMembers(channelId, normalizeArray<string>(data.members), data.memberRoles || {}, data.roleCounts || { project_manager: 0, admin: 0, worker: 0 });
}

export async function removeChannelMember(channelId: string, memberId: string): Promise<void> {
  const res = await codiaFetch(`/api/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(memberId)}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  applyChannelMembers(channelId, normalizeArray<string>(data.members), data.memberRoles || {}, data.roleCounts || { project_manager: 0, admin: 0, worker: 0 });
}
