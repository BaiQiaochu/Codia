import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";

const MAIN_PATH = path.join(process.cwd(), "desktop", "main.cjs");

describe("desktop onboarding completion contract", () => {
  it("does not write setupComplete directly from desktop main", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).not.toMatch(/setupComplete\s*=\s*true/);
  });

  it("opens the main window only after the server accepts setup completion", async () => {
    const { completeOnboardingAndOpenMain } = await import("../desktop/src/shared/onboarding-completion.cjs");
    const createMainWindow = vi.fn();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, setupComplete: true }),
    }));

    await completeOnboardingAndOpenMain({
      serverPort: 14500,
      serverToken: "token",
      createMainWindow,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:14500/api/preferences/setup-complete",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer token" },
      }),
    );
    expect(createMainWindow).toHaveBeenCalledTimes(1);
  });

  it("rejects and keeps the main window closed when setup completion persistence fails", async () => {
    const { completeOnboardingAndOpenMain } = await import("../desktop/src/shared/onboarding-completion.cjs");
    const createMainWindow = vi.fn();
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "setupComplete read-back verification failed" }),
    }));

    await expect(completeOnboardingAndOpenMain({
      serverPort: 14500,
      serverToken: "token",
      createMainWindow,
      fetchImpl,
    })).rejects.toThrow(/read-back verification failed/);

    expect(createMainWindow).not.toHaveBeenCalled();
  });

  it("rejects and keeps the main window closed when server does not confirm setupComplete", async () => {
    const { completeOnboardingAndOpenMain } = await import("../desktop/src/shared/onboarding-completion.cjs");
    const createMainWindow = vi.fn();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, setupComplete: false }),
    }));

    await expect(completeOnboardingAndOpenMain({
      serverPort: 14500,
      serverToken: "token",
      createMainWindow,
      fetchImpl,
    })).rejects.toThrow(/not persisted/);

    expect(createMainWindow).not.toHaveBeenCalled();
  });
});
