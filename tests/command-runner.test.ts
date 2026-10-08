// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { createCommandRunner } from "../lib/shell/command-runner.js";

describe("createCommandRunner", () => {
  it("invokes the selected shell profile with executable and argv", async () => {
    const spawnCommand = vi.fn(async () => ({ exitCode: 0 }));
    const run = createCommandRunner({
      platform: "win32",
      spawnCommand,
      resolveProfile: () => ({
        id: "windows-powershell",
        family: "powershell",
        executable: "powershell.exe",
        env: { Path: "C:\\Windows\\System32" },
        argsForCommand: (command) => ["-Command", command],
      }),
    });

    await run("Write-Output ok", "C:\\work", {
      env: { PATH: "C:\\Windows\\System32" },
      timeout: 1000,
    });

    expect(spawnCommand).toHaveBeenCalledWith(expect.objectContaining({
      executable: "powershell.exe",
      args: ["-Command", "Write-Output ok"],
      cwd: "C:\\work",
      env: { Path: "C:\\Windows\\System32" },
      timeout: 1000,
      profile: expect.objectContaining({ family: "powershell" }),
    }));
  });
});
