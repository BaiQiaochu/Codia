export const BUILTIN_PROVIDER_DEFAULTS = {
  ghssd: {
    imageRoute: "images",
    imageInputField: "images[].image_url",
    format: "png",
    quality: "high",
  },
};

export function providerDefaultsFor(allDefaults = {}, providerId = "") {
  const id = String(providerId || "").trim();
  const builtin = BUILTIN_PROVIDER_DEFAULTS[id] || {};
  const configured = allDefaults?.[id] || {};
  return { ...builtin, ...configured };
}
