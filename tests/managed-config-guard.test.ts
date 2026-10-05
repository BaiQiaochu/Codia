import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createManagedConfigWriteGuard,
  isManagedAgentConfigPath,
} from "../lib/sandbox/managed-config-guard.js";

const tempRoots = [];

function makeTempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-managed-config-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("managed agent config guard", () => {
  it("recognizes direct agent config files under the G-SAP home", () => {
    const gsapHome = makeTempHome();
    const configPath = path.join(gsapHome, "agents", "worker-a", "config.yaml");

    expect(isManagedAgentConfigPath(configPath, { gsapHome })).toBe(true);
    expect(isManagedAgentConfigPath(path.join(gsapHome, "agents", "worker-a", "memory.yaml"), { gsapHome })).toBe(false);
    expect(isManagedAgentConfigPath(path.join(gsapHome, "agents", "worker-a", "nested", "config.yaml"), { gsapHome })).toBe(false);
  });

  it("blocks writes and deletes while allowing reads and unrelated files", () => {
    const gsapHome = makeTempHome();
    const guard = createManagedConfigWriteGuard({ gsapHome });
    const configPath = path.join(gsapHome, "agents", "worker-a", "config.yaml");
    const prefsPath = path.join(gsapHome, "prefs.json");

    expect(guard(configPath, "read").allowed).toBe(true);
    expect(guard(configPath, "write").allowed).toBe(false);
    expect(guard(configPath, "delete").allowed).toBe(false);
    expect(guard(prefsPath, "write").allowed).toBe(true);
  });
});
