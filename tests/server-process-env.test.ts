import { describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const {
  buildWin32ServerEnv,
  normalizeWin32ProcessEnv,
  readWin32RegistryPathEntries,
} = require("../desktop/src/shared/server-process-env.cjs");

describe("Windows server process environment", () => {
  it("canonicalizes duplicate PATH keys and keeps package runner lookup paths", () => {
    const env = normalizeWin32ProcessEnv({
      Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
      PATH: "C:\\stale\\bin",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    }, {
      prependPathEntries: ["C:\\Codia\\resources\\git\\cmd"],
      appendPathEntries: ["C:\\Users\\codia\\AppData\\Roaming\\npm", "c:\\program files\\nodejs"],
    });

    expect(env).not.toHaveProperty("Path");
    expect(env.PATH.split(";")).toEqual([
      "C:\\Codia\\resources\\git\\cmd",
      "C:\\Windows\\System32",
      "C:\\Program Files\\nodejs",
      "C:\\stale\\bin",
      "C:\\Users\\codia\\AppData\\Roaming\\npm",
    ]);
    expect(env.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
    expect(env.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("reads machine and user PATH values from the Windows registry", async () => {
    const execFile = vi.fn((file, args, options, callback) => {
      const key = args[1];
      if (key.startsWith("HKLM\\")) {
        callback(null, "    Path    REG_EXPAND_SZ    %SystemRoot%\\System32;C:\\Program Files\\nodejs\r\n", "");
        return;
      }
      if (key.startsWith("HKCU\\")) {
        callback(null, "    Path    REG_SZ    %USERPROFILE%\\AppData\\Roaming\\npm\r\n", "");
        return;
      }
      callback(new Error("unexpected key"), "", "");
    });

    await expect(readWin32RegistryPathEntries({
      execFile,
      env: {
        SystemRoot: "C:\\Windows",
        USERPROFILE: "C:\\Users\\codia",
      },
    })).resolves.toEqual([
      "C:\\Windows\\System32",
      "C:\\Program Files\\nodejs",
      "C:\\Users\\codia\\AppData\\Roaming\\npm",
    ]);
    expect(execFile.mock.calls[0][0]).toBe("C:\\Windows\\System32\\reg.exe");
  });

  it("merges registry PATH entries into the server environment without duplicate path keys", async () => {
    const env = await buildWin32ServerEnv({
      Path: "C:\\Windows\\System32",
    }, {
      prependPathEntries: ["C:\\Codia\\resources\\git\\cmd"],
      readRegistryPathEntries: async () => ["C:\\Program Files\\nodejs"],
    });

    expect(env).toEqual({
      PATH: "C:\\Codia\\resources\\git\\cmd;C:\\Windows\\System32;C:\\Program Files\\nodejs",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });
  });
});
