import { describe, expect, it } from "vitest";
import { canAccess, DeskPermission } from "../lib/desk/permissions.js";

describe("desk permissions", () => {
  it("keeps full access when no permission table is configured", () => {
    expect(canAccess("codia", DeskPermission.CRON, {})).toBe(true);
  });

  it("requires explicit grants once a permission table exists", () => {
    const config = {
      desk: {
        permissions: {
          codia: [DeskPermission.CRON],
          helper: [],
        },
      },
    };

    expect(canAccess("codia", DeskPermission.CRON, config)).toBe(true);
    expect(canAccess("codia", DeskPermission.JIAN, config)).toBe(false);
    expect(canAccess("helper", DeskPermission.CRON, config)).toBe(false);
    expect(canAccess("missing", DeskPermission.CRON, config)).toBe(false);
  });

  it("supports default and wildcard grants", () => {
    expect(canAccess("helper", DeskPermission.JIAN, { desk: { permissions: { default: [DeskPermission.JIAN] } } })).toBe(true);
    expect(canAccess("helper", DeskPermission.HEARTBEAT, { desk: { permissions: { "*": ["*"] } } })).toBe(true);
  });
});
