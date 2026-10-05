export const PROFESSIONAL_EDITION = "professional" as const;

export const PROFESSIONAL_DISABLED_FEATURES = Object.freeze({
  desktopPet: "desktopPet",
  live2d: "live2d",
  licenseActivation: "licenseActivation",
  licenseServer: "licenseServer",
  entertainmentCompanion: "entertainmentCompanion",
  playfulCharacterSurface: "playfulCharacterSurface",
} as const);

export type ProfessionalDisabledFeature =
  typeof PROFESSIONAL_DISABLED_FEATURES[keyof typeof PROFESSIONAL_DISABLED_FEATURES];

export function professionalFeatureDisabled(feature: ProfessionalDisabledFeature | string) {
  return {
    ok: false,
    error: "feature_disabled_in_professional_edition",
    feature,
  };
}

export function professionalEditionStatus() {
  return {
    edition: PROFESSIONAL_EDITION,
    state: "professional",
    status: "professional",
    valid: true,
    capability: "full",
    features: ["full", "professional"],
    reason: "commercial license activation is not used in this edition",
  };
}
