import type { AgentPhoneToolMode, Channel, ChannelAgentActivities, ChannelMemberRole, ChannelMessage, ChannelTickerStatusMap } from '../types';
import type { AttachedFile } from './input-slice';

export interface PendingChannelResourceAction {
  id: string;
  target: 'input' | 'workflow';
  channelId: string;
  file: AttachedFile;
}

export interface ChannelSlice {
  channels: Channel[];
  currentChannel: string | null;
  channelMessages: ChannelMessage[];
  channelMessageCache: Record<string, ChannelMessage[]>;
  channelMessageCacheDirty: Record<string, boolean>;
  channelMembers: string[];
  channelTotalUnread: number;
  channelsEnabled: boolean;
  channelHeaderName: string;
  channelHeaderMembersText: string;
  channelInfoName: string;
  channelInfoDescription: string;
  channelIsDM: boolean;
  channelMemberRoles: Record<string, ChannelMemberRole>;
  channelAgentActivities: ChannelAgentActivities;
  channelTickerStatus: ChannelTickerStatusMap;
  channelAgentPhoneToolMode: AgentPhoneToolMode;
  channelAgentReplyMinChars: number | null;
  channelAgentReplyMaxChars: number | null;
  channelAgentProactiveEnabled: boolean;
  channelAgentReminderIntervalMinutes: number;
  channelAgentGuardLimit: number;
  channelAgentModelOverrideEnabled: boolean;
  channelAgentModelOverrideModel: { id: string; provider: string } | null;
  pendingChannelResourceAction: PendingChannelResourceAction | null;
  setChannels: (channels: Channel[]) => void;
  setCurrentChannel: (channel: string | null) => void;
  setChannelMessages: (messages: ChannelMessage[]) => void;
  setChannelTotalUnread: (count: number) => void;
  setChannelsEnabled: (enabled: boolean) => void;
  setPendingChannelResourceAction: (action: PendingChannelResourceAction | null) => void;
  consumePendingChannelResourceAction: (id: string) => void;
}

export const createChannelSlice = (
  set: (partial: Partial<ChannelSlice> | ((state: ChannelSlice) => Partial<ChannelSlice>)) => void,
): ChannelSlice => ({
  channels: [],
  currentChannel: null,
  channelMessages: [],
  channelMessageCache: {},
  channelMessageCacheDirty: {},
  channelMembers: [],
  channelTotalUnread: 0,
  channelsEnabled: false,
  channelHeaderName: '',
  channelHeaderMembersText: '',
  channelInfoName: '',
  channelInfoDescription: '',
  channelIsDM: false,
  channelMemberRoles: {},
  channelAgentActivities: {},
  channelTickerStatus: {},
  channelAgentPhoneToolMode: 'read_only',
  channelAgentReplyMinChars: null,
  channelAgentReplyMaxChars: null,
  channelAgentProactiveEnabled: true,
  channelAgentReminderIntervalMinutes: 31,
  channelAgentGuardLimit: 36,
  channelAgentModelOverrideEnabled: false,
  channelAgentModelOverrideModel: null,
  pendingChannelResourceAction: null,
  setChannels: (channels) => set({ channels }),
  setCurrentChannel: (channel) => set({ currentChannel: channel }),
  setChannelMessages: (messages) => set({ channelMessages: messages }),
  setChannelTotalUnread: (count) => set({ channelTotalUnread: count }),
  setChannelsEnabled: (enabled) => set({ channelsEnabled: enabled }),
  setPendingChannelResourceAction: (action) => set({ pendingChannelResourceAction: action }),
  consumePendingChannelResourceAction: (id) =>
    set((state) => ({
      pendingChannelResourceAction: state.pendingChannelResourceAction?.id === id
        ? null
        : state.pendingChannelResourceAction,
    })),
});
