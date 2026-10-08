import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUiSlice, type UiSlice } from '../../stores/ui-slice';
import { setProductVariantForTests } from '../../product-variant';

function makeSlice(): UiSlice {
  let state: UiSlice;
  const set = (partial: Partial<UiSlice> | ((s: UiSlice) => Partial<UiSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = createUiSlice(set);
  return new Proxy({} as UiSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
    set: (_, key: string, value: unknown) => {
      state = { ...state, [key]: value };
      return true;
    },
  });
}

describe('ui-slice after reader mode removal', () => {
  beforeEach(() => {
    setProductVariantForTests('g-sap');
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
    });
  });

  it('keeps the standard surface without changing current UI layout', () => {
    const slice = makeSlice();
    slice.setCurrentTab('channels');
    slice.setJianOpen(false);
    slice.setPreviewOpen(false);
    slice.setSidebarOpen(false);
    slice.setRightWorkspaceTab('session-files');

    slice.toggleAppViewMode();

    expect(slice.appViewMode).toBe('standard');
    expect(slice.currentTab).toBe('channels');
    expect(slice.sidebarOpen).toBe(false);
    expect(slice.jianOpen).toBe(false);
    expect(slice.previewOpen).toBe(false);
    expect(slice.rightWorkspaceTab).toBe('session-files');
    expect(localStorage.setItem).toHaveBeenCalledWith('gsap-app-view-mode', 'standard');
  });

  it('normalizes a legacy runtime request without closing preview or sidebar', () => {
    const slice = makeSlice();
    slice.setCurrentTab('plugin:test-plugin');
    slice.setJianOpen(false);
    slice.setPreviewOpen(false);
    slice.setSidebarOpen(false);

    slice.setAppViewMode('obsidian');

    expect(slice.currentTab).toBe('plugin:test-plugin');
    expect(slice.appViewMode).toBe('standard');
    expect(slice.sidebarOpen).toBe(false);
    expect(slice.jianOpen).toBe(false);
    expect(slice.previewOpen).toBe(false);
    expect(slice.rightWorkspaceTab).toBe('workspace');
  });

  it('does not close an open document preview while normalizing the legacy API', () => {
    const slice = makeSlice();
    slice.setPreviewOpen(true);
    slice.setAppViewMode('obsidian');
    slice.setAppViewMode('standard');

    expect(slice.appViewMode).toBe('standard');
    expect(slice.previewOpen).toBe(true);

    slice.toggleAppViewMode();
    slice.toggleAppViewMode();

    expect(slice.appViewMode).toBe('standard');
    expect(slice.previewOpen).toBe(true);
  });

  it('migrates a stored reader-mode value to the standard surface', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => 'obsidian'),
      setItem: vi.fn(),
    });

    const slice = makeSlice();

    expect(slice.appViewMode).toBe('standard');
    expect(slice.jianOpen).toBe(true);
    expect(slice.previewOpen).toBe(false);
    expect(localStorage.setItem).toHaveBeenCalledWith('gsap-app-view-mode', 'standard');
  });

  it('keeps the right sidebar available after a legacy reader-mode request', () => {
    const slice = makeSlice();

    slice.setAppViewMode('obsidian');
    slice.setJianOpen(true);
    expect(slice.jianOpen).toBe(true);

    slice.toggleJian();
    expect(slice.jianOpen).toBe(false);
  });

  it('normalizes removed Coding Mode state to chat mode', () => {
    setProductVariantForTests('g-sap');
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => 'coding'),
      setItem: vi.fn(),
    });
    const slice = makeSlice();

    expect(slice.appViewMode).toBe('standard');
    expect(slice.jianOpen).toBe(true);
    expect(slice.previewOpen).toBe(false);

    // Runtime requests for the removed mode are treated as chat mode.
    slice.setAppViewMode('coding' as never);
    expect(slice.appViewMode).toBe('standard');

    slice.toggleAppViewMode();
    expect(slice.appViewMode).toBe('standard');
    expect(localStorage.setItem).toHaveBeenLastCalledWith('gsap-app-view-mode', 'standard');
  });
});
