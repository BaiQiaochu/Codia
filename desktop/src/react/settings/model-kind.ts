export type ModelKind = 'chat' | 'image' | 'audio' | 'music' | 'video';

export const MODEL_KINDS: ModelKind[] = ['chat', 'image', 'audio', 'music', 'video'];

function normalized(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function isChatCapableFullModalModelId(modelId: string, providerId = ''): boolean {
  const id = normalized(modelId);
  if (!id) return false;
  const provider = normalized(providerId);
  if (provider.includes('comfy')) return false;

  return [
    /^gpt[-_]?4o[-_]?audio[-_]?preview(?:$|[-_])/,
    /^gpt[-_]?4o[-_]?mini[-_]?audio[-_]?preview(?:$|[-_])/,
    /^gpt[-_]?audio(?:$|[-_](?:mini|preview|latest|\d))/,
    /^gemini[-_\w.]*native[-_]?audio(?:$|[-_])/,
    /qwen[\w.-]*[-_]?omni(?:$|[-_/])/,
    /mimo[\w.-]*[-_]?omni(?:$|[-_/])/,
  ].some((pattern) => pattern.test(id));
}

export function normalizeModelKind(value: unknown): ModelKind | null {
  const kind = normalized(value);
  if (kind === 'text' || kind === 'llm') return 'chat';
  if (kind === 'voice' || kind === 'speech' || kind === 'tts' || kind === 'stt') return 'audio';
  if (kind === 'song') return 'music';
  if (kind === 'image_generation' || kind === 'text-to-image' || kind === 'txt2img') return 'image';
  if (['movie', 'video_generation', 'text-to-video', 'txt2video', 'txt2vid', 't2v', 'image-to-video', 'img2video', 'i2v'].includes(kind)) return 'video';
  return MODEL_KINDS.includes(kind as ModelKind) ? kind as ModelKind : null;
}

export function inferModelKind(modelId: string, providerId = '', explicit?: unknown): ModelKind {
  const id = normalized(modelId);
  const provider = normalized(providerId);
  if (id && isChatCapableFullModalModelId(id, provider)) return 'chat';

  const explicitKind = normalizeModelKind(explicit);
  if (explicitKind) return explicitKind;

  if (!id) return 'chat';

  if (provider.includes('comfy') && (id === 'workflow' || id.includes('workflow'))) return 'image';
  if (/video|seedance|seadance|(?:^|[-_/])sora(?:$|[-_/\d.])|(?:^|[-_/])veo(?:$|[-_/\d.])|kling|runway|ltx[-_]?video|cogvideo|wanx[-_]?video|wan[-_]?2(?:$|[-_/\d.])|text[-_]?to[-_]?video|txt[-_]?2[-_]?video|txt2video|t2v|image[-_]?to[-_]?video|img[-_]?2[-_]?video|i2v/.test(id)) return 'video';
  if (/music|song/.test(id)) return 'music';
  if (/(?:^|[-_/])tts(?:$|[-_/])|(?:^|[-_/])stt(?:$|[-_/])|speech|voice|audio/.test(id)) return 'audio';
  if (
    /gpt[-_]?image|dall[-_]?e|seedream|seededit|qwen[-_]?image|wanx|flux|stable[-_]?diffusion|sdxl|(?:^|[-_/])sd3(?:$|[-_/])|imagen|ideogram|recraft|hidream|kolors|midjourney|image[-_]?0?1|image[-_]?generation|text[-_]?to[-_]?image|txt[-_]?2[-_]?img|t2i|image[-_]?edit|img[-_]?2[-_]?img|i2i|dreamshaper|juggernaut|realvis|animagine|pony/.test(id)
  ) {
    return 'image';
  }

  return 'chat';
}

export function modelKindLabel(kind: ModelKind): string {
  switch (kind) {
    case 'image': return '\u751f\u56fe';
    case 'audio': return '\u8bed\u97f3';
    case 'music': return '\u97f3\u4e50';
    case 'video': return '\u89c6\u9891';
    default: return '\u5bf9\u8bdd';
  }
}
