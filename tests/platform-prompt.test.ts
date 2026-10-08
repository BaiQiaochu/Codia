import { describe, expect, it } from "vitest";
import { getPlatformPromptNote } from "../core/platform-prompt.js";
import { SANDBOX_MODE_LABEL } from "../lib/sandbox/policy.js";

const baseOpts = { osType: "TestOS", osRelease: "1.2.3" };

describe("getPlatformPromptNote", () => {
  it("emits a structured environment context on darwin", () => {
    const out = getPlatformPromptNote({
      ...baseOpts,
      platform: "darwin",
      cwd: "/workspace/project-gsap",
      env: { SHELL: "/bin/zsh" },
    });
    expect(out).toContain("<environment_context>");
    expect(out).toContain("<platform>darwin</platform>");
    expect(out).toContain("<cwd>/workspace/project-gsap</cwd>");
    expect(out).toContain("<shell>zsh</shell>");
    expect(out).toContain("<os>TestOS 1.2.3</os>");
    expect(out).toContain(`<sandbox_mode>${SANDBOX_MODE_LABEL}</sandbox_mode>`);
    expect(out).toContain("Use structured file tools for source edits.");
    expect(out).toContain("</environment_context>");
  });

  it("falls back to bash in the Linux environment context", () => {
    const out = getPlatformPromptNote({
      ...baseOpts,
      platform: "linux",
      cwd: "/workspace/project-gsap",
      env: {},
    });
    expect(out).toContain("<platform>linux</platform>");
    expect(out).toContain("<shell>bash</shell>");
    expect(out).toContain("<cwd>/workspace/project-gsap</cwd>");
  });

  it("emits PowerShell as the Windows native shell", () => {
    const out = getPlatformPromptNote({ ...baseOpts, platform: "win32", cwd: "C:\\work" });
    expect(out).toContain("<platform>win32</platform>");
    expect(out).toContain("<cwd>C:\\work</cwd>");
    expect(out).toContain("<shell>powershell</shell>");
    expect(out).toContain(`<sandbox_mode>${SANDBOX_MODE_LABEL}</sandbox_mode>`);
    expect(out).not.toContain("Shell: bash");
    expect(out).not.toContain("Prefer POSIX syntax");
  });

  it("uses the basename of the POSIX user shell", () => {
    const out = getPlatformPromptNote({
      ...baseOpts,
      platform: "darwin",
      env: { SHELL: "/opt/homebrew/bin/fish" },
    });
    expect(out).toContain("<shell>fish</shell>");
  });
});
