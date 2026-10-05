import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  Toolbox,
  UserCircle,
} from '@phosphor-icons/react';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore, type PluginSettingsTab } from './store';
import { t } from './helpers';
import { buildSettingsSearchEntries, searchSettings } from './settings-search-index';
import {
  buildSettingsCategories,
  findSettingsCategory,
  normalizeSettingsModuleId,
  type SettingsCategory,
  type SettingsCategoryIcon,
} from './settings-navigation';
import styles from './Settings.module.css';

const CATEGORY_ICONS: Record<SettingsCategoryIcon, React.ComponentType<{ size?: number; weight?: 'regular' | 'fill' }>> = {
  account: UserCircle,
  sparkle: Sparkle,
  toolbox: Toolbox,
  sliders: SlidersHorizontal,
  shield: ShieldCheck,
};

function titleToLabel(title: PluginSettingsTab['title']): string {
  if (typeof title === 'string') return title;
  const locale = window.i18n?.locale || 'zh-CN';
  return title[locale] || title[locale.split('-')[0]] || title.zh || title.en || Object.values(title)[0] || '';
}

export function settingsCategoryLabel(category: SettingsCategory): string {
  const translated = t(category.key);
  return translated === category.key ? category.fallback : translated;
}

export function settingsModuleLabel(module: SettingsCategory['modules'][number]): string {
  if (module.title) return titleToLabel(module.title);
  if (!module.key) return module.fallback || module.id;
  const translated = t(module.key);
  return translated === module.key ? module.fallback || module.id : translated;
}

interface SettingsNavProps {
  onTabChange?: (tab: string) => void;
}

export function SettingsNav({ onTabChange }: SettingsNavProps) {
  const { activeTab, pluginSettingsTabs, set } = useSettingsStore(
    useShallow((state) => ({
      activeTab: state.activeTab,
      pluginSettingsTabs: state.pluginSettingsTabs,
      set: state.set,
    })),
  );
  const [query, setQuery] = useState('');
  const lastModuleByCategory = useRef<Record<string, string>>({});
  const categories = useMemo(() => buildSettingsCategories(pluginSettingsTabs || []), [pluginSettingsTabs]);
  const activeCategory = findSettingsCategory(categories, activeTab);
  const activeModuleId = normalizeSettingsModuleId(activeTab);

  useEffect(() => {
    if (activeCategory.modules.some(module => module.id === activeModuleId)) {
      lastModuleByCategory.current[activeCategory.id] = activeModuleId;
    }
  }, [activeCategory, activeModuleId]);

  const searchNavItems = useMemo(() => categories.flatMap(category => {
    const categoryLabel = settingsCategoryLabel(category);
    return category.modules.map(module => ({
      id: module.id,
      label: settingsModuleLabel(module),
      categoryLabel,
    }));
  }), [categories]);
  const trimmedQuery = query.trim();
  const searchEntries = useMemo(() => buildSettingsSearchEntries(searchNavItems), [searchNavItems]);
  const searchResults = useMemo(
    () => searchSettings(trimmedQuery, searchEntries, t),
    [searchEntries, trimmedQuery],
  );
  const isSearching = trimmedQuery.length > 0;

  const openTab = (tab: string) => {
    set({ activeTab: tab });
    onTabChange?.(tab);
  };

  const openCategory = (category: SettingsCategory) => {
    const remembered = lastModuleByCategory.current[category.id];
    const target = remembered && category.modules.some(module => module.id === remembered)
      ? remembered
      : category.defaultTab;
    openTab(target);
  };

  return (
    <nav className={styles['settings-nav']} aria-label={t('settings.title')}>
      <div className={styles['settings-search-shell']}>
        <svg
          className={styles['settings-search-icon']}
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          className={styles['settings-search-input']}
          type="search"
          value={query}
          placeholder={t('settings.settingsSearch.placeholder')}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('');
          }}
        />
        {query ? (
          <button
            type="button"
            className={styles['settings-search-clear']}
            onClick={() => setQuery('')}
            aria-label={t('settings.settingsSearch.clear')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12" />
              <path d="M18 6 6 18" />
            </svg>
          </button>
        ) : null}
      </div>

      {isSearching ? (
        <div className={styles['settings-search-results']} aria-label={t('settings.settingsSearch.results')}>
          <div className={styles['settings-search-results-title']}>{t('settings.settingsSearch.results')}</div>
          {searchResults.length > 0 ? searchResults.map(result => (
            <button
              key={result.id}
              type="button"
              className={styles['settings-search-result']}
              onClick={() => {
                openTab(result.tabId);
                setQuery('');
              }}
            >
              <span className={styles['settings-search-result-title']}>{result.title}</span>
              <span className={styles['settings-search-result-path']}>{result.path}</span>
            </button>
          )) : (
            <div className={styles['settings-search-empty']}>{t('settings.settingsSearch.noResults')}</div>
          )}
        </div>
      ) : (
        <div className={styles['settings-category-list']}>
          {categories.map(category => {
            const Icon = CATEGORY_ICONS[category.icon];
            const active = activeCategory.id === category.id;
            return (
              <button
                type="button"
                key={category.id}
                className={`${styles['settings-nav-item']}${active ? ` ${styles.active}` : ''}`}
                data-settings-category={category.id}
                aria-current={active ? 'page' : undefined}
                onClick={() => openCategory(category)}
              >
                <Icon size={17} weight={active ? 'fill' : 'regular'} />
                <span>{settingsCategoryLabel(category)}</span>
              </button>
            );
          })}
        </div>
      )}
    </nav>
  );
}
