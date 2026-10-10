const SETTINGS_ROUTE_ALIASES: Record<string, string> = {
  general: 'about',
  interface: 'about',
  license: 'diagnostics',
  search: 'providers',
  experiments: 'context',
};

export function normalizeSettingsRouteId(tab?: string | null): string {
  const route = String(tab || 'agent').trim() || 'agent';
  return SETTINGS_ROUTE_ALIASES[route] || route;
}
