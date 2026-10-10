export interface ModelCapabilityInfo {
  input?: readonly string[];
  image?: boolean;
  vision?: boolean;
  video?: boolean;
  compat?: ({
    codiaVideoInput?: boolean;
  } & Record<string, unknown>) | null;
}

const legacyVideoInputCompatKey = ['h', 'ana', 'VideoInput'].join('');

export function modelSupportsImageInput(model?: ModelCapabilityInfo | null): boolean {
  if (!model) return false;
  if (model.image === false) return false;
  if (Array.isArray(model.input)) return model.input.includes('image');
  if (model.vision === false) return false;
  return model.image === true || model.vision === true;
}

export function modelSupportsVideoInput(model?: ModelCapabilityInfo | null): boolean {
  if (!model) return false;
  if (model.video === false) return false;
  if (
    model.video === true
    || model.compat?.codiaVideoInput === true
    || model.compat?.[legacyVideoInputCompatKey] === true
  ) return true;
  return Array.isArray(model.input) && model.input.includes('video');
}
