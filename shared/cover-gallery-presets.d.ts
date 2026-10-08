export interface CoverGalleryPreset {
  id: string;
  title: string;
  fileName: string;
  category?: string;
}

export const COVER_GALLERY_PRESETS: readonly CoverGalleryPreset[];

export function getCoverGalleryPreset(presetId: string): CoverGalleryPreset | null;

export function listCoverGalleryPresets(): readonly CoverGalleryPreset[];
