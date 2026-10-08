type Translator = (key: string, vars?: Record<string, string | number>) => string;

const INPUT_PLACEHOLDER_FALLBACKS: Record<string, string> = {
  en: 'Say something...',
  ja: 'なにか話しかけてみてください...',
  ko: '무슨 이야기든 해보세요...',
  'zh-tw': '說點什麼...',
  zh: '说点什么...',
};

function translated(value: string | null | undefined, key: string): string | null {
  if (!value || value === key || value.startsWith(`${key}.`)) return null;
  return value;
}

export function fallbackInputPlaceholder(locale?: string | null): string {
  const normalized = String(locale || '').trim().toLowerCase();
  if (normalized.startsWith('zh-tw') || normalized.startsWith('zh-hk')) {
    return INPUT_PLACEHOLDER_FALLBACKS['zh-tw'];
  }
  const lang = normalized.split(/[-_]/)[0];
  return INPUT_PLACEHOLDER_FALLBACKS[lang] || INPUT_PLACEHOLDER_FALLBACKS.zh;
}

export function resolveInputPlaceholder({
  agentYuan,
  locale,
  t,
}: {
  agentYuan?: string | null;
  locale?: string | null;
  t?: Translator | null;
}): string {
  const translate = typeof t === 'function' ? t : ((key: string) => key);
  const yuanKey = `yuan.placeholder.${agentYuan || 'gsap'}`;
  const yuanPlaceholder = translated(translate(yuanKey), yuanKey);
  if (yuanPlaceholder) return yuanPlaceholder;

  return translated(translate('input.placeholder'), 'input.placeholder')
    || fallbackInputPlaceholder(locale);
}
