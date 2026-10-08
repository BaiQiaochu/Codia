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

describe('file-only onboarding completion intent', () => {
  it('sends the explicit mode to the authenticated server and opens only after persistence', async () => {
    const { completeOnboardingAndOpenMain } = await import('../desktop/src/shared/onboarding-completion.cjs');
    const createMainWindow = vi.fn();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, setupComplete: true, setupMode: 'files-only' }) }));
    await completeOnboardingAndOpenMain({ serverPort: 14500, serverToken: 'token', mode: 'files-only', createMainWindow, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:14500/api/preferences/setup-complete', {
      method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'files-only' }),
    });
    expect(createMainWindow).toHaveBeenCalledOnce();
  });

  it('rejects unsupported modes without opening a window or sending a request', async () => {
    const { completeOnboardingAndOpenMain } = await import('../desktop/src/shared/onboarding-completion.cjs');
    const createMainWindow = vi.fn();
    const fetchImpl = vi.fn();
    await expect(completeOnboardingAndOpenMain({ serverPort: 14500, serverToken: 'token', mode: 'fake-auth', createMainWindow, fetchImpl })).rejects.toThrow('Invalid setup mode');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(createMainWindow).not.toHaveBeenCalled();
  });
});
