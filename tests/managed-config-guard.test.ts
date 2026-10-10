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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-managed-config-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("managed agent config guard", () => {
  it("recognizes direct agent config files under the Codia home", () => {
    const codiaHome = makeTempHome();
    const configPath = path.join(codiaHome, "agents", "worker-a", "config.yaml");

    expect(isManagedAgentConfigPath(configPath, { codiaHome })).toBe(true);
    expect(isManagedAgentConfigPath(path.join(codiaHome, "agents", "worker-a", "memory.yaml"), { codiaHome })).toBe(false);
    expect(isManagedAgentConfigPath(path.join(codiaHome, "agents", "worker-a", "nested", "config.yaml"), { codiaHome })).toBe(false);
  });

  it("blocks writes and deletes while allowing reads and unrelated files", () => {
    const codiaHome = makeTempHome();
    const guard = createManagedConfigWriteGuard({ codiaHome });
    const configPath = path.join(codiaHome, "agents", "worker-a", "config.yaml");
    const prefsPath = path.join(codiaHome, "prefs.json");

    expect(guard(configPath, "read").allowed).toBe(true);
    expect(guard(configPath, "write").allowed).toBe(false);
    expect(guard(configPath, "delete").allowed).toBe(false);
    expect(guard(prefsPath, "write").allowed).toBe(true);
  });
});
