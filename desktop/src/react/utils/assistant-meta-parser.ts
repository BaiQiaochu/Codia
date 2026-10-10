export interface AssistantMetaParts {
  text: string;
  thinking: string;
  mood: string | null;
  moodYuan: string | null;
}

const LEAKED_THINKING_PREFIX =
  /^(?:the user (?:is asking|asked|wants|said)|user (?:asks|asked|wants)|we need(?: to)?|i need to|i should|they want|this is an open-ended request|given the context|the previous turn|the request is)\b/i;

const ANSWER_BOUNDARY =
  /(^|\n)(\s*(?:(?:MOOD|MOD|PULSE|REFLECT|HERMES(?:\s+LOOP)?)(?:\s*[:.\uFF1A\u3002]|(?=\s*(?:\r?\n|$)))|<(?:mood|mod|pulse|reflect|hermes)>))/i;
const TOOL_CALL_TAG_BOUNDARY =
  /<\/?(?:tool_call|function|find|parameter\b[^>]*|tool_code)\b[^>]*>|<parameter=[^>]+>/i;
const PLAIN_REFLECT_PREFIX = /^\s*REFLECT\s*[:.\uFF1A\u3002]\s*/i;
const PLAIN_REFLECT_HEADING_PREFIX = /^\s*REFLECT\s*(?:\r?\n)+/i;
const PLAIN_MOOD_PREFIX = /^\s*(MOOD|MOD|PULSE|HERMES(?:\s+LOOP)?)\s*[:.\uFF1A\u3002]\s*/i;
const PLAIN_MOOD_HEADING_PREFIX = /^\s*(MOOD|MOD|PULSE|HERMES(?:\s+LOOP)?)\s*(?:\r?\n)+/i;
const THINK_PAIRED_RE = /<(think(?:ing)?|reflect)(?:>|<\|message\|>)([\s\S]*?)<\/\1>\s*/gi;
const THINK_OPEN_ONLY_RE = /<(?:think(?:ing)?|reflect)(?:>|<\|message\|>)\s*/gi;
const PRIVATE_TOOL_PLANNING_RE =
  /(?:`[^`]+`\s+skill\b|\bcurrent files?:\b|\bsystem prompt\b|\binternal logs?\b|\bprevious attempt\b|\bverified paths?\b|<\/?(?:tool_call|function|find|parameter\b[^>]*|tool_code)\b[^>]*>|<parameter=[^>]+>)/i;
const PRIVATE_SELF_TALK_RE =
  /\b(?:wait,|actually,|i should|i need to|i will attempt|i will try|let me|we need(?: to)?|cannot read|no such file)\b/i;

const PLAIN_MOOD_YUAN: Record<string, string> = {
  MOOD: 'codia',
  MOD: 'codia',
  PULSE: 'butter',
  HERMES: 'hermes',
  'HERMES LOOP': 'hermes',
};

export function extractThinkTags(raw: string | null | undefined): { text: string; thinking: string } {
  const thinkingParts: string[] = [];
  const text = String(raw ?? '')
    .replace(THINK_PAIRED_RE, (_match, _tag: string, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed) thinkingParts.push(trimmed);
      return '';
    })
    .replace(/<\/(?:think(?:ing)?|reflect)>\s*/gi, '')
    .replace(THINK_OPEN_ONLY_RE, '');
  return { text, thinking: thinkingParts.join('\n') };
}

function splitLeakedThinkingPreface(text: string): { text: string; thinking: string } {
  const leading = text.match(/^\s*/)?.[0] ?? '';
  const body = text.slice(leading.length);
  if (!LEAKED_THINKING_PREFIX.test(body)) {
    if (looksLikeUntaggedPrivateReasoning(body)) {
      return { text: '', thinking: body.trim() };
    }
    return { text, thinking: '' };
  }

  if (TOOL_CALL_TAG_BOUNDARY.test(body)) {
    return { text: '', thinking: body.trim() };
  }

  const boundary = body.match(ANSWER_BOUNDARY);
  if (!boundary || boundary.index == null) {
    if (looksLikeUntaggedPrivateReasoning(body)) {
      return { text: '', thinking: body.trim() };
    }
    return { text, thinking: '' };
  }

  const boundaryOffset = boundary.index + boundary[1].length;
  const thinking = body.slice(0, boundaryOffset).trim();
  const visible = body.slice(boundaryOffset).replace(/^\s+/, '');
  if (!thinking || !visible) {
    return { text, thinking: '' };
  }
  return { text: visible, thinking };
}

function looksLikeUntaggedPrivateReasoning(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;

  const lineCount = trimmed.split(/\r?\n/).filter(line => line.trim()).length;
  if (lineCount < 2 && trimmed.length < 180) return false;

  const hasPrivateToolPlanning = PRIVATE_TOOL_PLANNING_RE.test(trimmed);
  const hasSelfTalk = PRIVATE_SELF_TALK_RE.test(trimmed);
  const startsLikeReasoning = LEAKED_THINKING_PREFIX.test(trimmed);

  if (hasPrivateToolPlanning && hasSelfTalk) return true;
  if (startsLikeReasoning && (lineCount >= 2 || hasPrivateToolPlanning)) return true;
  if (hasPrivateToolPlanning && lineCount >= 4) return true;
  return false;
}

function splitPlainMood(text: string): { text: string; mood: string | null; moodYuan: string | null } {
  const inlineMatch = text.match(PLAIN_MOOD_PREFIX);
  if (inlineMatch) {
    return splitPlainMoodBody(text, inlineMatch, true);
  }

  const headingMatch = text.match(PLAIN_MOOD_HEADING_PREFIX);
  if (headingMatch) {
    return splitPlainMoodBody(text, headingMatch, false);
  }

  return { text, mood: null, moodYuan: null };
}

function splitPlainReflect(text: string): { text: string; thinking: string } {
  const inlineMatch = text.match(PLAIN_REFLECT_PREFIX);
  if (inlineMatch) {
    return splitPlainReflectBody(text, inlineMatch, true);
  }

  const headingMatch = text.match(PLAIN_REFLECT_HEADING_PREFIX);
  if (headingMatch) {
    return splitPlainReflectBody(text, headingMatch, false);
  }

  return { text, thinking: '' };
}

function splitPlainReflectBody(
  originalText: string,
  match: RegExpMatchArray,
  allowSingleLineSplit: boolean,
): { text: string; thinking: string } {
  const body = originalText.slice(match[0].length).replace(/^\s+/, '');
  if (!body.trim()) {
    return { text: originalText, thinking: '' };
  }

  const blank = body.search(/\r?\n\s*\r?\n/);
  if (blank >= 0) {
    const thinking = body.slice(0, blank).trim();
    if (thinking) {
      return {
        text: body.slice(blank).replace(/^\s+/, ''),
        thinking,
      };
    }
  }

  if (allowSingleLineSplit) {
    const lineEnd = body.search(/\r?\n/);
    if (lineEnd >= 0) {
      const thinking = body.slice(0, lineEnd).trim();
      const visible = body.slice(lineEnd).replace(/^\s+/, '');
      if (thinking && visible) {
        return { text: visible, thinking };
      }
    }
  }

  return { text: '', thinking: body.trim() };
}

function splitPlainMoodBody(
  originalText: string,
  match: RegExpMatchArray,
  allowSingleLineSplit: boolean,
): { text: string; mood: string | null; moodYuan: string | null } {
  const marker = match[1].toUpperCase();
  const body = originalText.slice(match[0].length).replace(/^\s+/, '');
  if (!body.trim()) {
    return { text: originalText, mood: null, moodYuan: null };
  }

  const blank = body.search(/\r?\n\s*\r?\n/);
  if (blank >= 0) {
    const mood = body.slice(0, blank).trim();
    if (mood) {
      return {
        text: body.slice(blank).replace(/^\s+/, ''),
        mood,
        moodYuan: PLAIN_MOOD_YUAN[marker] || 'codia',
      };
    }
  }

  if (allowSingleLineSplit) {
    const lineEnd = body.search(/\r?\n/);
    if (lineEnd >= 0) {
      const mood = body.slice(0, lineEnd).trim();
      const visible = body.slice(lineEnd).replace(/^\s+/, '');
      if (mood && visible) {
        return { text: visible, mood, moodYuan: PLAIN_MOOD_YUAN[marker] || 'codia' };
      }
    }
  }

  const mood = body.trim();
  return { text: '', mood, moodYuan: PLAIN_MOOD_YUAN[marker] || 'codia' };
}

export function splitAssistantMeta(raw: string | null | undefined): AssistantMetaParts {
  const tagged = extractThinkTags(raw);
  const leaked = splitLeakedThinkingPreface(tagged.text);
  const reflect = splitPlainReflect(leaked.text);
  const mood = splitPlainMood(reflect.text);
  const thinking = [tagged.thinking, leaked.thinking, reflect.thinking].filter(Boolean).join('\n');

  return {
    text: mood.text,
    thinking,
    mood: mood.mood,
    moodYuan: mood.moodYuan,
  };
}
