// @ts-nocheck
/**
  *
 *
  * */

//
export const SESSION_PREFIX_MAP = [
  ["tg_dm_",       "telegram", "dm"],
  ["tg_group_",    "telegram", "group"],
  ["fs_dm_",       "feishu",   "dm"],
  ["fs_group_",    "feishu",   "group"],
  ["dt_dm_",       "dingtalk", "dm"],
  ["dt_group_",    "dingtalk", "group"],
  ["wa_dm_",       "whatsapp", "dm"],
  ["wa_group_",    "whatsapp", "group"],
  ["am_dm_",       "agentlyMail", "dm"],
  ["qq_dm_",       "qq",       "dm"],
  ["qq_group_",    "qq",       "group"],
  ["wx_dm_",       "wechat",   "dm"],
];

/** 已知平台列表（从前缀表去重） */
export const KNOWN_PLATFORMS = [...new Set(SESSION_PREFIX_MAP.map(([, p]) => p))];

/**
 *  New format: `tg_dm_123@agent` -> chatId="123", agentId="agent"
 *  Legacy format: `tg_dm_123`    -> chatId="123", agentId=null
 */
export function parseSessionKey(sessionKey) {
  for (const [prefix, platform, chatType] of SESSION_PREFIX_MAP) {
    if (sessionKey.startsWith(prefix)) {
      const tail = sessionKey.slice(prefix.length);
      const atIdx = tail.lastIndexOf("@");
      if (atIdx !== -1) {
        return { platform, chatType, chatId: tail.slice(0, atIdx), agentId: tail.slice(atIdx + 1) };
      }
      return { platform, chatType, chatId: tail, agentId: null };
    }
  }
  return { platform: "unknown", chatType: "dm", chatId: sessionKey, agentId: null };
}

/**
 * -bridge index 中按 userId 去重收集已知用户
  *
 */
export function collectKnownUsers(index) {
  const byPlatform = {};

  for (const [sessionKey, raw] of Object.entries(index)) {
    const entry = typeof raw === "string" ? { file: raw } : raw;
    if (!entry.userId) continue;

    const { platform } = parseSessionKey(sessionKey);
    if (platform === "unknown") continue;

    if (!byPlatform[platform]) byPlatform[platform] = new Map();
    const map = byPlatform[platform];
    if (!map.has(entry.userId) || entry.name) {
      map.set(entry.userId, { userId: entry.userId, name: entry.name || null });
    }
  }

  const result = {};
  for (const [platform, map] of Object.entries(byPlatform)) {
    result[platform] = [...map.values()];
  }
  return result;
}
