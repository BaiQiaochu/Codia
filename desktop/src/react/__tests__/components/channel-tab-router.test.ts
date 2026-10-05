// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const hydrateCurrentChannelIfNeededMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const toggleSidebarMock = vi.hoisted(() => vi.fn());
const toggleJianSidebarMock = vi.hoisted(() => vi.fn());

vi.mock('../../stores/channel-actions', () => ({
  hydrateCurrentChannelIfNeeded: hydrateCurrentChannelIfNeededMock,
}));

vi.mock('../../components/SidebarLayout', () => ({
  toggleSidebar: toggleSidebarMock,
}));

vi.mock('../../stores/desk-actions', () => ({
  toggleJianSidebar: toggleJianSidebarMock,
}));

describe('channel tab router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useStore.setState({
      currentTab: 'channels',
      sidebarOpen: true,
      jianOpen: true,
      activePanel: 'activity',
    } as never);
  });

  it('rehydrates channels when reopening the already-active channel tab', async () => {
    const { switchTab } = await import('../../components/channels/tab-router');

    switchTab('channels');

    expect(useStore.getState().currentTab).toBe('channels');
    expect(useStore.getState().activePanel).toBeNull();
    expect(hydrateCurrentChannelIfNeededMock).toHaveBeenCalledTimes(1);
  });
});
