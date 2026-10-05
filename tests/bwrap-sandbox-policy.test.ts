// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBwrapArgs } from "../lib/sandbox/bwrap.js";

function hasMount(args, op, source, target) {
  for (let i = 0; i < args.length - 2; i += 1) {
    if (args[i] === op && args[i + 1] === source && args[i + 2] === target) return true;
  }
  return false;
}

describe("Linux bwrap sandbox policy projection", () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-bwrap-policy-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("uses a read-all root mount while keeping writes scoped to explicit roots", () => {
    const workspace = path.join(tempRoot, "workspace");
    const agentSessions = path.join(tempRoot, "gsap", "agents", "gsap", "sessions");
    const sessionFiles = path.join(tempRoot, "gsap", "session-files");
    const externalFile = path.join(tempRoot, "outside.md");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(agentSessions, { recursive: true });
    fs.mkdirSync(sessionFiles, { recursive: true });
    fs.writeFileSync(externalFile, "outside");

    const args = buildBwrapArgs({
      mode: "standard",
      writablePaths: [workspace, agentSessions],
      readablePaths: [sessionFiles],
      protectedPaths: [path.join(workspace, ".git"), sessionFiles],
      denyReadPaths: [],
    }, {
      env: { HOME: path.join(tempRoot, "home") },
      externalReadPaths: [externalFile],
    });

    expect(hasMount(args, "--ro-bind", "/", "/")).toBe(true);
    expect(args).not.toContain("--unshare-net");
    expect(hasMount(args, "--bind", workspace, workspace)).toBe(true);
    expect(hasMount(args, "--bind", agentSessions, agentSessions)).toBe(true);
    expect(hasMount(args, "--ro-bind", sessionFiles, sessionFiles)).toBe(true);
    expect(hasMount(args, "--ro-bind", externalFile, externalFile)).toBe(true);
  });

  it("keeps network enabled by default and isolates it only when explicitly disabled", () => {
    const policy = {
      mode: "standard",
      writablePaths: [],
      readablePaths: [],
      protectedPaths: [],
      denyReadPaths: [],
    };

    expect(buildBwrapArgs(policy)).not.toContain("--unshare-net");
    expect(buildBwrapArgs(policy, { allowNetwork: true })).not.toContain("--unshare-net");
    expect(buildBwrapArgs(policy, { allowNetwork: false })).toContain("--unshare-net");
  });
});
