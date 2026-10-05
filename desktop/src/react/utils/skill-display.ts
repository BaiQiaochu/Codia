export interface SkillDisplayMetadata {
  name: string;
  displayName?: string;
  displayNames?: Record<string, string>;
  shortDescription?: string;
  shortDescriptions?: Record<string, string>;
}

function localeCandidates(locale?: string): string[] {
  const normalized = locale?.trim() || 'zh-CN';
  const base = normalized.split('-')[0];
  return [...new Set([normalized, base, normalized === 'en' ? 'en-US' : 'zh-CN'])];
}

function localizedValue(values: Record<string, string> | undefined, locale?: string): string | null {
  if (!values) return null;
  for (const candidate of localeCandidates(locale)) {
    const value = values[candidate]?.trim();
    if (value) return value;
  }
  return null;
}

export function skillDisplayName(skill: SkillDisplayMetadata, locale?: string): string {
  return localizedValue(skill.displayNames, locale) || skill.displayName?.trim() || skill.name;
}

export function skillShortDescription(skill: SkillDisplayMetadata, locale?: string): string {
  return localizedValue(skill.shortDescriptions, locale) || skill.shortDescription?.trim() || '';
}
