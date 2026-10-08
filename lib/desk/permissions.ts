// @ts-nocheck
/**
 * Desk permission helpers.
 *
 * Backward compatibility rule:
 * - If no permission table is configured, existing agents keep full access.
 * - Once a table exists, an agent must be explicitly granted a permission.
 */

export const DeskPermission = {
  CRON: "cron",
  JIAN: "jian",
  HEARTBEAT: "heartbeat",
};

const WILDCARD_PERMISSIONS = new Set(["*", "all"]);

function normalizeList(value) {
  if (value === true) return ["*"];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
}

function permissionTable(config = {}) {
  return config?.desk?.permissions ?? config?.permissions ?? null;
}

function hasPermission(grants, permission) {
  const normalized = normalizeList(grants);
  return normalized.some((grant) => grant === permission || WILDCARD_PERMISSIONS.has(grant));
}

export function canAccess(agentId, permission, config = {}) {
  if (!permission) return false;
  const table = permissionTable(config);
  if (!table) return true;
  if (Array.isArray(table) || typeof table === "string" || table === true) {
    return hasPermission(table, permission);
  }
  if (typeof table !== "object") return false;
  const direct = agentId ? table[agentId] : undefined;
  if (direct !== undefined) return hasPermission(direct, permission);
  if (table.default !== undefined) return hasPermission(table.default, permission);
  if (table["*"] !== undefined) return hasPermission(table["*"], permission);
  return false;
}
