import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const root = process.cwd();

describe("Linux packaging contract", () => {
  it("defines Ubuntu-friendly deb and AppImage packaging targets", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

    expect(pkg.scripts["dist:linux"]).toContain("electron-builder --linux deb AppImage");
    expect(pkg.build.linux.target).toEqual(["deb", "AppImage"]);
    expect(pkg.build.linux.icon).toBe("desktop/src/icon.png");
    expect(pkg.build.linux.artifactName).toContain("Linux");
    expect(pkg.build.deb.depends).toContain("libgtk-3-0");
    expect(pkg.build.deb.depends).toContain("libatspi2.0-0");
    expect(pkg.build.deb.depends).toContain("xdotool");
    expect(pkg.build.deb.depends).toContain("gnome-screenshot");
    expect(fs.existsSync(path.join(root, pkg.build.linux.icon))).toBe(true);
  });
});
