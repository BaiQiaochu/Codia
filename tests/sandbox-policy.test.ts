import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveSandboxPolicy } from "../lib/sandbox/policy.js";
import { AccessLevel, PathGuard } from "../lib/sandbox/path-guard.js";

describe("sandbox workspace roots", () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-sandbox-roots-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("grants full access to explicit extra workspace folders and read-only access to ordinary external paths", () => {
    const agentDir = path.join(tempRoot, "agents", "main");
    const gsapHome = path.join(tempRoot, "home");
    const primary = path.join(tempRoot, "project");
    const extra = path.join(tempRoot, "reference");
    const sibling = path.join(tempRoot, "private");
    for (const dir of [agentDir, gsapHome, primary, extra, sibling]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const policy = deriveSandboxPolicy({
      agentDir,
      gsapHome,
      workspace: primary,
      workspaceFolders: [extra],
      mode: "standard",
    });
    const guard = new PathGuard(policy);

    expect(policy.writablePaths).toContain(path.resolve(primary));
    expect(policy.writablePaths).toContain(path.resolve(extra));
    expect(policy.protectedPaths).toContain(path.join(path.resolve(primary), ".git"));
    expect(policy.protectedPaths).toContain(path.join(path.resolve(extra), ".git"));
    expect(guard.getAccessLevel(path.join(extra, "note.md"))).toBe(AccessLevel.FULL);
    expect(guard.getAccessLevel(path.join(sibling, "secret.md"))).toBe(AccessLevel.READ_ONLY);
    expect(guard.check(path.join(sibling, "secret.md"), "read").allowed).toBe(true);
    expect(guard.check(path.join(sibling, "secret.md"), "write").allowed).toBe(false);
    expect(guard.check(path.join(sibling, "secret.md"), "delete").allowed).toBe(false);
  });

  it("treats cwd and runtime roots as scoped write roots", () => {
    const agentDir = path.join(tempRoot, "agents", "main");
    const gsapHome = path.join(tempRoot, "home");
    const workspace = path.join(tempRoot, "project");
    const cwd = path.join(tempRoot, "scratch");
    const runtimeRoot = path.join(tempRoot, "runtime-cache");
    for (const dir of [agentDir, gsapHome, workspace, cwd, runtimeRoot]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const policy = deriveSandboxPolicy({
      agentDir,
      gsapHome,
      workspace,
      workspaceFolders: [],
      cwd,
      runtimeWritablePaths: [runtimeRoot],
      mode: "standard",
    });
    const guard = new PathGuard(policy);

    expect(policy.access).toEqual({
      read: "all",
      write: "scoped",
      network: "on",
    });
    expect(policy.workspaceRoots).toContain(path.resolve(cwd));
    expect(policy.writablePaths).toContain(path.resolve(cwd));
    expect(policy.writablePaths).toContain(path.resolve(runtimeRoot));
    expect(guard.check(path.join(cwd, "generated.py"), "write").allowed).toBe(true);
    expect(guard.check(path.join(runtimeRoot, "tool-cache.tmp"), "write").allowed).toBe(true);
  });

  it("grants scoped writes to user-authorized session folders", () => {
    const agentDir = path.join(tempRoot, "agents", "main");
    const gsapHome = path.join(tempRoot, "home");
    const workspace = path.join(tempRoot, "project");
    const authorized = path.join(tempRoot, "shared-assets");
    for (const dir of [agentDir, gsapHome, workspace, authorized]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const policy = deriveSandboxPolicy({
      agentDir,
      gsapHome,
      workspace,
      authorizedFolders: [authorized],
      mode: "standard",
    });
    const guard = new PathGuard(policy);

    expect(policy.workspaceRoots).toContain(path.resolve(authorized));
    expect(policy.writablePaths).toContain(path.resolve(authorized));
    expect(policy.protectedPaths).toContain(path.join(path.resolve(authorized), ".git"));
    expect(guard.check(path.join(authorized, "draft.md"), "write").allowed).toBe(true);
  });
});
