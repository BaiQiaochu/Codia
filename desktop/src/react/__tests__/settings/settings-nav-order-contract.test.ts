import { describe, expect, it, vi } from 'vitest';

vi.mock('../../settings/native-settings-tabs', () => ({ getNativeSettingsTabComponent: () => null }));
import { buildSettingsCategories, findSettingsCategory, normalizeSettingsModuleId } from '../../settings/settings-navigation';

describe('settings navigation order contract', () => {
  it('groups all native modules in five categories with general and devices last', () => {
    const categories = buildSettingsCategories();
    expect(categories.map(category => [category.id, category.fallback, category.defaultTab, category.modules.map(module => module.id)])).toEqual([
      ['account-agent', '账号与助手', 'agent', ['agent', 'me']],
      ['models-capabilities', '模型与能力', 'providers', ['providers', 'context', 'media', 'skills']],
      ['work-extensions', '工作与扩展', 'work', ['work', 'browser', 'mcp', 'bridge', 'plugins']],
      ['system-security', '系统与安全', 'security', ['security', 'computer', 'diagnostics']],
      ['general-devices', '通用与设备', 'about', ['about', 'sharing', 'access']],
    ]);
    const moduleIds = categories.flatMap(category => category.modules.map(module => module.id));
    expect(new Set(moduleIds).size).toBe(moduleIds.length);
  });

  it('routes legacy settings entries to the combined general module and marketplace to plugins', () => {
    const categories = buildSettingsCategories();
    for (const legacy of ['general', 'interface', 'about']) {
      expect(normalizeSettingsModuleId(legacy)).toBe('about');
      expect(findSettingsCategory(categories, legacy).id).toBe('general-devices');
    }
    expect(normalizeSettingsModuleId('plugin-marketplace')).toBe('plugins');
    expect(findSettingsCategory(categories, 'plugin-marketplace').id).toBe('work-extensions');
    expect(findSettingsCategory(categories, 'diagnostics').id).toBe('system-security');
    expect(normalizeSettingsModuleId('experiments')).toBe('context');
    expect(findSettingsCategory(categories, 'experiments').id).toBe('models-capabilities');
    expect(findSettingsCategory(categories, 'computer').id).toBe('system-security');
  });
});
