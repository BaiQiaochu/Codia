export interface BrowserSlice {
  /** 按 session path 存储的 browser 状态（权威源） */
  browserBySession: Record<string, { running: boolean; url: string | null; thumbnail: string | null }>;
}

export const createBrowserSlice = (
  _set: (partial: Partial<BrowserSlice>) => void
): BrowserSlice => ({
  browserBySession: {},
});
