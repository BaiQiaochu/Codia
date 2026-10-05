// @ts-nocheck
function formatDate(value) {
  if (!value) return "";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return String(value);
  return time.toLocaleString();
}

export function selectSession(sessions, target) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  if (!target) return sessions[0] || null;

  const trimmed = String(target).trim();
  const maybeIndex = Number.parseInt(trimmed, 10);
  if (String(maybeIndex) === trimmed && maybeIndex > 0) {
    return sessions[maybeIndex - 1] || null;
  }

  return sessions.find((session) => session.path === trimmed || session.id === trimmed) || null;
}

export function formatSessionLine(session, index) {
  const title = session?.title || session?.firstMessage || "Untitled";
  const agent = session?.agentName || session?.agentId || "Agent";
  const modified = formatDate(session?.modified);
  return `${String(index).padStart(2, " ")}. ${String(title).slice(0, 72)} - ${agent}${modified ? ` - ${modified}` : ""}`;
}
