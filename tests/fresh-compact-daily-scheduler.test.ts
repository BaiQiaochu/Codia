// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import {
  createFreshCompactDailyScheduler,
  getNextFreshCompactDelayMs,
} from "../lib/fresh-compact/daily-scheduler.js";

describe("fresh compact daily scheduler", () => {
  it("waits until after the logical day boundary before the first run", () => {
    expect(getNextFreshCompactDelayMs(new Date(2026, 4, 15, 3, 30), {
      boundaryOffsetMs: 5 * 60 * 1000,
    })).toBe(35 * 60 * 1000);
  });

  it("runs after an idle delay once the boundary has passed", () => {
    expect(getNextFreshCompactDelayMs(new Date(2026, 4, 15, 10, 0), {
      idleDelayMs: 60_000,
    })).toBe(60_000);
  });

  it("serializes scheduler runs and schedules retry when stale targets remain", async () => {
    const timers = [];
    const clearTimer = vi.fn((timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    });
    const runDaily = vi.fn(async () => ({ staleRemaining: 1 }));
    const scheduler = createFreshCompactDailyScheduler({
      runDaily,
      getNow: () => new Date(2026, 4, 15, 10, 0),
      setTimer: (fn, delay) => {
        const timer = { fn, delay, unref: vi.fn() };
        timers.push(timer);
        return timer;
      },
      clearTimer,
      retryDelayMs: 1234,
    });

    scheduler.start();
    expect(timers[0].delay).toBe(60_000);
    const first = timers.shift();
    await first.fn();
    expect(runDaily).toHaveBeenCalledTimes(1);
    expect(timers[0].delay).toBe(1234);
    scheduler.stop();
  });
});
