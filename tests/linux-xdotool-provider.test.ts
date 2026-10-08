// @ts-nocheck
import fs from "fs";
import { describe, expect, it, vi } from "vitest";
import { createLinuxXdotoolProvider } from "../core/computer-use/providers/linux-xdotool-provider.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

function createRunner() {
  const calls = [];
  const runner = {
    calls,
    run: vi.fn(async (command, args = []) => {
      calls.push({ command, args });
      if (command === "bash") return { stdout: "/usr/bin/tool\n", stderr: "", exitCode: 0 };
      if (command === "gnome-screenshot") {
        fs.writeFileSync(args[1], PNG);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command !== "xdotool") return { stdout: "", stderr: "", exitCode: 1 };
      const [action] = args;
      if (action === "search") return { stdout: "101\n202\n", stderr: "", exitCode: 0 };
      if (action === "getwindowname") return { stdout: `Window ${args[1]}\n`, stderr: "", exitCode: 0 };
      if (action === "getwindowpid") return { stdout: `${args[1] === "101" ? 501 : 502}\n`, stderr: "", exitCode: 0 };
      if (action === "getwindowgeometry") {
        return { stdout: "WINDOW=101\nX=10\nY=20\nWIDTH=300\nHEIGHT=150\nSCREEN=0\n", stderr: "", exitCode: 0 };
      }
      if (action === "getdisplaygeometry") return { stdout: "1920 1080\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    }),
  };
  return runner;
}

describe("Linux xdotool computer provider", () => {
  it("reports unavailable outside Linux", async () => {
    const provider = createLinuxXdotoolProvider({ platform: "win32", runner: createRunner() });

    await expect(provider.getStatus()).resolves.toMatchObject({
      providerId: "linux:xdotool",
      available: false,
      reason: "unsupported-platform",
    });
  });

  it("lists visible windows as controllable apps", async () => {
    const provider = createLinuxXdotoolProvider({
      platform: "linux",
      env: { DISPLAY: ":0" },
      runner: createRunner(),
    });

    const apps = await provider.listApps();

    expect(apps).toHaveLength(2);
    expect(apps[0]).toMatchObject({
      appId: "window:101",
      name: "Window 101",
      pid: 501,
      windows: [{ windowId: "101" }],
    });
  });

  it("creates leases, captures screenshots, and performs foreground actions", async () => {
    const runner = createRunner();
    const provider = createLinuxXdotoolProvider({
      platform: "linux",
      env: { DISPLAY: ":0" },
      runner,
    });

    const lease = await provider.createLease({}, { windowId: "101" });
    const snapshot = await provider.getAppState({}, { ...lease, leaseId: "lease-1" });
    await provider.performAction({}, { ...lease, leaseId: "lease-1" }, {
      type: "click_element",
      snapshotElement: snapshot.elements.find((element) => element.elementId === "grid:middle-center"),
    });
    await provider.performAction({}, { ...lease, leaseId: "lease-1" }, {
      type: "type_text",
      text: "hello",
    });

    expect(lease).toMatchObject({
      appId: "window:101",
      windowId: "101",
      allowedActions: expect.arrayContaining(["click_element", "type_text", "press_key"]),
    });
    expect(snapshot.screenshot.data).toBe(PNG.toString("base64"));
    expect(snapshot.elements.some((element) => element.elementId === "grid:middle-center")).toBe(true);
    expect(runner.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "xdotool", args: expect.arrayContaining(["mousemove", "--sync"]) }),
      expect.objectContaining({ command: "xdotool", args: expect.arrayContaining(["windowactivate", "--sync", "101"]) }),
      expect.objectContaining({ command: "xdotool", args: expect.arrayContaining(["type", "--clearmodifiers"]) }),
    ]));
  });
});
