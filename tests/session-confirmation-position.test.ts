import { describe, expect, it } from "vitest";
import { calculateSessionConfirmationMenuPosition } from "../desktop/src/react/components/input/session-confirmation-position.ts";

describe("session confirmation menu positioning", () => {
  it("keeps the confirmation menu inside the reader chat column", () => {
    const result = calculateSessionConfirmationMenuPosition({
      anchorRect: { top: 720, right: 316, bottom: 748, left: 240, width: 76, height: 28 },
      panelRect: { top: 0, right: 0, bottom: 0, left: 0, width: 180, height: 40 },
      boundsRect: { top: 36, right: 320, bottom: 800, left: 180, width: 140, height: 764 },
      viewportWidth: 1200,
      viewportHeight: 800,
    });

    expect(result.left).toBeGreaterThanOrEqual(188);
    expect(result.left + result.maxWidth).toBeLessThanOrEqual(312);
  });

  it("falls back to viewport bounds when no chat column is supplied", () => {
    const result = calculateSessionConfirmationMenuPosition({
      anchorRect: { top: 720, right: 1188, bottom: 748, left: 1112, width: 76, height: 28 },
      panelRect: { top: 0, right: 0, bottom: 0, left: 0, width: 180, height: 40 },
      viewportWidth: 1200,
      viewportHeight: 800,
    });

    expect(result.left + result.maxWidth).toBeLessThanOrEqual(1192);
    expect(result.top).toBeLessThan(720);
  });
});
