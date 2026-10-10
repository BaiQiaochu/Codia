export interface SettingsSearchNavItem {
  id: string;
  label: string;
  categoryLabel?: string;
}

export interface SettingsSearchEntry {
  id: string;
  tabId: string;
  titleKey?: string;
  title?: string;
  pathKeys?: string[];
  path?: string[];
  aliases?: string[];
}

export interface SettingsSearchResult {
  id: string;
  tabId: string;
  title: string;
  path: string;
  score: number;
}

type Translate = (key: string) => string;

const BUILT_IN_SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    id: 'agent-profile',
    tabId: 'agent',
    titleKey: 'settings.tabs.agent',
    pathKeys: ['settings.tabs.agent'],
    aliases: ['assistant', 'agent', 'role', 'avatar', 'memory', 'profile'],
  },
  {
    id: 'me-profile',
    tabId: 'me',
    titleKey: 'settings.tabs.me',
    pathKeys: ['settings.tabs.me'],
    aliases: ['me', 'user', 'identity', 'profile'],
  },
  {
    id: 'interface-theme',
    tabId: 'about',
    titleKey: 'settings.appearance.theme',
    pathKeys: ['settings.tabs.general'],
    aliases: ['theme', 'appearance', 'color', 'dark mode', 'paper'],
  },
  {
    id: 'interface-typography',
    tabId: 'about',
    titleKey: 'settings.appearance.chatLayout',
    pathKeys: ['settings.tabs.general'],
    aliases: ['font', 'typography', 'markdown font', 'reading width', 'chat width', 'body size'],
  },
  {
    id: 'interface-language',
    tabId: 'about',
    titleKey: 'settings.locale.language',
    pathKeys: ['settings.tabs.general'],
    aliases: ['language', 'locale', 'timezone', 'region'],
  },
  {
    id: 'general-startup',
    tabId: 'about',
    titleKey: 'settings.general.startup.title',
    pathKeys: ['settings.tabs.general'],
    aliases: ['startup', 'launch at login', 'keep awake', 'background'],
  },
  {
    id: 'browser-cookies',
    tabId: 'browser',
    titleKey: 'settings.browser.cookiesTitle',
    pathKeys: ['settings.tabs.browser'],
    aliases: ['browser', 'cookies', 'site data', 'clear cookies'],
  },
  {
    id: 'work-home-folder',
    tabId: 'work',
    titleKey: 'settings.work.homeFolder',
    pathKeys: ['settings.tabs.work'],
    aliases: ['workspace', 'home folder', 'workbench', 'working directory', 'agents md', 'project'],
  },
  {
    id: 'skills-management',
    tabId: 'skills',
    titleKey: 'settings.skills.title',
    pathKeys: ['settings.tabs.skills'],
    aliases: ['skills', 'capabilities', 'install skill'],
  },
  {
    id: 'mcp-connectors',
    tabId: 'mcp',
    titleKey: 'settings.tabs.mcp',
    pathKeys: ['settings.tabs.mcp'],
    aliases: ['mcp', 'connector', 'connectors', 'tool server'],
  },
  {
    id: 'bridge-platforms',
    tabId: 'bridge',
    titleKey: 'settings.tabs.bridge',
    pathKeys: ['settings.tabs.bridge'],
    aliases: ['bridge', 'dingtalk', 'feishu', 'wechat', 'qq mail', 'agent mail', 'social', 'integration'],
  },
  {
    id: 'providers-search',
    tabId: 'providers',
    titleKey: 'settings.api.searchProvider',
    pathKeys: ['settings.tabs.providers'],
    aliases: ['search', 'web search', 'search provider', 'search engine', 'tavily', 'brave', 'serper'],
  },
  {
    id: 'providers-api-key',
    tabId: 'providers',
    titleKey: 'settings.api.apiKey',
    pathKeys: ['settings.tabs.providers'],
    aliases: ['api key', 'apikey', 'token', 'provider key', 'openai key', 'secret'],
  },
  {
    id: 'providers-models',
    tabId: 'providers',
    titleKey: 'settings.api.mainModelSection',
    pathKeys: ['settings.tabs.providers'],
    aliases: ['model', 'models', 'provider', 'base url', 'context length', 'reasoning effort'],
  },
  {
    id: 'media-production',
    tabId: 'media',
    titleKey: 'settings.media.imageGeneration',
    pathKeys: ['settings.tabs.media'],
    aliases: ['media', 'image generation', 'document image', 'cover image', 'speech recognition', 'audio'],
  },
  {
    id: 'sharing-output',
    tabId: 'sharing',
    titleKey: 'settings.tabs.sharing',
    pathKeys: ['settings.tabs.sharing'],
    aliases: ['share', 'screenshot', 'card', 'watermark', 'export'],
  },
  {
    id: 'access-mobile',
    tabId: 'access',
    titleKey: 'settings.access.mobileAccess',
    pathKeys: ['settings.tabs.access'],
    aliases: ['access', 'mobile', 'pwa', 'lan', 'remote', 'port', 'qr code'],
  },
  {
    id: 'plugins-management',
    tabId: 'plugins',
    titleKey: 'settings.plugins.manageTitle',
    pathKeys: ['settings.tabs.plugins'],
    aliases: ['plugin', 'plugins', 'marketplace', 'dev tools', 'full access'],
  },
  {
    id: 'context-management',
    tabId: 'context',
    titleKey: 'settings.tabs.context',
    pathKeys: ['settings.tabs.context'],
    aliases: ['context', 'compression', 'compaction', '上下文', '压缩'],
  },
  {
    id: 'computer-use',
    tabId: 'computer',
    titleKey: 'settings.tabs.computerUse',
    pathKeys: ['settings.tabs.computerUse'],
    aliases: ['computer use', 'computer control', 'desktop control', '电脑控制', '计算机使用'],
  },
  {
    id: 'diagnostics-operations',
    tabId: 'diagnostics',
    titleKey: 'settings.tabs.diagnostics',
    pathKeys: ['settings.tabs.diagnostics'],
    aliases: ['diagnostics', 'diagnosis', 'logs', 'health', 'operations', 'preflight'],
  },
  {
    id: 'security-sandbox',
    tabId: 'security',
    titleKey: 'settings.security.sandbox',
    pathKeys: ['settings.tabs.security'],
    aliases: ['sandbox', 'network sandbox', 'file backup', 'archived chats', 'proxy', 'security'],
  },
  {
    id: 'about-updates',
    tabId: 'about',
    titleKey: 'settings.about.title',
    pathKeys: ['settings.tabs.about'],
    aliases: ['about', 'version', 'update', 'professional'],
  },
];

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function translated(entry: SettingsSearchEntry, translate: Translate): { title: string; path: string } {
  const title = entry.titleKey ? translate(entry.titleKey) : entry.title || '';
  const pathParts = entry.pathKeys?.length
    ? entry.pathKeys.map(key => translate(key))
    : entry.path || (title ? [title] : []);
  return {
    title,
    path: pathParts.filter(Boolean).join(' / '),
  };
}

