import type { PluginPageInfo, PluginWidgetInfo, VsCodeFileIconThemeInfo } from '../types';

export interface PluginUiSlice {
  pluginPages: PluginPageInfo[];
  pluginWidgets: PluginWidgetInfo[];
  pluginUiHostCapabilities: Record<string, string[]>;
  vscodeFileIconThemes: VsCodeFileIconThemeInfo[];
  tabOrder: string[];
  pinnedWidgets: string[];
  hiddenPluginTabs: string[];
  jianView: string;

  setPluginPages(pages: PluginPageInfo[]): void;
  setPluginWidgets(widgets: PluginWidgetInfo[]): void;
  setPluginUiHostCapabilities(grants: Record<string, string[]>): void;
  setVsCodeFileIconThemes(themes: VsCodeFileIconThemeInfo[]): void;
  setTabOrder(order: string[]): void;
  setPinnedWidgets(ids: string[]): void;
  setHiddenPluginTabs(ids: string[]): void;
  setJianView(view: string): void;
}

export const createPluginUiSlice = (
  set: (partial: Partial<PluginUiSlice>) => void,
): PluginUiSlice => ({
  pluginPages: [],
  pluginWidgets: [],
  pluginUiHostCapabilities: {},
  vscodeFileIconThemes: [],
  tabOrder: [],
  pinnedWidgets: [],
  hiddenPluginTabs: [],
  jianView: 'desk',

  setPluginPages: (pages) => set({ pluginPages: pages }),
  setPluginWidgets: (widgets) => set({ pluginWidgets: widgets }),
  setPluginUiHostCapabilities: (grants) => set({ pluginUiHostCapabilities: grants }),
  setVsCodeFileIconThemes: (themes) => set({ vscodeFileIconThemes: themes }),
  setTabOrder: (order) => set({ tabOrder: order }),
  setPinnedWidgets: (ids) => set({ pinnedWidgets: ids }),
  setHiddenPluginTabs: (ids) => set({ hiddenPluginTabs: ids }),
  setJianView: (view) => set({ jianView: view }),
});
