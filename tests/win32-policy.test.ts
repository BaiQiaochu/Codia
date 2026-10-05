// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveSandboxPolicy } from "../lib/sandbox/policy.js";
import {
  buildWin32SandboxGrants,
  externalReadPathsFromSessionFiles,
} from "../lib/sandbox/win32-policy.js";

const tmpDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-win32-policy-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("win32 sandbox policy grants", () => {
  it("turns explicit external session files into read grants", () => {
    const root = makeTempDir();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const external = path.join(root, "external", "doc.md");
    fs.mkdirSync(path.dirname(external), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(external, "doc");

    expect(externalReadPathsFromSessionFiles([
      { realPath: external, storageKind: "external", status: "available" },
      { realPath: path.join(workspace, "inside.md"), storageKind: "external", status: "available" },
      { realPath: path.join(home, "user", "profile.md"), storageKind: "external", status: "available" },
      { realPath: path.join(root, "expired.md"), storageKind: "external", status: "expired" },
    ], { workspaceRoots: [workspace], gsapHome: home })).toEqual([fs.realpathSync(external)]);
  });

  it("projects restricted-token write roots without external read grants", () => {
    const root = makeTempDir();
    const home = path.join(root, "home");
    const agent = path.join(home, "agents", "main");
    const cwd = path.join(root, "workspace");
    const external = path.join(root, "external.txt");
    for (const dir of [home, agent, cwd, path.join(agent, "memory"), path.join(cwd, ".git")]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(external, "external");

    const policy = deriveSandboxPolicy({ agentDir: agent, workspace: cwd, gsapHome: home, mode: "standard" });
    const grants = buildWin32SandboxGrants({ policy, cwd, externalReadPaths: [external], runtimeReadPaths: ["C:\\runtime\\git"] });

    expect(grants.writePaths).toContain(fs.realpathSync(cwd));
    expect(grants.readPaths).toEqual([]);
    expect(grants.optionalReadPaths).toEqual([]);
    expect(grants.denyReadPaths).toEqual([]);
    expect(grants.optionalWritePaths).toContain(fs.realpathSync(path.join(agent, "memory")));
    expect(grants.denyWritePaths).not.toContain(fs.realpathSync(path.join(cwd, ".git")));
  });
});
