/**
 * Resolve textual @mentions to channel member agent IDs.
 *
 * Mentions are scheduling hints. They must not hide the channel transcript from
 * other members.
 */

function isMentionBoundary(ch) {
  return !ch || /\s|\p{P}/u.test(ch);
}

function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function findMentionRange(text, alias, usedRanges) {
  const needle = `@${alias}`;
  let start = -1;
  while ((start = text.indexOf(needle, start + 1)) !== -1) {
    const end = start + needle.length;
    const before = start > 0 ? text[start - 1] : "";
    const after = text[end] || "";
    const range = { start, end };
    if (!isMentionBoundary(before) || !isMentionBoundary(after)) continue;
    if (usedRanges.some((used) => rangesOverlap(used, range))) continue;
    return range;
  }
  return null;
}

function uniqueDisplayAliases(agent) {
  const aliases = [agent?.name, agent?.agentName]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set(aliases));
}

export function extractMentionedAgentIds(text, { channelMembers = [], agents = [] } = {}) {
  const body = String(text || "");
  if (!body.includes("@")) return [];

  const memberSet = new Set(Array.isArray(channelMembers) ? channelMembers : []);
  const memberAgents = (Array.isArray(agents) ? agents : [])
    .filter((agent) => agent?.id && memberSet.has(agent.id));

  const idAliases = new Map();
  for (const agent of memberAgents) {
    idAliases.set(agent.id, agent.id);
  }

  const displayAliases = new Map();
  for (const agent of memberAgents) {
    for (const alias of uniqueDisplayAliases(agent)) {
      if (!displayAliases.has(alias)) displayAliases.set(alias, new Set());
      displayAliases.get(alias).add(agent.id);
    }
  }

  const candidates = [];
  for (const [alias, agentId] of idAliases) {
    candidates.push({ agentId, alias });
  }
  for (const [alias, agentIds] of displayAliases) {
    if (agentIds.size !== 1) continue;
    const [agentId] = agentIds;
    const idAliasOwner = idAliases.get(alias);
    if (idAliasOwner && idAliasOwner !== agentId) continue;
    if (alias !== agentId) candidates.push({ agentId, alias });
  }

  candidates.sort((a, b) => b.alias.length - a.alias.length);

  const mentioned = [];
  const mentionedSet = new Set();
  const usedRanges = [];
  for (const candidate of candidates) {
    if (mentionedSet.has(candidate.agentId)) continue;
    const range = findMentionRange(body, candidate.alias, usedRanges);
    if (!range) continue;
    usedRanges.push(range);
    mentionedSet.add(candidate.agentId);
    mentioned.push(candidate.agentId);
  }
  return mentioned;
}