function scoreCandidate(query: string, fields: string[]): number {
  const normalizedFields = fields.map(normalizeSearchText).filter(Boolean);
  if (normalizedFields.length === 0) return 0;

  let best = 0;
  for (const [index, field] of normalizedFields.entries()) {
    const fieldWeight = index === 0 ? 40 : index === 1 ? 24 : 12;
    if (field === query) best = Math.max(best, 120 + fieldWeight);
    if (field.startsWith(query)) best = Math.max(best, 92 + fieldWeight);
    if (field.includes(query)) best = Math.max(best, 68 + fieldWeight);
  }

  const tokens = query.split(' ').filter(Boolean);
  if (tokens.length > 1) {
    const haystack = normalizedFields.join(' ');
    if (tokens.every(token => haystack.includes(token))) {
      best = Math.max(best, 58 + tokens.length * 4);
    }
  }

  return best;
}

function dedupeSearchResults(results: SettingsSearchResult[]): SettingsSearchResult[] {
  const seen = new Set<string>();
  return results.filter(result => {
    const key = `${result.tabId}\0${result.title}\0${result.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildSettingsSearchEntries(navItems: SettingsSearchNavItem[]): SettingsSearchEntry[] {
  const navItemsById = new Map(navItems.map(item => [item.id, item]));
  const builtInEntries = BUILT_IN_SETTINGS_SEARCH_ENTRIES.map(entry => {
    const navItem = navItemsById.get(entry.tabId);
    if (!navItem) return entry;
    return {
      ...entry,
      pathKeys: undefined,
      path: navItem.categoryLabel ? [navItem.categoryLabel, navItem.label] : [navItem.label],
    };
  });
  const navEntries = navItems.map(item => ({
    id: item.id,
    tabId: item.id,
    title: item.label,
    path: item.categoryLabel ? [item.categoryLabel, item.label] : [item.label],
    aliases: [item.id],
  }));
  const builtInIds = new Set(builtInEntries.map(entry => entry.id));
  return [
    ...builtInEntries,
    ...navEntries.filter(entry => !builtInIds.has(entry.id)),
  ];
}

export function searchSettings(
  query: string,
  entries: SettingsSearchEntry[],
  translate: Translate,
  limit = 12,
): SettingsSearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const rankedResults = entries
    .map(entry => {
      const { title, path } = translated(entry, translate);
      const fields = [title, path, ...(entry.aliases || [])];
      const score = scoreCandidate(normalizedQuery, fields);
      return { id: entry.id, tabId: entry.tabId, title, path, score };
    })
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  return dedupeSearchResults(rankedResults)
    .slice(0, limit);
}
