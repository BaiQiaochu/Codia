import { describe, expect, it, vi } from "vitest";
import { AutomationSuggestionStore } from "../lib/tools/automation-suggestion-store.ts";

describe("AutomationSuggestionStore", () => {
  it("stores scoped automation suggestions and applies the newest scoped entry", async () => {
    const applyOlder = vi.fn(async () => ({ id: "old-job" }));
    const applyNewer = vi.fn(async () => ({ id: "new-job" }));
    const store = new AutomationSuggestionStore({
      generateShortCode: vi.fn()
        .mockReturnValueOnce("1001")
        .mockReturnValueOnce("1002"),
    });

    store.create({
      sessionPath: "/sessions/a.jsonl",
      bridgeSessionKey: "wx_dm_owner@a",
      operation: "create",
      jobData: { label: "Older draft" },
      apply: applyOlder,
    });
    const newer = store.create({
      sessionPath: "/sessions/a.jsonl",
      bridgeSessionKey: "wx_dm_owner@a",
      operation: "update",
      jobData: { label: "Newer draft" },
      apply: applyNewer,
    });

    expect(store.list({ bridgeSessionKey: "wx_dm_owner@a" }).map((entry) => entry.shortCode))
      .toEqual(["1001", "1002"]);

    const result = await store.apply({
      bridgeSessionKey: "wx_dm_owner@a",
      value: { jobData: { label: "Edited" } },
    });

    expect(result).toMatchObject({
      ok: true,
      suggestion: {
        suggestionId: newer.suggestionId,
        shortCode: "1002",
        operation: "update",
      },
      result: { id: "new-job" },
    });
    expect(applyNewer).toHaveBeenCalledWith({ jobData: { label: "Edited" } });
    expect(applyOlder).not.toHaveBeenCalled();
    expect(store.get("1002")).toBeNull();
  });

  it("matches explicit short code within the current bridge scope", async () => {
    const apply = vi.fn(async () => ({ id: "created-job" }));
    const store = new AutomationSuggestionStore({ generateShortCode: () => "3827" });
    store.create({
      sessionPath: "/sessions/a.jsonl",
      bridgeSessionKey: "tg_dm_owner@a",
      operation: "create",
      jobData: { label: "Morning Review" },
      apply,
    });

    const result = await store.apply({ bridgeSessionKey: "tg_dm_owner@a", ref: "3827" });

    expect(result.ok).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    await expect(store.apply({ bridgeSessionKey: "other", ref: "3827" }))
      .resolves.toEqual({ ok: false, reason: "not-found" });
  });
});
