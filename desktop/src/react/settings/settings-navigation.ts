import type { PluginSettingsTab } from './store';
import { getNativeSettingsTabComponent } from './native-settings-tabs';
import { normalizeSettingsRouteId } from './settings-route';
export { normalizeSettingsRouteId } from './settings-route';

export type SettingsCategoryId =
  | 'account-agent'
  | 'models-capabilities'
  | 'work-extensions'
  | 'system-security'
  | 'general-devices';

export type SettingsCategoryIcon = 'account' | 'sparkle' | 'toolbox' | 'sliders' | 'shield';

export interface SettingsModuleItem {
  id: string;
  key?: string;
  fallback?: string;
  title?: PluginSettingsTab['title'];
}

export interface SettingsCategory {
  id: SettingsCategoryId;
  key: string;
  fallback: string;
  icon: SettingsCategoryIcon;
  defaultTab: string;
  modules: SettingsModuleItem[];
}

const BUILT_IN_CATEGORIES: SettingsCategory[] = [
  {
    id: 'account-agent',
    key: 'settings.categories.accountAgent',
    fallback: '账号与助手',
    icon: 'account',
    defaultTab: 'agent',
    modules: [
      { id: 'agent', key: 'settings.categories.agentSettings', fallback: '助手配置' },
      { id: 'me', key: 'settings.categories.personalProfile', fallback: '个人资料' },
    ],
  },
  {
    id: 'models-capabilities',
    key: 'settings.categories.modelsCapabilities',
    fallback: '模型与能力',
    icon: 'sparkle',
    defaultTab: 'providers',
    modules: [
      { id: 'providers', key: 'settings.categories.modelServices', fallback: '模型服务' },
      { id: 'context', key: 'settings.tabs.context', fallback: '上下文' },
      { id: 'media', key: 'settings.tabs.media', fallback: '多媒体' },
      { id: 'skills', key: 'settings.tabs.skills', fallback: '技能' },
    ],
  },
  {
    id: 'work-extensions',
    key: 'settings.categories.workExtensions',
    fallback: '工作与扩展',
    icon: 'toolbox',
    defaultTab: 'work',
    modules: [
      { id: 'work', key: 'settings.tabs.work', fallback: '工作空间' },
      { id: 'browser', key: 'settings.tabs.browser', fallback: '浏览器' },
      { id: 'mcp', key: 'settings.tabs.mcp', fallback: '连接器' },
      { id: 'bridge', key: 'settings.tabs.bridge', fallback: '社交平台' },
      { id: 'plugins', key: 'settings.tabs.plugins', fallback: '插件' },
    ],
  },
  {
    id: 'system-security',
    key: 'settings.categories.systemSecurity',
    fallback: '系统与安全',
    icon: 'shield',
    defaultTab: 'security',
    modules: [
      { id: 'security', key: 'settings.tabs.security', fallback: '安全' },
      { id: 'computer', key: 'settings.tabs.computerUse', fallback: '计算机使用' },
      { id: 'diagnostics', key: 'settings.tabs.diagnostics', fallback: '诊断' },
    ],
  },
  {
    id: 'general-devices',
    key: 'settings.categories.generalDevices',
    fallback: '通用与设备',
    icon: 'sliders',
    defaultTab: 'about',
    modules: [
      { id: 'about', key: 'settings.tabs.general', fallback: '通用' },
      { id: 'sharing', key: 'settings.tabs.sharing', fallback: '分享' },
      { id: 'access', key: 'settings.tabs.access', fallback: '访问与设备' },
    ],
  },
];

export function normalizeSettingsModuleId(tab: string): string {
  const route = normalizeSettingsRouteId(tab);
  if (route === 'plugin-marketplace') return 'plugins';
  return route;
}

export function buildSettingsCategories(pluginSettingsTabs: PluginSettingsTab[] = []): SettingsCategory[] {
  const categories = BUILT_IN_CATEGORIES.map(category => ({
    ...category,
    modules: category.modules.map(module => ({ ...module })),
  }));
  const workCategory = categories.find(category => category.id === 'work-extensions');
  if (!workCategory) return categories;

  const dynamicModules = pluginSettingsTabs
    .filter(tab => tab.nativeComponent !== 'mcp.settings')
    .filter(tab => getNativeSettingsTabComponent(tab.nativeComponent))
    .map(tab => ({ id: tab.id, title: tab.title, fallback: tab.id }));
  if (dynamicModules.length > 0) workCategory.modules.push(...dynamicModules);
  return categories;
}

export function findSettingsCategory(categories: SettingsCategory[], tab: string): SettingsCategory {
  const moduleId = normalizeSettingsModuleId(tab);
  return categories.find(category => category.modules.some(module => module.id === moduleId))
    || categories[0];
}
