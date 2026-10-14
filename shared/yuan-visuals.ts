const FALLBACK_YUAN = "codia";
const DEFAULT_ASSISTANT_AVATAR = "character-cards/codia-default-avatar.png";

export interface YuanVisual {
  yuan: string;
  symbol: string;
  moodLabel: string;
  accent: string;
  avatar: string;
}

export const YUAN_VISUALS: Readonly<Record<string, Readonly<YuanVisual>>> = Object.freeze({
  codia: Object.freeze({
    yuan: "codia",
    symbol: "\u2699",
    moodLabel: "MOOD",
    accent: "#537D96",
    avatar: DEFAULT_ASSISTANT_AVATAR,
  }),
  butter: Object.freeze({
    yuan: "butter",
    symbol: "\u2665",
    moodLabel: "PULSE",
    accent: "#A984E8",
    avatar: DEFAULT_ASSISTANT_AVATAR,
  }),
  ming: Object.freeze({
    yuan: "ming",
    symbol: "\u25C6",
    moodLabel: "REFLECT",
    accent: "#8BA4B4",
    avatar: DEFAULT_ASSISTANT_AVATAR,
  }),
  hermes: Object.freeze({
    yuan: "hermes",
    symbol: "\u25CE",
    moodLabel: "HERMES LOOP",
    accent: "#7A6FF0",
    avatar: DEFAULT_ASSISTANT_AVATAR,
  }),
  kong: Object.freeze({
    yuan: "kong",
    symbol: "\u25CF",
    moodLabel: "ORIGIN",
    accent: "#A67552",
    avatar: DEFAULT_ASSISTANT_AVATAR,
  }),
});

export function normalizeYuan(yuan?: string | null): string {
  const key = String(yuan || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(YUAN_VISUALS, key) ? key : FALLBACK_YUAN;
}

export function getYuanVisual(yuan?: string | null): Readonly<YuanVisual> {
  return YUAN_VISUALS[normalizeYuan(yuan)];
}

export function moodLabelForYuan(yuan?: string | null): string {
  const visual = getYuanVisual(yuan);
  return `${visual.symbol} ${visual.moodLabel}`;
}
