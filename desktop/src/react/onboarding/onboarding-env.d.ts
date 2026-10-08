// Ambient declarations for onboarding module.
// These globals are injected via HTML <script> tags before React mounts.
// Centralizes what was previously repeated in each step file.

export {};

declare global {
function t(key: string, vars?: Record<string, string | number>): string;

const i18n: {
  locale: string;
  defaultName: string;
  load(locale: string): Promise<void>;
};

}
