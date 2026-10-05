export interface FileMentionTriggerMatch {
  atIndex: number;
  query: string;
}

function isCjkBoundaryChar(char: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(char);
}

function isPunctuationBoundaryChar(char: string): boolean {
  return /[0-9!"#$%&'()*+,./:;<=>?[\\\]^_`{|}~-]/.test(char)
    || /[，。！？、；：（）【】《》“”‘’￥]/.test(char);
}

export function isFileMentionBoundaryChar(char: string | undefined): boolean {
  if (!char) return true;
  if (char === "@") return false;
  if (/\s/.test(char)) return true;
  if (isCjkBoundaryChar(char)) return true;
  return isPunctuationBoundaryChar(char);
}

export function findFileMentionTrigger(beforeCursorText: string): FileMentionTriggerMatch | null {
  const before = String(beforeCursorText || "");
  const atIndex = before.lastIndexOf("@");
  if (atIndex < 0) return null;
  const prevChar = atIndex > 0 ? before[atIndex - 1] : undefined;
  if (!isFileMentionBoundaryChar(prevChar)) return null;
  const query = before.slice(atIndex + 1);
  if (/[\s@]/.test(query)) return null;
  return { atIndex, query };
}
