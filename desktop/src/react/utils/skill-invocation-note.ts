/** Remove the internal skill-selection envelope from user-visible text.
 *
 * Skill selection is sent alongside the prompt so the model can load the
 * selected SKILL.md. Older sessions may have persisted that envelope as part
 * of the raw user turn, so the renderer must also clean it when rebuilding
 * history.
 */
const SKILL_INVOCATION_NOTE_RE = /<available_skills>[\s\S]*?<\/available_skills>\s*<selected-skills>[\s\S]*?<\/selected-skills>\s*/gi;

export function parseSkillInvocationNote(value: unknown): { text: string; skills: string[] } {
  if (typeof value !== 'string') return { text: '', skills: [] };
  const skills = new Set<string>();
  const text = value.replace(SKILL_INVOCATION_NOTE_RE, envelope => {
    const available = envelope.slice(0, envelope.indexOf('</available_skills>'));
    for (const match of available.matchAll(/^[\t ]*-[\t ]+name:[\t ]+([^\r\n]+)\r?$/gm)) {
      const name = match[1].trim();
      if (name) skills.add(name);
    }
    return '';
  }).trim();
  return { text, skills: [...skills] };
}

export function stripSkillInvocationNote(value: unknown): string {
  return parseSkillInvocationNote(value).text;
}
