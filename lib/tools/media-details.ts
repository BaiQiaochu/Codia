import { normalizeMediaItems } from "../bridge/media-item-normalizer.ts";

export function collectMediaItems(media: unknown) {
  if (!media || typeof media !== "object") return [];
  if (Array.isArray((media as { items?: unknown }).items) && (media as { items: unknown[] }).items.length) {
    return normalizeMediaItems((media as { items: unknown[] }).items);
  }
  // COMPAT(mediaUrls, remove no earlier than v0.133):
  // New producers should return structured details.media.items. mediaUrls remains
  // only for old tool results and text-extracted Bridge media.
  if (Array.isArray((media as { mediaUrls?: unknown }).mediaUrls)) {
    return normalizeMediaItems((media as { mediaUrls: unknown[] }).mediaUrls);
  }
  return [];
}
