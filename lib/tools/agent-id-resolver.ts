/**
 * Resolve a user/LLM supplied agent identifier to a real agent id.
 *
 * The prompt roster shows both ids and display names. Prefer exact id matches,
 * then allow a unique display-name fallback so tool calls do not fail when the
 * model accidentally uses the visible name.
 */

/**
  *
 * @param {string|undefined} raw
 * @returns {{ ok: true, agentId: string|undefined } | { ok: false, ambiguous: boolean, byName: Array }}
 */
export function resolveAgentParam(agents, raw) {
  if (!raw) return { ok: true, agentId: undefined };

  const byId = agents.find(a => a.id === raw);
  if (byId) return { ok: true, agentId: byId.id };

  const byName = agents.filter(a => a.name === raw);
  if (byName.length === 1) return { ok: true, agentId: byName[0].id };

  return { ok: false, ambiguous: byName.length > 1, byName };
}
