import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function runAudit(root: string) {
  const output = execFileSync(
    process.execPath,
    ["scripts/session-path-identity-audit.mjs", root, "--json"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return JSON.parse(output);
}

function runAuditProcess(root: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    ["scripts/session-path-identity-audit.mjs", root, ...args],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

describe("session path identity audit", () => {
  it("flags path-keyed storage but allows identity adapter lookups", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-session-audit-"));
    fs.writeFileSync(path.join(dir, "path-cache.ts"), `
      const sessionCache = new Map();
      sessionCache.set(sessionPath, value);
    `);
    fs.writeFileSync(path.join(dir, "adapter.ts"), `
      const key = sessionScopedKey(state, sessionPath);
      const value = sessionScopedValue(state, valuesBySession, sessionPath);
    `);

    const report = runAudit(dir);
    const risks = report.identityRisk.map((item: { file: string }) => path.basename(item.file));

    expect(risks).toContain("path-cache.ts");
    expect(risks).not.toContain("adapter.ts");
  });

  it("does not treat focus locators as path-keyed identity storage", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-session-audit-focus-"));
    fs.writeFileSync(path.join(dir, "focus.ts"), `
      get currentSessionPath() { return this._sessionCoord.currentSessionPath; }
      this._emitEvent(event, this.currentSessionPath);
    `);

    const report = runAudit(dir);

    expect(report.identityRisk).toEqual([]);
    expect(report.counts["focus-or-transport-locator"]).toBe(2);
  });

  it("fail-on-risk ignores approved identity boundaries but fails on true risks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-session-audit-fail-gate-"));
    const sessionDir = path.join(dir, "desktop", "src", "react", "stores");
    const appDir = path.join(dir, "core");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "session-slice.ts"), `
      const key = sessionScopedKey(state, sessionPath);
      if (key !== sessionPath) delete next[sessionPath];
    `);

    expect(runAuditProcess(dir, "--fail-on-risk").status).toBe(0);

    fs.writeFileSync(path.join(appDir, "real-risk.ts"), `
      const sessionCache = new Map();
      sessionCache.set(sessionPath, value);
    `);

    expect(runAuditProcess(dir, "--fail-on-risk").status).toBe(1);
  });
});
