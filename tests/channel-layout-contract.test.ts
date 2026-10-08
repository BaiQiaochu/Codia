import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const cssPath = path.join(root, "desktop", "src", "styles.css");
const channelCssPath = path.join(root, "desktop", "src", "react", "components", "channels", "Channels.module.css");

function readStyles() {
  return fs.readFileSync(cssPath, "utf8");
}

function readChannelStyles() {
  return fs.readFileSync(channelCssPath, "utf8");
}

function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\}`).exec(css);
  return match?.groups?.body || "";
}

describe("channel right sidebar layout contract", () => {
  it("renders the original-style channel inspector beside chat while preserving the workspace rail", () => {
    const css = readStyles();
    const page = ruleBody(css, ".channel-page");
    const inspector = ruleBody(css, ".channel-inspector-rail");

    expect(css).toContain("--channel-inspector-width");
    expect(page).toMatch(/display:\s*flex/);
    expect(page).toMatch(/min-width:\s*0/);
    expect(page).toMatch(/overflow:\s*hidden/);
    expect(inspector).toMatch(/width:\s*var\(--channel-inspector-width\)/);
    expect(inspector).toMatch(/flex:\s*0\s+0\s+var\(--channel-inspector-width\)/);
    expect(inspector).toMatch(/overflow:\s*hidden/);
  });

  it("keeps channel info cards scrollable instead of clipping tall group UI", () => {
    const css = readStyles();
    const stack = ruleBody(css, ".channel-info-stack");
    const card = ruleBody(css, ".channel-info-stack > .jian-card");

    expect(stack).toMatch(/overflow-y:\s*auto/);
    expect(stack).toMatch(/min-height:\s*0/);
    expect(card).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(card).toMatch(/overflow:\s*visible/);
  });

  it("keeps long channel member lists independently scrollable", () => {
    const css = readStyles();
    const channelCss = readChannelStyles();
    const legacyMembers = ruleBody(css, ".channel-members-list");
    const workspaceMembers = ruleBody(channelCss, ".channelWorkspaceMembers");
    const workspaceMemberRow = ruleBody(channelCss, ".channelWorkspaceMemberRow");

    expect(legacyMembers).toMatch(/max-height:\s*min\(/);
    expect(legacyMembers).toMatch(/overflow-y:\s*auto/);
    expect(workspaceMembers).toMatch(/max-height:\s*min\(/);
    expect(workspaceMembers).toMatch(/overflow-y:\s*auto/);
    expect(workspaceMemberRow).toMatch(/flex:\s*0\s+0\s+auto/);
  });
});
