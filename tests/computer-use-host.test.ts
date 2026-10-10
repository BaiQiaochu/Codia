import { describe, expect, it } from "vitest";
import { ComputerHost } from "../core/computer-use/computer-host.js";
import { ComputerProviderRegistry } from "../core/computer-use/provider-registry.js";
import { createMockComputerProvider } from "../core/computer-use/providers/mock-provider.js";
import { COMPUTER_USE_ERRORS } from "../core/computer-use/errors.ts";

function makeHost(provider = createMockComputerProvider({ providerId: "mock" })) {
  const providers = new ComputerProviderRegistry();
  providers.register(provider);
  return {
    host: new ComputerHost({
      providers,
      defaultProviderId: "mock",
      getSettings: () => ({ enabled: true }),
    }),
    provider,
  };
}

const ctx = {
  sessionPath: "/tmp/session.jsonl",
  agentId: "codia",
  model: { id: "gpt-5.5", provider: "openai", input: ["text", "image"] },
};

describe("ComputerHost", () => {
  it("blocks text-only models before creating a lease", async () => {
    const { host } = makeHost();
    await expect(host.createLease({
      ...ctx,
      model: { id: "deepseek-v4-pro", provider: "deepseek", input: ["text"] },
    }, { appId: "app.notes" })).rejects.toMatchObject({
      code: COMPUTER_USE_ERRORS.REQUIRES_VISION_MODEL,
    });
  });

  it("creates a lease and returns a snapshot with screenshot content", async () => {
    const { host } = makeHost();
    const lease = await host.createLease(ctx, { appId: "app.notes", windowId: "win-1" });
    const snapshot = await host.getAppState(ctx, lease.leaseId);

    expect(snapshot).toMatchObject({
      leaseId: lease.leaseId,
      providerId: "mock",
      mode: "vision-native",
      appId: "app.notes",
      allowedActions: expect.arrayContaining(["click_element"]),
    });
    expect(snapshot.snapshotId).toBeTruthy();
    expect(snapshot.screenshot.type).toBe("image");
  });

  it("selects a platform provider from settings and keeps provider-owned state on the lease", async () => {
    const providers = new ComputerProviderRegistry();
    providers.register(createMockComputerProvider({ providerId: "mock" }));
    providers.register(createMockComputerProvider({ providerId: "windows:uia" }));
    const host = new ComputerHost({
      providers,
      defaultProviderId: "mock",
      platform: "win32",
      getSettings: () => ({ enabled: true, provider_by_platform: { win32: "windows:uia" } }),
    });

    const status = await host.getStatus(ctx);
    const lease = await host.createLease(ctx, { appId: "app.notes" });

    expect(status.selectedProviderId).toBe("windows:uia");
    expect(lease.providerId).toBe("windows:uia");
    expect(lease.providerState).toMatchObject({ mock: true });
  });

  it("selects the Linux xdotool provider by default when it is available", async () => {
    const providers = new ComputerProviderRegistry();
    providers.register(createMockComputerProvider({ providerId: "mock" }));
    providers.register(createMockComputerProvider({ providerId: "linux:xdotool" }));
    const host = new ComputerHost({
      providers,
      defaultProviderId: "mock",
      platform: "linux",
      getSettings: () => ({ enabled: true }),
    });

    const status = await host.getStatus(ctx);
    const lease = await host.createLease(ctx, { appId: "app.notes" });

    expect(status.selectedProviderId).toBe("linux:xdotool");
    expect(lease.providerId).toBe("linux:xdotool");
  });

  it("rejects stale snapshot actions", async () => {
    const { host } = makeHost();
    const lease = await host.createLease(ctx, { appId: "app.notes" });
    await host.getAppState(ctx, lease.leaseId);

    await expect(host.performAction(ctx, lease.leaseId, {
      type: "click_element",
      snapshotId: "old",
      elementId: "mock-button",
    })).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.STALE_SNAPSHOT });
  });

  it("rejects unsupported provider capabilities", async () => {
    const provider = createMockComputerProvider({ providerId: "mock" });
    provider.capabilities.elementActions = false;
    const { host } = makeHost(provider);
    const lease = await host.createLease(ctx, { appId: "app.notes" });
    const snapshot = await host.getAppState(ctx, lease.leaseId);

    await expect(host.performAction(ctx, lease.leaseId, {
      type: "click_element",
      snapshotId: snapshot.snapshotId,
      elementId: "mock-button",
    })).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.CAPABILITY_UNSUPPORTED });
  });

  it("requires app approval for non-isolated providers and accepts window targets", async () => {
    const provider = createMockComputerProvider({ providerId: "mock" });
    provider.capabilities.isolated = false;
    const providers = new ComputerProviderRegistry();
    providers.register(provider);
    const host = new ComputerHost({
      providers,
      defaultProviderId: "mock",
      getSettings: () => ({ enabled: true }),
    });

    await expect(host.createLease(ctx, { windowId: "101" }))
      .rejects.toMatchObject({
        code: COMPUTER_USE_ERRORS.APP_APPROVAL_REQUIRED,
        details: { appId: "window:101" },
      });
  });

  it("allows non-isolated providers after app approval", async () => {
    const provider = createMockComputerProvider({ providerId: "mock" });
    provider.capabilities.isolated = false;
    const providers = new ComputerProviderRegistry();
    providers.register(provider);
    const host = new ComputerHost({
      providers,
      defaultProviderId: "mock",
      getSettings: () => ({
        enabled: true,
        app_approvals: [{ providerId: "mock", appId: "app.notes", approvedAt: "2026-05-01T00:00:00.000Z" }],
      }),
    });

    const lease = await host.createLease(ctx, { appId: "app.notes" });
    expect(lease.providerId).toBe("mock");
  });

  it("fails closed when the global switch is off", async () => {
    const providers = new ComputerProviderRegistry();
    providers.register(createMockComputerProvider({ providerId: "mock" }));
    const host = new ComputerHost({
      providers,
      defaultProviderId: "mock",
      getSettings: () => ({ enabled: false }),
    });

    const status = await host.getStatus(ctx);
    expect(status.enabled).toBe(false);
    await expect(host.listApps(ctx)).rejects.toMatchObject({
      code: COMPUTER_USE_ERRORS.DISABLED,
      details: { reason: "global-disabled" },
    });
  });

  it("blocks computer use in read-only sessions", async () => {
    const providers = new ComputerProviderRegistry();
    providers.register(createMockComputerProvider({ providerId: "mock" }));
    const host = new ComputerHost({
      providers,
      defaultProviderId: "mock",
      getSettings: () => ({ enabled: true }),
      getAccessMode: () => "read_only",
    });

    await expect(host.listApps(ctx)).rejects.toMatchObject({
      code: COMPUTER_USE_ERRORS.DISABLED,
      details: { reason: "read-only-session" },
    });
  });

  it("passes snapshot-bound element metadata to providers before element actions", async () => {
    const { host, provider } = makeHost();
    const lease = await host.createLease(ctx, { appId: "app.notes" });
    const snapshot = await host.getAppState(ctx, lease.leaseId);

    await host.performAction(ctx, lease.leaseId, {
      type: "click_element",
      snapshotId: snapshot.snapshotId,
      elementId: "mock-button",
    });

    expect(provider.actions.at(-1)).toMatchObject({
      action: {
        type: "click_element",
        snapshotId: snapshot.snapshotId,
        elementId: "mock-button",
        snapshotElement: {
          elementId: "mock-button",
          role: "button",
          label: "Continue",
        },
        snapshotDisplay: { width: 800, height: 600, scaleFactor: 1 },
      },
    });
  });
});
