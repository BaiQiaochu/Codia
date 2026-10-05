import type { ChannelMemberRole } from '../../types';

export const CHANNEL_ROLE_OPTIONS: ChannelMemberRole[] = [
  'project_manager',
  'admin',
  'worker',
];

export const CHANNEL_ROLE_LABELS: Record<ChannelMemberRole, string> = {
  project_manager: '项目经理',
  admin: '管理员',
  worker: '工人',
};

export function normalizeChannelMemberRole(role?: string | null): ChannelMemberRole {
  return CHANNEL_ROLE_OPTIONS.includes(role as ChannelMemberRole)
    ? (role as ChannelMemberRole)
    : 'worker';
}

export function buildDefaultChannelMemberRoles(memberIds: string[]): Record<string, ChannelMemberRole> {
  const uniqIds = [...new Set(memberIds.filter(Boolean))];
  return Object.fromEntries(
    uniqIds.map((memberId, index) => [
      memberId,
      index === 0 ? 'project_manager' : index === 1 ? 'admin' : 'worker',
    ]),
  );
}

export function ensureChannelMemberRoles(
  memberIds: string[],
  roles: Record<string, ChannelMemberRole> = {},
): Record<string, ChannelMemberRole> {
  const uniqIds = [...new Set(memberIds.filter(Boolean))];
  const defaults = buildDefaultChannelMemberRoles(uniqIds);
  const normalized = Object.fromEntries(
    uniqIds.map((memberId) => [memberId, normalizeChannelMemberRole(roles[memberId] || defaults[memberId])]),
  ) as Record<string, ChannelMemberRole>;

  if (uniqIds.length > 0 && !Object.values(normalized).includes('project_manager')) {
    normalized[uniqIds[0]] = 'project_manager';
  }

  return normalized;
}

export function suggestChannelMemberRole(
  memberIds: string[],
  roles: Record<string, ChannelMemberRole>,
): ChannelMemberRole {
  const normalized = ensureChannelMemberRoles(memberIds, roles);
  const existingRoles = Object.values(normalized);
  if (!existingRoles.includes('project_manager')) return 'project_manager';
  if (!existingRoles.includes('admin')) return 'admin';
  return 'worker';
}

export function countChannelRoles(
  roles: Record<string, ChannelMemberRole>,
): Record<ChannelMemberRole, number> {
  return {
    project_manager: Object.values(roles).filter((role) => role === 'project_manager').length,
    admin: Object.values(roles).filter((role) => role === 'admin').length,
    worker: Object.values(roles).filter((role) => role === 'worker').length,
  };
}

export function getChannelRoleLabel(role: ChannelMemberRole): string {
  const translated = window.t?.(`channel.roles.${role}`);
  return translated && translated !== `channel.roles.${role}` ? translated : CHANNEL_ROLE_LABELS[role];
}
